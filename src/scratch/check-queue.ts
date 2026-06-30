import { Queue } from 'bullmq';
import { getRedisOptions } from '../db/redis';

async function check() {
  const queue = new Queue('whatsapp-message-queue', {
    connection: getRedisOptions() as any,
  });

  const failedJobs = await queue.getFailed();
  console.log(`Failed jobs count: ${failedJobs.length}`);
  for (const job of failedJobs.slice(-5)) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Failed reason: ${job.failedReason}`);
    console.log(`Stacktrace:`, job.stacktrace);
    console.log('-------------------');
  }

  const activeJobs = await queue.getActive();
  console.log(`Active jobs count: ${activeJobs.length}`);
  for (const job of activeJobs) {
    console.log(`Job ID: ${job.id}`);
  }

  const waitingJobs = await queue.getWaiting();
  console.log(`Waiting jobs count: ${waitingJobs.length}`);
  for (const job of waitingJobs) {
    console.log(`Job ID: ${job.id}`);
  }

  await queue.close();
}

check().catch(console.error);
