import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
  await client.connect();
  const db = client.db('whatsapp_bot');
  
  const keyCol = db.collection('keys');
  const types = await keyCol.distinct('type');
  console.log('--- Unique Key Types in DB ---');
  console.log(types);

  const countByType = await keyCol.aggregate([
    { $group: { _id: '$type', count: { $sum: 1 } } }
  ]).toArray();
  console.log('--- Count by Type ---');
  console.log(countByType);

  await client.close();
}

check().catch(console.error);
