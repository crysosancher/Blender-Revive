import { getDb } from './mongodb';

/**
 * LID-to-Phone JID Mapping Service
 * 
 * WhatsApp is transitioning to LID-based identifiers (@lid).
 * Mentions only render as clickable blue tags when using phone-based JIDs (@s.whatsapp.net).
 * This service maintains a persistent mapping between the two, populated from:
 *   1. Active USyncQuery resolution (querying WhatsApp servers directly)
 *   2. `chats.phoneNumberShare` events (direct LID→phone sharing)
 *   3. Group participant metadata (which may contain both `lid` and `jid` fields)
 *   4. Contact sync events (contacts.upsert / contacts.update)
 */

interface LidPhoneMapping {
  _id: string;     // LID (e.g., '111261480181792@lid')
  phoneJid: string; // Phone-based JID (e.g., '919876543210@s.whatsapp.net')
  updatedAt: Date;
}

const COLLECTION_NAME = 'lid_phone_map';

/**
 * Stores a LID → Phone JID mapping. Upserts to always keep the latest.
 */
export async function storeLidPhoneMapping(lid: string, phoneJid: string): Promise<void> {
  if (!lid || !phoneJid) return;
  if (!lid.endsWith('@lid') || !phoneJid.endsWith('@s.whatsapp.net')) return;

  try {
    const col = getDb().collection<LidPhoneMapping>(COLLECTION_NAME);
    await col.updateOne(
      { _id: lid } as any,
      {
        $set: {
          phoneJid,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[LidPhoneMap] Failed to store mapping:', err);
  }
}

/**
 * Looks up the phone JID for a given LID from the local cache (MongoDB).
 * Returns the phone JID (e.g., '919876543210@s.whatsapp.net') or null if not found.
 */
export async function getPhoneJidFromLid(lid: string): Promise<string | null> {
  if (!lid || !lid.endsWith('@lid')) return null;

  try {
    const col = getDb().collection<LidPhoneMapping>(COLLECTION_NAME);
    const doc = await col.findOne({ _id: lid } as any);
    return doc?.phoneJid || null;
  } catch (err) {
    console.error('[LidPhoneMap] Failed to lookup mapping:', err);
    return null;
  }
}

/**
 * Batch lookup from local cache: Returns a Map<lid, phoneJid> for all known LIDs.
 */
export async function batchGetPhoneJids(lids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const lidOnly = lids.filter((l) => l.endsWith('@lid'));
  if (lidOnly.length === 0) return result;

  try {
    const col = getDb().collection<LidPhoneMapping>(COLLECTION_NAME);
    const docs = await col.find({ _id: { $in: lidOnly } } as any).toArray();
    for (const doc of docs) {
      result.set(doc._id, doc.phoneJid);
    }
  } catch (err) {
    console.error('[LidPhoneMap] Failed to batch lookup:', err);
  }

  return result;
}

/**
 * Actively resolves LID → Phone JID by querying WhatsApp's servers via USyncQuery.
 * This is the primary resolution method. Falls back to local cache if the query fails.
 * Results are cached in MongoDB for future lookups.
 * 
 * @param sock - The active WhatsApp socket instance
 * @param lid - The LID to resolve (e.g., '111261480181792@lid')
 * @returns The phone-based JID or null if unresolvable
 */
export async function resolvePhoneFromLid(sock: any, lid: string): Promise<string | null> {
  if (!lid || !lid.endsWith('@lid')) return null;

  // 1. Check local cache first
  const cached = await getPhoneJidFromLid(lid);
  if (cached) return cached;

  // 2. Query WhatsApp servers using USyncQuery
  try {
    // Import dynamically to avoid circular deps
    const { USyncQuery, USyncUser } = await import('@whiskeysockets/baileys');
    
    const usyncQuery = new USyncQuery()
      .withContactProtocol()
      .withLIDProtocol();
    
    // Query by LID using withId (the usync serializer puts user.id as jid attr)
    usyncQuery.withUser(new USyncUser().withId(lid));
    
    const results = await sock.executeUSyncQuery(usyncQuery);
    
    if (results?.list?.length > 0) {
      for (const entry of results.list) {
        const phoneJid = entry.id; // The `id` in results is the phone-based JID
        if (phoneJid && phoneJid.endsWith('@s.whatsapp.net')) {
          console.log(`[LidPhoneMap] Resolved via USyncQuery: ${lid} -> ${phoneJid}`);
          await storeLidPhoneMapping(lid, phoneJid);
          return phoneJid;
        }
      }
    }
  } catch (err) {
    console.error(`[LidPhoneMap] USyncQuery failed for ${lid}:`, err);
  }

  return null;
}

/**
 * Batch resolve: Actively resolves multiple LIDs to phone JIDs.
 * Checks local cache first, then queries WhatsApp for any unresolved LIDs.
 * 
 * @param sock - The active WhatsApp socket instance
 * @param lids - Array of LID strings to resolve
 * @returns Map<lid, phoneJid> of all resolved mappings
 */
export async function batchResolvePhoneJids(sock: any, lids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const lidOnly = lids.filter((l) => l.endsWith('@lid'));
  if (lidOnly.length === 0) return result;

  // 1. Check local cache first
  const cached = await batchGetPhoneJids(lidOnly);
  for (const [lid, phone] of cached) {
    result.set(lid, phone);
  }

  // 2. Find unresolved LIDs
  const unresolved = lidOnly.filter((l) => !result.has(l));
  if (unresolved.length === 0) return result;

  // 3. Query WhatsApp servers for unresolved LIDs
  try {
    const { USyncQuery, USyncUser } = await import('@whiskeysockets/baileys');
    
    const usyncQuery = new USyncQuery()
      .withContactProtocol()
      .withLIDProtocol();

    for (const lid of unresolved) {
      usyncQuery.withUser(new USyncUser().withId(lid));
    }

    const results = await sock.executeUSyncQuery(usyncQuery);
    
    if (results?.list?.length > 0) {
      for (const entry of results.list) {
        const phoneJid = entry.id;
        // Match back to the original LID using the lid field in results
        const entryLid = entry.lid;
        if (phoneJid?.endsWith('@s.whatsapp.net') && entryLid) {
          const fullLid = entryLid.endsWith('@lid') ? entryLid : `${entryLid}@lid`;
          console.log(`[LidPhoneMap] Batch resolved: ${fullLid} -> ${phoneJid}`);
          await storeLidPhoneMapping(fullLid, phoneJid);
          result.set(fullLid, phoneJid);
        }
      }
    }
  } catch (err) {
    console.error('[LidPhoneMap] Batch USyncQuery failed:', err);
  }

  return result;
}

/**
 * Captures LID→Phone mappings from group participant metadata.
 * Group participants (Contact type) may have both `lid` and `jid` fields populated.
 */
export async function captureGroupParticipantMappings(
  participants: Array<{ id: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string }>
): Promise<void> {
  const db = getDb();
  const mapCollection = db.collection(COLLECTION_NAME);
  const referralsCollection = db.collection('referrals');

  const mapOps: any[] = [];
  const referralOps: any[] = [];

  for (const p of participants) {
    const lid = p.id.endsWith('@lid') ? p.id : (p.lid?.endsWith('@lid') ? p.lid : null);
    const phoneJid = p.id.endsWith('@s.whatsapp.net') ? p.id : (p.jid?.endsWith('@s.whatsapp.net') ? p.jid : null);

    // Collect LID-to-phone mappings
    let hasMapping = false;
    if (p.id.endsWith('@lid') && p.jid?.endsWith('@s.whatsapp.net')) {
      hasMapping = true;
    } else if (p.id.endsWith('@s.whatsapp.net') && p.lid?.endsWith('@lid')) {
      hasMapping = true;
    } else if (p.lid?.endsWith('@lid') && p.jid?.endsWith('@s.whatsapp.net')) {
      hasMapping = true;
    }

    if (lid && phoneJid && hasMapping) {
      mapOps.push({
        updateOne: {
          filter: { _id: lid },
          update: {
            $set: {
              phoneJid,
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }

    // Capture and update name if available and username is currently 'Unknown'
    const name = p.notify || p.name || p.verifiedName;
    if (name && name !== 'Unknown') {
      if (lid) {
        referralOps.push({
          updateOne: {
            filter: { _id: lid, username: 'Unknown' } as any,
            update: { $set: { username: name } }
          }
        });
      }
      if (phoneJid) {
        referralOps.push({
          updateOne: {
            filter: { _id: phoneJid, username: 'Unknown' } as any,
            update: { $set: { username: name } }
          }
        });
        referralOps.push({
          updateOne: {
            filter: { phoneJid: phoneJid, username: 'Unknown' } as any,
            update: { $set: { username: name } }
          }
        });
      }
    }
  }

  // Execute bulk writes
  try {
    const promises: Promise<any>[] = [];
    if (mapOps.length > 0) {
      promises.push(mapCollection.bulkWrite(mapOps, { ordered: false }));
    }
    if (referralOps.length > 0) {
      promises.push(referralsCollection.bulkWrite(referralOps, { ordered: false }));
    }
    if (promises.length > 0) {
      await Promise.all(promises);
      console.log(`[LidPhoneMap] Bulk updated ${mapOps.length} mappings and processed ${referralOps.length} username updates.`);
    }
  } catch (err) {
    console.error('[LidPhoneMap] Bulk write failed for group participants:', err);
  }
}


