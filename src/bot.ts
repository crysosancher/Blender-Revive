import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  proto,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import { getDb } from './db/mongodb';
import { useMongoDBAuthState } from './auth/mongo-auth';
import { queueMessage } from './queue/message-queue';
import { storeLidPhoneMapping, captureGroupParticipantMappings } from './db/lid-phone-map';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Initialize the pino logger for Baileys.
// Changing log level to 'warn' to hide verbose protocol frames and decrypt retries, 
// leaving only critical connection statuses and warnings.
const logger = pino({ level: 'warn' });

let sockInstance: any = null;

/**
 * Utility to normalize JIDs.
 */
function cleanJid(jid: string): string {
  const parts = jid.split('@');
  const user = parts[0].split(':')[0];
  const domain = parts[1] || 's.whatsapp.net';
  return `${user}@${domain}`;
}

/**
 * Returns the active WhatsApp socket instance.
 */
export function getSocket() {
  return sockInstance;
}

/**
 * Main function to initialize and start the WhatsApp Bot.
 * Handles authentication, database state sync, socket events, and auto-reconnection.
 */
export async function startWhatsAppBot(): Promise<any> {
  const db = getDb();
  const sessionId = process.env.SESSION_ID || 'blender-revive-session';

  console.log(`[Bot] Initializing session: ${sessionId}...`);

  // Load custom MongoDB authentication state
  const { state, saveCreds } = await useMongoDBAuthState(db, sessionId);

  // Fetch the latest WhatsApp Web version dynamically to avoid 405/connection close errors
  let version: any = [2, 3000, 1015901307]; // Fallback version
  try {
    const latestVersion = await fetchLatestBaileysVersion();
    version = latestVersion.version;
    console.log(`[Bot] Successfully fetched latest WhatsApp Web version: ${version.join('.')}`);
  } catch (err) {
    console.warn('[Bot] Failed to fetch latest WhatsApp version, using fallback version.', err);
  }

  // Establish WASocket connection
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // We will custom print with qrcode-terminal for better styling
    auth: {
      creds: state.creds,
      // Wrap MongoDB key store with in-memory caching to optimize read speed!
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // High-performance connection tuning
    connectTimeoutMs: 60000,          // Wait up to 60s for initial handshake
    keepAliveIntervalMs: 15000,       // Send keep-alive ping frames every 15s (reduced from 30s for better connection persistence)
    defaultQueryTimeoutMs: 90000,     // Wait up to 90s for queries (resolves 'init queries' timeouts)
    emitOwnEvents: false,             // Do not process messages sent by ourselves in listeners
  });

  sockInstance = sock;

  // 1. Credentials sync event
  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  // 1b. Capture LID → Phone JID mappings from WhatsApp's phone number sharing protocol.
  // This fires when WhatsApp reveals the phone number behind a LID.
  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    console.log(`[Bot] Phone number share captured: ${lid} -> ${jid}`);
    await storeLidPhoneMapping(lid, jid);
  });

  // 1c. Capture LID↔Phone mappings from contact sync events.
  // These fire during history sync and whenever contacts are updated.
  // Contact objects may contain both `lid` (LID) and `id`/`jid` (phone) fields.
  const captureContactMappings = async (contacts: Array<{ id: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string }>) => {
    const db = getDb();
    const mapCollection = db.collection('lid_phone_map');
    const referralsCollection = db.collection('referrals');

    const mapOps: any[] = [];
    const referralOps: any[] = [];

    for (const contact of contacts) {
      const lid = contact.id?.endsWith('@lid') ? contact.id : (contact.lid?.endsWith('@lid') ? contact.lid : null);
      const phoneJid = contact.id?.endsWith('@s.whatsapp.net') ? contact.id : (contact.jid?.endsWith('@s.whatsapp.net') ? contact.jid : null);

      if (lid && phoneJid) {
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
      const name = contact.notify || contact.name || contact.verifiedName;
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
        console.log(`[Bot] Bulk mapped ${mapOps.length} contacts and processed ${referralOps.length} username updates.`);
      }
    } catch (err) {
      console.error('[Bot] Bulk contact write failed:', err);
    }
  };

  sock.ev.on('contacts.upsert', async (contacts: any[]) => {
    console.log(`[Bot] Contacts upsert: ${contacts.length} contacts received, scanning for LID mappings...`);
    await captureContactMappings(contacts);
  });

  sock.ev.on('contacts.update', async (contacts: any[]) => {
    await captureContactMappings(contacts);
  });

  // 1d. Capture mappings from history sync (contains contacts with both id and lid)
  sock.ev.on('messaging-history.set', async ({ contacts }: any) => {
    if (contacts && Array.isArray(contacts)) {
      console.log(`[Bot] History sync: ${contacts.length} contacts, scanning for LID mappings...`);
      await captureContactMappings(contacts);
    }
  });

  // 2. Connection updates (QR generation, opened, closed)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[Bot] Scan this QR Code to log in:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'connecting') {
      console.log('[Bot] Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('[Bot] Connection successfully established with WhatsApp!');

      // Background: Scan all groups to harvest LID↔Phone participant mappings & usernames.
      // This runs once on each connection open, building the mapping table so
      // DM mentions can resolve LIDs to clickable phone JIDs.
      setTimeout(async () => {
        try {
          console.log('[Bot] Starting background group scan for LID→Phone mappings and usernames...');
          const groups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(groups);

          for (const gid of groupIds) {
            const group = groups[gid];
            if (group.participants) {
              await captureGroupParticipantMappings(group.participants);
            }
          }

          console.log(`[Bot] Group scan complete: ${groupIds.length} groups scanned.`);
        } catch (err) {
          console.error('[Bot] Background group scan failed (non-fatal):', err);
        }
      }, 5000); // Wait 5s after connection to avoid flooding
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[Bot] Connection closed. Reason code: ${statusCode}. Reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        console.log('[Bot] Re-establishing connection in 5 seconds...');
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        console.log('[Bot] Logged out from WhatsApp. Please delete credentials in MongoDB if you wish to re-scan.');
      }
    }
  });

  // 3. Message Upsert Event
  // Whenever a new message is received (in group or private chat), we queue it instantly.
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        // Optimization: Pre-filter out messages without body content (e.g. protocol messages) before queueing
        if (!msg.message) continue;

        // Capture and update name if available and username is currently 'Unknown'
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const pushName = msg.pushName;
        if (senderJid && pushName && pushName !== 'Unknown') {
          const cleanSender = cleanJid(senderJid);
          try {
            const referralsCollection = getDb().collection('referrals');
            await referralsCollection.updateOne(
              { _id: cleanSender, username: 'Unknown' } as any,
              { $set: { username: pushName } }
            );
            if (cleanSender.endsWith('@s.whatsapp.net')) {
              await referralsCollection.updateOne(
                { phoneJid: cleanSender, username: 'Unknown' } as any,
                { $set: { username: pushName } }
              );
            }
          } catch (err) {
            // ignore
          }
        }

        // Log incoming DM messages to a file
        const jid = msg.key.remoteJid;
        if (jid && !jid.endsWith('@g.us') && jid !== 'status@broadcast' && !msg.key.fromMe) {
          try {
            const logsDir = path.join(__dirname, '../logs');
            if (!fs.existsSync(logsDir)) {
              fs.mkdirSync(logsDir, { recursive: true });
            }
            const logFilePath = path.join(logsDir, 'dm-messages.log');
            const logEntry = {
              timestamp: new Date().toISOString(),
              remoteJid: jid,
              pushName: msg.pushName,
              message: msg,
            };
            const serialized = JSON.stringify(logEntry, (key, val) => {
              if (val && (val.type === 'Buffer' || val instanceof Uint8Array || (val.constructor && val.constructor.name === 'Uint8Array'))) {
                return '[Buffer/Uint8Array]';
              }
              return val;
            }, 2);
            fs.appendFileSync(logFilePath, `${serialized}\n---\n`);
          } catch (err) {
            console.error('[Bot] Failed to log DM message:', err);
          }
        }

        try {
          // Push to Redis Queue for async processing
          await queueMessage(msg);
        } catch (error) {
          console.error('[Bot] Failed to enqueue incoming message:', error);
        }
      }
    }
  });

  return sock;
}
