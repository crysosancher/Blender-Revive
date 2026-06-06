/**
 * One-off migration script to import referral data from the previous bot.
 * 
 * Usage: npx ts-node scripts/migrate-old-referrals.ts
 */
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

interface ReferralDoc {
  _id: string;
  company: string;
  username: string;
  phoneJid?: string;
  createdAt: Date;
  updatedAt?: Date;
}

// Data extracted from the previous bot's ref_list output
const oldData: { company: string; lids: string[] }[] = [
  { company: 'Aiqod', lids: ['77464181203139'] },
  { company: 'Arms', lids: ['140488564838574'] },
  { company: 'Aws', lids: ['112042996416734'] },
  { company: 'Accenture', lids: ['105622020333680'] },
  { company: 'Amazon', lids: ['172717949067428'] },
  { company: 'Bdo India Llp', lids: ['204496345022535'] },
  { company: 'Bnp Paribas', lids: ['159729884119159'] },
  { company: 'Benchmark (Bcsl)', lids: ['210582280122531'] },
  { company: 'Cisco', lids: ['81827851165951'] },
  { company: 'Core Ehs', lids: ['203452651167928'] },
  { company: 'Data Unveil', lids: ['6558566068330'] },
  { company: 'Goldman Sachs', lids: ['226332059431103'] },
  { company: 'Hpe', lids: ['243602055798885'] },
  { company: 'Infosys', lids: ['68461845868643'] },
  { company: 'Ltm', lids: ['89674689335343', '166236809912368'] },
  { company: 'Ltm (Ltimindtree)', lids: ['98616878350546'] },
  { company: 'Microsoft', lids: ['62496169840805'] },
  { company: 'Optum', lids: ['262263655133285'] },
  { company: 'Oracle', lids: ['244525524119709'] },
  { company: 'Principal Global Service', lids: ['119421666386000'] },
  { company: 'Pwc India', lids: ['123712321933461'] },
  { company: 'Reliance Jio Plateform Limited -Alive', lids: ['206691090100310'] },
  { company: 'Saasworx', lids: ['133917080297494'] },
  { company: 'Smollan (By Google)', lids: ['163908937584816'] },
  { company: 'Sprinklr', lids: ['45217499615255'] },
  { company: 'Tcs', lids: ['148885141995551', '264772033499154', '213644608585855', '189683036344486'] },
  { company: 'Tartanhq', lids: ['93759152898184'] },
  { company: 'Volkswagen Group Digital Solutions', lids: ['211961082056705'] },
  { company: 'Volkswagen Group It Solution', lids: ['140849325305985'] },
  { company: 'Wipro', lids: ['104544218402874', '61555907538963'] },
  { company: 'Zeus Learning', lids: ['28497191952385'] },
  { company: 'Greeksoft', lids: ['185392380776661'] },
  { company: 'Qrusible', lids: ['236210366709824'] },
  { company: 'Thoughtbins', lids: ['111261480181792'] },
  { company: 'Vivo Mobile', lids: ['220087445389545', '273297560350973'] },
  { company: 'Zapbuild', lids: ['164527614242817'] },
];

async function migrate() {
  const mongoUri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME || 'whatsapp_bot';

  if (!mongoUri) {
    console.error('MONGO_URI not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log('[Migration] Connected to MongoDB');

    const db = client.db(dbName);
    const collection = db.collection<ReferralDoc>('referrals');

    let inserted = 0;
    let skipped = 0;

    for (const entry of oldData) {
      for (const lid of entry.lids) {
        const _id = `${lid}@lid`;

        // Check if already exists to avoid duplicates
        const existing = await collection.findOne({ _id } as any);
        if (existing) {
          console.log(`  [SKIP] ${_id} already exists (company: ${existing.company})`);
          skipped++;
          continue;
        }

        await collection.insertOne({
          _id,
          company: entry.company,
          username: 'Unknown', // Names not available from old data; will update on next interaction
          createdAt: new Date(),
        } as any);

        console.log(`  [INSERT] ${_id} -> ${entry.company}`);
        inserted++;
      }
    }

    console.log(`\n[Migration] Done! Inserted: ${inserted}, Skipped: ${skipped}`);
  } catch (err) {
    console.error('[Migration] Error:', err);
  } finally {
    await client.close();
    console.log('[Migration] MongoDB connection closed');
  }
}

migrate();
