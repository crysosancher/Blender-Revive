import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Connects to MongoDB and returns the database instance.
 */
export async function connectToMongo(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGO_URI || 'mongodb://root:rootpassword@localhost:27017/admin';
  const dbName = process.env.MONGO_DB_NAME || 'whatsapp_bot';

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    console.log(`[MongoDB] Connected successfully to database: ${dbName}`);
    return db;
  } catch (error) {
    console.error('[MongoDB] Connection failed:', error);
    throw error;
  }
}

/**
 * Returns the active database instance.
 */
export function getDb(): Db {
  if (!db) {
    throw new Error('Database has not been initialized. Call connectToMongo() first.');
  }
  return db;
}

/**
 * Returns the MongoClient instance.
 */
export function getMongoClient(): MongoClient {
  if (!client) {
    throw new Error('MongoClient has not been initialized. Call connectToMongo() first.');
  }
  return client;
}

/**
 * Closes the MongoDB connection.
 */
export async function closeMongoConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[MongoDB] Connection closed');
  }
}
