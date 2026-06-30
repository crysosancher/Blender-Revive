/**
 * Diagnostic script to check:
 * 1. Whether tctoken entries exist in MongoDB auth store
 * 2. The contact's LID mapping
 */
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGO_DB_NAME || 'whatsapp_bot';
  const sessionId = process.env.SESSION_ID || 'blender-revive-session';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const keysCollection = db.collection('keys');

  // 1. Check for tctoken entries
  const tctokenCount = await keysCollection.countDocuments({ sessionId, type: 'tctoken' });
  console.log(`\n--- tctoken entries in keys collection: ${tctokenCount} ---`);

  if (tctokenCount > 0) {
    const tctokens = await keysCollection.find({ sessionId, type: 'tctoken' }).limit(10).toArray();
    for (const t of tctokens) {
      const parsed = JSON.parse(t.value);
      console.log(`  id: ${t.id}, has token: ${!!parsed?.token}, timestamp: ${parsed?.timestamp}, senderTimestamp: ${parsed?.senderTimestamp}`);
    }
  }

  // 2. Check for lid-mapping entries
  const lidMappingCount = await keysCollection.countDocuments({ sessionId, type: 'lid-mapping' });
  console.log(`\n--- lid-mapping entries: ${lidMappingCount} ---`);
  if (lidMappingCount > 0) {
    const lidMappings = await keysCollection.find({ sessionId, type: 'lid-mapping' }).limit(5).toArray();
    for (const m of lidMappings) {
      console.log(`  id: ${m.id}, value: ${m.value.substring(0, 200)}`);
    }
  }

  // 3. Check for the specific contact's LID
  const contactLid = '148885141995551@lid';
  const contactToken = await keysCollection.findOne({ sessionId, type: 'tctoken', id: contactLid });
  console.log(`\n--- tctoken for ${contactLid}: ${contactToken ? 'FOUND' : 'NOT FOUND'} ---`);
  if (contactToken) {
    const parsed = JSON.parse(contactToken.value);
    console.log(`  Has token: ${!!parsed?.token}, timestamp: ${parsed?.timestamp}, senderTimestamp: ${parsed?.senderTimestamp}`);
  }

  // 4. Check lid_phone_map for the contact
  const lidPhoneMap = db.collection('lid_phone_map');
  const contactMapping = await lidPhoneMap.findOne({ lid: contactLid });
  console.log(`\n--- lid_phone_map for ${contactLid}: ${contactMapping ? 'FOUND -> ' + contactMapping.phoneJid : 'NOT FOUND'} ---`);

  // 5. Count all key types  
  const typeCounts = await keysCollection.aggregate([
    { $match: { sessionId } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  console.log(`\n--- Key type counts for session ${sessionId} ---`);
  for (const tc of typeCounts) {
    console.log(`  ${tc._id}: ${tc.count}`);
  }

  // 6. Check device-list entries
  const deviceListCount = await keysCollection.countDocuments({ sessionId, type: 'device-list' });
  console.log(`\n--- device-list entries: ${deviceListCount} ---`);

  await client.close();
  console.log('\n--- Diagnostic complete ---');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
