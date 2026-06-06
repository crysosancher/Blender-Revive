import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const usernameUpdates: { [lid: string]: string } = {
  '77464181203139@lid': 'Neo',
  '140488564838574@lid': 'Vasu Dedakiya',
  '112042996416734@lid': 'Rituparna (iit Chomda)',
  '105622020333680@lid': 'Ishank',
  '172717949067428@lid': 'Neeraj Patil',
  '204496345022535@lid': 'ᴾᴿᴼᴺᴼᴼᴮ𒆜ScriקtKi∂∂ie𒆜',
  '159729884119159@lid': 'Nitya Soni',
  '210582280122531@lid': '𝐀𝐘น𝐒𝐇 𝐓𝐈𝐖𝐀𝐑𝐈',
  '81827851165951@lid': 'Aditya',
  '203452651167928@lid': 'Taher',
  '6558566068330@lid': 'Nandha Kishor',
  '226332059431103@lid': 'Abhinav',
  '243602055798885@lid': 'Kartick Verma',
  '68461845868643@lid': 'Vishal Modi',
  '89674689335343@lid': 'ni3mumbaikar',
  '166236809912368@lid': 'Shadab Ilyas',
  '98616878350546@lid': 'Sabya Sachi Pal',
  '62496169840805@lid': 'Hrishik',
  '262263655133285@lid': 'Praggya Pandey',
  '244525524119709@lid': 'Manish Mamaji(Vodafone)',
  '119421666386000@lid': 'Ishan Yadav',
  '123712321933461@lid': 'Sovan',
  '206691090100310@lid': 'ਤਰੁਣ ਸਿੰਘ',
  '133917080297494@lid': 'NO-ONE',
  '163908937584816@lid': 'Mahesh Kumar',
  '45217499615255@lid': 'Rishabh Sharma',
  '264772033499154@lid': 'Awadhesh Sharma',
  '213644608585855@lid': 'PROFESSOR',
  '189683036344486@lid': 'Thakur',
  '93759152898184@lid': 'Ritik',
  '211961082056705@lid': 'Rishabh Verma',
  '140849325305985@lid': 'Deepanshu',
  '104544218402874@lid': 'akhiLESh🌚',
  '61555907538963@lid': 'Sanjay',
  '28497191952385@lid': 'Taher Barwaniwala',
  '185392380776661@lid': 'Pruthvi (GEEKSoft Referral)',
  '236210366709824@lid': 'Rohit Patil',
  '111261480181792@lid': 'BHUMIK JAIN',
  '220087445389545@lid': 'Adi',
  '273297560350973@lid': 'Prathamesh Pradip Bhosale',
  '164527614242817@lid': 'Jatin'
};

async function update() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI not set');
    return;
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(process.env.MONGO_DB_NAME || 'whatsapp_bot');
  const collection = db.collection('referrals');

  let updated = 0;
  for (const [lid, username] of Object.entries(usernameUpdates)) {
    const res = await collection.updateOne(
      { _id: lid } as any,
      { $set: { username } }
    );
    if (res.modifiedCount > 0) {
      console.log(`Updated ${lid} to: ${username}`);
      updated++;
    }
  }

  console.log(`\nSuccessfully updated ${updated} usernames in the referrals database!`);
  await client.close();
}

update();
