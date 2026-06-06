import Redis, { RedisOptions } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redisClient: Redis | null = null;

/**
 * Returns connection options for Redis, specifically configured for BullMQ.
 * Note: BullMQ requires `maxRetriesPerRequest` to be null.
 */
export function getRedisOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required for BullMQ compatibility
  };
}

/**
 * Creates and returns a new ioredis connection instance.
 * Useful for BullMQ Queue and Worker configurations where dedicated connections are required.
 */
export function createRedisConnection(): Redis {
  const options = getRedisOptions();
  const client = new Redis(options);

  client.on('error', (error) => {
    console.error('[Redis] Connection error:', error);
  });

  return client;
}

/**
 * Returns the singleton Redis client for caching and metadata operations.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = createRedisConnection();
    console.log('[Redis] Connected successfully (Singleton client initialized)');
  }
  return redisClient;
}

/**
 * Closes the singleton Redis client connection.
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.log('[Redis] Singleton client connection closed');
  }
}
