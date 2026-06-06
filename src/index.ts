import dotenv from 'dotenv';
import { connectToMongo, closeMongoConnection } from './db/mongodb';
import { getRedisClient, closeRedisConnection } from './db/redis';
import { setupQueue, setupWorker, closeQueueAndWorker } from './queue/message-queue';
import { startWhatsAppBot, getSocket } from './bot';

dotenv.config();

/**
 * Main application bootstrapper.
 * Establishes database connections, initializes queuing systems, starts the WhatsApp client,
 * and configures graceful shutdowns to prevent database and connection leaks.
 */
async function main() {
  try {
    console.log('[System] Starting high-performance WhatsApp bot system...');

    // 1. Initialize MongoDB Connection
    await connectToMongo();

    // 2. Initialize Redis Client
    getRedisClient();

    // 3. Initialize Message Queue (BullMQ)
    setupQueue();

    // 4. Start the WhatsApp connection
    await startWhatsAppBot();

    // 5. Start the BullMQ Worker to process incoming messages asynchronously
    // Pass a getter function to always retrieve the latest active socket instance
    setupWorker(getSocket, 5);

    console.log('[System] All systems operational. Waiting for messages...');

    // Graceful Shutdown
    const handleShutdown = async (signal: string) => {
      console.log(`\n[System] Received ${signal}. Initiating graceful shutdown...`);
      try {
        await closeQueueAndWorker();
        await closeRedisConnection();
        await closeMongoConnection();
        console.log('[System] Shutdown complete. Exit.');
        process.exit(0);
      } catch (err) {
        console.error('[System] Error during shutdown sequence:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  } catch (error) {
    console.error('[System] Bootstrap process failed critical error:', error);
    process.exit(1);
  }
}

main();
