import { Db } from 'mongodb';
import { 
  AuthenticationState, 
  AuthenticationCreds, 
  SignalKeyStore, 
  initAuthCreds, 
  BufferJSON 
} from '@whiskeysockets/baileys';

interface CredsDocument {
  _id: string;
  value: string;
  updatedAt: Date;
}

interface KeyDocument {
  _id: string;
  sessionId: string;
  type: string;
  id: string;
  value: string;
  updatedAt: Date;
}

/**
 * Custom MongoDB-backed authentication state provider for Baileys.
 * Storing creds and keys in MongoDB collections.
 * Uses BufferJSON serializer to support binary Buffers correctly.
 */
export async function useMongoDBAuthState(
  db: Db,
  sessionId: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  
  const credsCollection = db.collection<CredsDocument>('creds');
  const keysCollection = db.collection<KeyDocument>('keys');

  // Create compound indexes to optimize lookups for the keys collection
  await keysCollection.createIndex({ sessionId: 1, type: 1, id: 1 }, { unique: true });

  // 1. Fetch or initialize credentials
  const credsDoc = await credsCollection.findOne({ _id: sessionId } as any);
  let creds: AuthenticationCreds;

  if (credsDoc) {
    creds = JSON.parse(credsDoc.value, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
    await credsCollection.updateOne(
      { _id: sessionId } as any,
      { $set: { value: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // 2. Define the saveCreds function
  const saveCreds = async () => {
    await credsCollection.updateOne(
      { _id: sessionId } as any,
      { $set: { value: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  };

  // 3. Define the key store implementation
  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      try {
        const results = await keysCollection
          .find({
            sessionId,
            type,
            id: { $in: ids },
          } as any)
          .toArray();

        const dict: { [id: string]: any } = {};
        for (const doc of results) {
          dict[doc.id] = JSON.parse(doc.value, BufferJSON.reviver);
        }
        return dict;
      } catch (error) {
        console.error(`[MongoAuth] Failed to get keys for type: ${type}`, error);
        return {};
      }
    },

    set: async (data: any) => {
      try {
        const bulkOps = [];
        
        for (const type in data) {
          for (const id in data[type]) {
            const value = data[type][id];
            const _id = `${sessionId}:${type}:${id}`;

            if (value === null) {
              // Delete the key if value is null
              bulkOps.push({
                deleteOne: {
                  filter: { _id } as any,
                },
              });
            } else {
              // Upsert the key
              const valueStr = JSON.stringify(value, BufferJSON.replacer);
              bulkOps.push({
                updateOne: {
                  filter: { _id } as any,
                  update: {
                    $set: {
                      sessionId,
                      type,
                      id,
                      value: valueStr,
                      updatedAt: new Date(),
                    },
                  },
                  upsert: true,
                },
              });
            }
          }
        }

        if (bulkOps.length > 0) {
          await keysCollection.bulkWrite(bulkOps as any, { ordered: false });
        }
      } catch (error) {
        console.error('[MongoAuth] Failed to write keys', error);
      }
    },
  };

  return {
    state: {
      creds,
      keys,
    },
    saveCreds,
  };
}
