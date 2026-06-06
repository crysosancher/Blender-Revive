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

dotenv.config();

// Initialize the pino logger for Baileys.
// Changing log level to 'warn' to hide verbose protocol frames and decrypt retries, 
// leaving only critical connection statuses and warnings.
const logger = pino({ level: 'warn' });

let sockInstance: any = null;

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
