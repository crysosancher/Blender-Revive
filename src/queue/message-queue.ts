import { Queue, Worker } from 'bullmq';
import { createRedisConnection } from '../db/redis';
import { BufferJSON, proto } from '@whiskeysockets/baileys';
import { handleIncomingMessage } from '../commands';

// Singleton Queue instance
let messageQueue: Queue | null = null;
let messageWorker: Worker | null = null;

interface MessageJobData {
  messageStr: string;
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
 * Retrieves the count of waiting, active, delayed, and paused jobs in the queue.
 */
export async function getQueueCount(): Promise<number> {
  if (!messageQueue) return 0;
  try {
    const counts = await messageQueue.getJobCounts('wait', 'active', 'delayed', 'paused');
    return (counts.wait || 0) + (counts.active || 0) + (counts.delayed || 0) + (counts.paused || 0);
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
      const { messageStr } = job.data;
      const msg = JSON.parse(messageStr, BufferJSON.reviver) as proto.IWebMessageInfo;

      const sock = getSocket();
      if (!sock) {
        throw new Error('[Worker] Socket is not active or ready yet.');
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
