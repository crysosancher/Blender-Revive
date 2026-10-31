import { Queue, Worker } from 'bullmq';
import { createRedisConnection } from '../db/redis';
import { BufferJSON, proto } from '@whiskeysockets/baileys';
import { handleIncomingMessage } from '../commands';
import { isSocketConnected } from '../bot';

// Singleton Queue instance
let messageQueue: Queue | null = null;
let messageWorker: Worker | null = null;

interface MessageJobData {
  messageStr?: string;
}

/**
 * Initializes the BullMQ message queue for processing incoming WhatsApp messages.
 */
export function setupQueue(): Queue {
  if (messageQueue) return messageQueue;

  messageQueue = new Queue<MessageJobData>('whatsapp-message-queue', {
    connection: createRedisConnection() as any, // Cast as any to avoid nested ioredis typing conflict
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: true, // Clean up to avoid Redis memory bloat
      removeOnFail: 100,      // Keep last 100 failures for debugging
    },
  });

  // Clean up and schedule repeatable jobs
  messageQueue.getRepeatableJobs().then(async (jobs) => {
    // Remove old repeatable jobs to prevent duplicates or stale cron schedules
    const repeatableJobNames = [
      'group-analytics-cron',
      'company-verification-cron',
      'weekly-leaderboard-cron',
      'monthly-leaderboard-cron',
      'yearly-leaderboard-cron',
    ];
    for (const job of jobs) {
      if (repeatableJobNames.includes(job.name)) {
        await messageQueue?.removeRepeatableByKey(job.key);
        console.log(`[Queue] Removed old repeatable job: ${job.name} (${job.pattern})`);
      }
    }

    // Schedule repeatable company verification cron job (runs twice a day: at midnight and noon)
    await messageQueue?.add(
      'company-verification-cron',
      {},
      {
        repeat: { pattern: '0 0,12 * * *' },
        jobId: 'company-verification-cron-job',
      }
    );
    console.log('[Queue] Repeatable company verification cron job successfully scheduled');

    // Schedule repeatable group analytics cron job (runs daily at 11:00 PM IST)
    await messageQueue?.add(
      'group-analytics-cron',
      {},
      {
        repeat: { pattern: '0 23 * * *', tz: 'Asia/Kolkata' },
        jobId: 'group-analytics-cron-job',
      }
    );
    console.log('[Queue] Repeatable group analytics cron job successfully scheduled (Every day at 11:00 PM IST)');

    // Schedule repeatable weekly leaderboard (every Sunday at 11:00 PM IST)
    await messageQueue?.add(
      'weekly-leaderboard-cron',
      {},
      {
        repeat: { pattern: '0 23 * * 0', tz: 'Asia/Kolkata' },
        jobId: 'weekly-leaderboard-cron-job',
      }
    );
    console.log('[Queue] Repeatable weekly leaderboard cron job scheduled (Sundays at 11:00 PM IST)');

    // Schedule repeatable monthly leaderboard (fires on 28-31; the worker only posts on the last day)
    await messageQueue?.add(
      'monthly-leaderboard-cron',
      {},
      {
        repeat: { pattern: '0 23 28-31 * *', tz: 'Asia/Kolkata' },
        jobId: 'monthly-leaderboard-cron-job',
      }
    );
    console.log('[Queue] Repeatable monthly leaderboard cron job scheduled (last day of month, 11:00 PM IST)');

    // Schedule repeatable yearly leaderboard (Dec 31 at 11:00 PM IST)
    await messageQueue?.add(
      'yearly-leaderboard-cron',
      {},
      {
        repeat: { pattern: '0 23 31 12 *', tz: 'Asia/Kolkata' },
        jobId: 'yearly-leaderboard-cron-job',
      }
    );
    console.log('[Queue] Repeatable yearly leaderboard cron job scheduled (Dec 31, 11:00 PM IST)');
  }).catch((err) => {
    console.error('[Queue] Failed to setup repeatable cron jobs:', err);
  });

  console.log('[Queue] Message queue successfully initialized');
  return messageQueue;
}

/**
 * Enqueues an incoming WhatsApp message for asynchronous processing.
 */
export async function queueMessage(msg: proto.IWebMessageInfo): Promise<void> {
  if (!messageQueue) {
    throw new Error('Queue not initialized. Call setupQueue() first.');
  }

  // Serialize the message using BufferJSON to preserve Buffer objects (keys, media parameters etc)
  const messageStr = JSON.stringify(msg, BufferJSON.replacer);
  
  // Format jobId to avoid colons, which are restricted in BullMQ
  const formattedJobId = `${msg.key.remoteJid}_${msg.key.id}`.replace(/:/g, '_');

  await messageQueue.add(
    'process-message',
    { messageStr },
    {
      jobId: formattedJobId,
    }
  );
}

/**
 * Retrieves the count of waiting and active jobs in the queue (excluding delayed/repeatable cron jobs).
 */
export async function getQueueCount(): Promise<number> {
  if (!messageQueue) return 0;
  try {
    const counts = await messageQueue.getJobCounts('wait', 'active');
    return (counts.wait || 0) + (counts.active || 0);
  } catch (err) {
    console.error('[Queue] Failed to get job counts:', err);
    return 0;
  }
}

/**
 * Starts the BullMQ Worker to process queued messages.
 * Concurrency controls how many messages are processed in parallel.
 * Accepts a getSocket getter function to always retrieve the active connection socket.
 */
export function setupWorker(getSocket: () => any, concurrency: number = 5): Worker {
  if (messageWorker) return messageWorker;

  messageWorker = new Worker<MessageJobData>(
    'whatsapp-message-queue',
    async (job) => {
      // Handle repeatable company verification cron job
      if (job.name === 'company-verification-cron') {
        console.log('[Worker] Starting cron task: Company Verification & Normalization...');
        try {
          const { runDatabaseCompanyNormalization } = await import('../services/company-verifier');
          const { checked, updatedReferrals } = await runDatabaseCompanyNormalization();
          console.log(`[Worker] Cron task complete: checked ${checked} companies, updated ${updatedReferrals} referrals.`);
        } catch (err) {
          console.error('[Worker] Cron task failed:', err);
          throw err;
        }
        return;
      }

      // Handle repeatable group analytics cron job
      if (job.name === 'group-analytics-cron') {
        // On weekly/monthly/yearly leaderboard days we skip the daily summary so the
        // group receives only the (more comprehensive) periodic leaderboard post.
        const { getPeriodicLeaderboardType } = await import('../services/leaderboard');
        const periodicType = getPeriodicLeaderboardType(new Date());
        if (periodicType) {
          console.log(`[Worker] Skipping daily analytics — today is a ${periodicType} leaderboard day.`);
          return;
        }

        console.log('[Worker] Starting cron task: Group Analytics & Reports...');
        const sock = getSocket();
        if (!sock || !isSocketConnected()) {
          throw new Error('[Worker] Socket is not connected. Skipping group analytics cron run.');
        }

        try {
          const { getDb } = await import('../db/mongodb');
          const { runGroupAnalytics } = await import('../services/gemini-analytics');

          const db = getDb();
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

          // Find group IDs that have messages in the last 24 hours
          const activeGroups = await db.collection('group_messages').aggregate([
            { $match: { timestamp: { $gte: oneDayAgo } } },
            { $group: { _id: '$groupId', count: { $sum: 1 } } }
          ]).toArray();

          console.log(`[Worker] Found ${activeGroups.length} groups with messages in the last 24h.`);

          for (const grp of activeGroups) {
            await runGroupAnalytics(sock, grp._id);
          }
          console.log('[Worker] Cron task complete: Group Analytics.');
        } catch (err) {
          console.error('[Worker] Group analytics cron task failed:', err);
          throw err;
        }
        return;
      }

      // Handle repeatable periodic leaderboard cron jobs (weekly/monthly/yearly)
      if (
        job.name === 'weekly-leaderboard-cron' ||
        job.name === 'monthly-leaderboard-cron' ||
        job.name === 'yearly-leaderboard-cron'
      ) {
        const { getPeriodicLeaderboardType, runAllPeriodicLeaderboards } = await import('../services/leaderboard');

        const jobToPeriod: Record<string, 'week' | 'month' | 'year'> = {
          'weekly-leaderboard-cron': 'week',
          'monthly-leaderboard-cron': 'month',
          'yearly-leaderboard-cron': 'year',
        };
        const requestedPeriod = jobToPeriod[job.name];
        const periodicType = getPeriodicLeaderboardType(new Date());

        // Collision guard: only the most comprehensive periodic job for today runs,
        // so e.g. Dec 31 (year + month + maybe Sunday) never posts three times.
        if (periodicType !== requestedPeriod) {
          console.log(`[Worker] Skipping ${requestedPeriod} leaderboard — today resolves to '${periodicType || 'none'}'.`);
          return;
        }

        const leaderboardSock = getSocket();
        if (!leaderboardSock || !isSocketConnected()) {
          throw new Error(`[Worker] Socket is not connected. Skipping ${requestedPeriod} leaderboard cron run.`);
        }

        console.log(`[Worker] Starting cron task: ${requestedPeriod} leaderboard...`);
        try {
          await runAllPeriodicLeaderboards(leaderboardSock, requestedPeriod);
          console.log(`[Worker] Cron task complete: ${requestedPeriod} leaderboard.`);
        } catch (err) {
          console.error(`[Worker] ${requestedPeriod} leaderboard cron task failed:`, err);
          throw err;
        }
        return;
      }

      const { messageStr } = job.data;
      if (!messageStr) {
        throw new Error('[Worker] Message job data messageStr is missing.');
      }
      const msg = JSON.parse(messageStr, BufferJSON.reviver) as proto.IWebMessageInfo;

      const sock = getSocket();
      if (!sock || !isSocketConnected()) {
        throw new Error('[Worker] Socket is not connected. Will retry via backoff.');
      }

      try {
        await handleIncomingMessage(sock, msg);
      } catch (error) {
        console.error(`[Worker] Error processing job ${job.id}:`, error);
        throw error; // Re-throw to trigger BullMQ retry backoff
      }
    },
    {
      connection: createRedisConnection() as any, // Cast as any to avoid nested ioredis typing conflict
      concurrency, // Process multiple messages concurrently to handle high group traffic
    }
  );

  messageWorker.on('completed', (job) => {
    // Silent on success to keep logs clean, can enable for debugging
  });

  messageWorker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed with error:`, err.message);
  });

  console.log(`[Worker] Message worker started with concurrency: ${concurrency}`);
  return messageWorker;
}

/**
 * Gracefully shuts down the queue and worker.
 */
export async function closeQueueAndWorker(): Promise<void> {
  if (messageQueue) {
    await messageQueue.close();
    messageQueue = null;
  }
  if (messageWorker) {
    await messageWorker.close();
    messageWorker = null;
  }
  console.log('[Queue/Worker] Disconnected from Redis');
}
