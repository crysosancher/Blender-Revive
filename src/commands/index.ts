import { proto } from '@whiskeysockets/baileys';
import dotenv from 'dotenv';

dotenv.config();

const prefix = process.env.BOT_PREFIX || '/';

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  execute(sock: any, msg: proto.IWebMessageInfo, args: string[]): Promise<void>;
}

// Map command names and aliases to the Command instance
const commandRegistry = new Map<string, Command>();

/**
 * Registers a new command with the registry.
 */
export function registerCommand(command: Command) {
  /**
   * Auto-registers all separator variants of a key:
   *   "check_warn" → also registers "check-warn" and "checkwarn"
   *   "un-warn"    → also registers "un_warn"  and "unwarn"
   * This makes commands super user-friendly — users don't need to remember
   * whether it's a hyphen, underscore, or no separator.
   */
  const registerAllVariants = (key: string) => {
    const lowered = key.toLowerCase();
    commandRegistry.set(lowered, command);

    // If the key contains any separator (- or _), register all three forms
    if (lowered.includes('_') || lowered.includes('-')) {
      commandRegistry.set(lowered.replace(/[-_]/g, '_'), command); // underscore form
      commandRegistry.set(lowered.replace(/[-_]/g, '-'), command); // hyphen form
      commandRegistry.set(lowered.replace(/[-_]/g, ''),  command); // no-separator form
    }
  };

  registerAllVariants(command.name);
  if (command.aliases) {
    for (const alias of command.aliases) {
      registerAllVariants(alias);
    }
  }
}

/**
 * Returns all unique commands registered.
 */
export function getRegisteredCommands(): Command[] {
  return Array.from(new Set(commandRegistry.values()));
}

/**
 * Helper to extract text from various WhatsApp message types.
 */
export function getMessageText(msg: proto.IWebMessageInfo): string {
  const m = msg.message;
  if (!m) return '';

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }

  return '';
}

/**
 * Resolves a LID to a phone-based JID using the message key, local database, or USyncQuery.
 */
export async function resolveLidToPhone(sock: any, lid: string, msg?: proto.IWebMessageInfo): Promise<string | null> {
  if (!lid || !lid.endsWith('@lid')) return null;

  // 1. Check senderPn on the message key if available
  if (msg?.key) {
    const senderPn = (msg.key as any).senderPn;
    if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
      try {
        const { storeLidPhoneMapping } = await import('../db/lid-phone-map');
        await storeLidPhoneMapping(lid, senderPn);
      } catch (err) {
        // ignore
      }
      return senderPn;
    }
  }

  // 2. Check local database cache
  try {
    const { getPhoneJidFromLid } = await import('../db/lid-phone-map');
    const cached = await getPhoneJidFromLid(lid);
    if (cached) return cached;
  } catch (err) {
    // ignore
  }

  // 3. Query WhatsApp servers via USyncQuery
  try {
    const { resolvePhoneFromLid } = await import('../db/lid-phone-map');
    const resolved = await resolvePhoneFromLid(sock, lid);
    if (resolved) return resolved;
  } catch (err) {
    // ignore
  }

  return null;
}

/**
 * Utility to send a WhatsApp message simulating human typing.
 * Sends 'composing' presence, waits a dynamically calculated delay based on message length,
 * sends the message, and resets the presence.
 */
export async function sendHumanLikeResponse(
  sock: any,
  jid: string,
  content: { text?: string; [key: string]: any },
  options?: any
): Promise<any> {
  try {
    // Send composing (typing...) presence status
    await sock.sendPresenceUpdate('composing', jid);
  } catch (err) {
    // Ignore socket presence errors
  }

  // Calculate realistic typing speed delay:
  // Roughly 30ms per character. We cap it between 1 second and 3.5 seconds
  // so the bot remains responsive while still looking human.
  const textLength = content.text ? content.text.length : (content.caption ? content.caption.length : 0);
  const typingDelayMs = Math.min(Math.max(textLength * 30, 1000), 3500);

  await new Promise((resolve) => setTimeout(resolve, typingDelayMs));

  // Send the actual message
  const sentMsg = await sock.sendMessage(jid, content, options);

  try {
    // Reset presence state
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    // Ignore socket presence errors
  }

  return sentMsg;
}

/**
 * Validates if the sender of a message is the developer (either defined in DEVELOPER_NUMBER or fromMe).
 */
export async function isSenderDev(sock: any, msg: proto.IWebMessageInfo): Promise<boolean> {
  // 1. Bot owner/fromMe is always developer
  if (msg.key.fromMe) return true;

  const senderJid = msg.key.participant || msg.key.remoteJid!;
  console.log('[isSenderDev] Initial sender JID:', senderJid);

  // Resolve the phone number JID from the LID if needed
  let resolvedJid = senderJid;

  if (senderJid.endsWith('@lid')) {
    const jid = msg.key.remoteJid!;
    // A. Check Baileys message metadata
    if (jid.endsWith('@s.whatsapp.net')) {
      resolvedJid = jid;
    } else if (jid.endsWith('@g.us')) {
      const part = msg.key.participant;
      const partAlt = (msg.key as any).participantAlt;
      if (part?.endsWith('@s.whatsapp.net')) resolvedJid = part;
      else if (partAlt?.endsWith('@s.whatsapp.net')) resolvedJid = partAlt;
    } else {
      const remoteAlt = (msg.key as any).remoteJidAlt;
      if (remoteAlt?.endsWith('@s.whatsapp.net')) resolvedJid = remoteAlt;
    }
    console.log('[isSenderDev] Resolved from metadata:', resolvedJid);

    // B. If still LID, query database mappings and cache
    if (resolvedJid.endsWith('@lid')) {
      try {
        const { getPhoneJidFromLid } = await import('../db/lid-phone-map');
        const phoneJid = await getPhoneJidFromLid(resolvedJid);
        if (phoneJid) {
          resolvedJid = phoneJid;
        } else {
          const { getDb } = await import('../db/mongodb');
          const db = getDb();
          const existing = await db.collection('referrals').findOne({ _id: resolvedJid } as any);
          if (existing && existing.phoneJid) {
            resolvedJid = existing.phoneJid;
          }
        }
      } catch (err) {
        // Ignore DB/import errors
      }
    }
  }

  // 2. Check env developer numbers (handles country code mismatches like 917070224546 vs 7070224546)
  const devEnv = process.env.DEVELOPER_NUMBER || '';
  const devNumbers = devEnv.split(',').map((n) => n.trim().replace(/\D/g, ''));
  const senderNumber = resolvedJid.split('@')[0];
  
  const isMatch = devNumbers.some((devNum) => {
    return senderNumber === devNum || 
           (senderNumber.length >= 10 && senderNumber.endsWith(devNum)) || 
           (devNum.length >= 10 && devNum.endsWith(senderNumber));
  });

  if (isMatch) return true;

  return false;
}

/**
 * Checks if the sender of a message is a group admin (or super-admin) in the current group.
 * Returns false for DMs and if metadata cannot be retrieved.
 */
export async function isSenderGroupAdmin(sock: any, msg: proto.IWebMessageInfo): Promise<boolean> {
  const jid = msg.key.remoteJid!;
  if (!jid.endsWith('@g.us')) return false;

  const senderJid = msg.key.participant || msg.key.remoteJid!;

  let metadata;
  try {
    metadata = await sock.groupMetadata(jid);
  } catch (err) {
    console.error('[isGroupAdmin] Failed to fetch group metadata:', err);
    return false;
  }

  const senderParticipant = metadata.participants.find(
    (p: any) => cleanUserJidLocal(p.id) === cleanUserJidLocal(senderJid)
  );

  if (!senderParticipant) return false;
  return senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin';
}

/**
 * Local JID cleaner used by isSenderGroupAdmin. Mirrors the helper in referral.ts.
 */
function cleanUserJidLocal(jid: string): string {
  const parts = jid.split('@');
  const user = parts[0].split(':')[0];
  const domain = parts[1] || 's.whatsapp.net';
  return `${user}@${domain}`;
}

/**
 * Computes the Levenshtein distance between two strings.
 */
export function getLevenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  let i: number, j: number;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1, // deletion
        tmp[i][j - 1] + 1, // insertion
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
  }
  return tmp[a.length][b.length];
}

export async function handleIncomingMessage(sock: any, msg: proto.IWebMessageInfo): Promise<void> {
  let jid = msg.key.remoteJid;
  if (!jid) return;

  // Ignore status updates
  if (jid === 'status@broadcast') return;

  // Ignore messages sent by the bot itself to prevent infinite loops
  if (msg.key.fromMe) return;

  // Spam protection check (runs before command parsing so stickers/duplicates are caught)
  try {
    const spamResult = await checkSpam(sock, msg);
    if (spamResult === 'kicked') return;
  } catch (err) {
    console.error('[SpamProtection] Error during spam check:', err);
  }

  const isDm = !jid.endsWith('@g.us');

  const text = getMessageText(msg).trim();
  if (!text) return;

  // Check if message starts with the designated command prefix
  if (!text.startsWith(prefix)) {
    if (isDm) {
      // In DM, if the message is not a command, introduce the bot and its purpose
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `🔥 *BlenderRevive — Referral Bot*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nBruh, I'm not ChatGPT. 💀\n\nI'm a *referral bot* — I help job seekers find *real employees* at companies so you can DM them and get referred instead of cold-applying into the void.\n\n🎯 *Quick start:*\n1️⃣ \`${prefix}reg_ref <Your Company>\` — register yourself\n2️⃣ \`${prefix}company Google\` — find Google employees\n3️⃣ DM them with your resume + job link\n4️⃣ Get referred. Skip the ATS. Win. 🚀\n\n💡 Type \`${prefix}help\` for the full guide.\n\n👤 Built by *Virat Pandey* → github.com/crysosancher`
        },
        { quoted: msg }
      );
    }
    return;
  }

  // Parse command name and arguments
  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const command = commandRegistry.get(commandName);
  if (!command) {
    // Find the closest matching registered command name or alias
    let closestMatch: string | null = null;
    let minDistance = Infinity;

    for (const key of commandRegistry.keys()) {
      const dist = getLevenshteinDistance(commandName, key);
      if (dist < minDistance) {
        minDistance = dist;
        closestMatch = key;
      }
    }

    // Determine if the match is close enough (e.g. threshold based on command length)
    const threshold = Math.max(2, Math.floor(commandName.length / 2));
    if (closestMatch && minDistance <= threshold) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❓ *Did you mean:* \`${prefix}${closestMatch}\`?\n\nType \`${prefix}help\` to see a list of all available commands.` },
        { quoted: msg }
      );
    } else {
      if (isDm) {
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            text: `❓ *That command doesn't exist, fam.*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nI'm a referral bot, not Google. 😅\n\n💡 Type \`${prefix}help\` to see what I can actually do — spoiler: help you get referrals at top companies.\n\n👤 Built by *Virat Pandey* → github.com/crysosancher`
          },
          { quoted: msg }
        );
      } else {
        await sendHumanLikeResponse(
          sock,
          jid,
          { text: `⚠️ *Unknown command.* \n\nType \`${prefix}help\` to see a list of all available commands.` },
          { quoted: msg }
        );
      }
    }
    return;
  }

  console.log(`[Command] Found and executing: ${prefix}${commandName} from ${msg.pushName || 'User'} in chat ${jid}`);

  const startedAt = Date.now();

  try {
    await command.execute(sock, msg, args);
    // Log successful command usage for KPI analytics (non-blocking, fire-and-forget)
    logCommandUsage(commandName, msg, Date.now() - startedAt);
  } catch (error) {
    console.error(`[Command] Failed to execute ${commandName}:`, error);
    
    // Notify the chat of the error using a human-like response delay
    await sendHumanLikeResponse(
      sock,
      jid,
      { text: `❌ *Error executing command:* ${(error as Error).message}` },
      { quoted: msg }
    );
  }
}

/**
 * Logs command usage to the `command_usage` collection for KPI dashboard analytics.
 * Fire-and-forget: intentionally non-blocking so a logging failure never delays
 * the bot's command response.
 */
async function logCommandUsage(commandName: string, msg: proto.IWebMessageInfo, responseTimeMs: number): Promise<void> {
  try {
    const { getDb } = await import('../db/mongodb');
    const db = getDb();
    const collection = db.collection('command_usage');

    const jid = msg.key.remoteJid || '';
    const senderJid = msg.key.participant || jid;

    await collection.insertOne({
      commandName,
      userId: senderJid,
      userName: msg.pushName || 'Unknown',
      groupId: jid.endsWith('@g.us') ? jid : null,
      chatType: jid.endsWith('@g.us') ? 'group' : 'dm',
      responseTimeMs,
      timestamp: new Date(),
    });
  } catch (err) {
    // Swallow logging errors — analytics should never break the bot
  }
}

// Import and register all commands
import { pingCommand } from './ping';
import { helpCommand } from './help';
import {
  regRefCommand,
  updateRefCommand,
  refListCommand,
  refUpdateCommand,
  refDeleteCommand,
  tagunregCommand,
  companyCommand,
  verifyCronCommand,
  tagCompanyCommand,
  searchCommand,
  analyticsCommand
} from './referral';
import { devCommand } from './dev';
import { warnCommand, unwarnCommand, checkWarnCommand } from './warn';
import { spamCommand, rmWarnCommand, rmBlacklistCommand, checkSpam } from './spam';
import { questionCommand } from './question';

registerCommand(pingCommand);
registerCommand(helpCommand);
registerCommand(regRefCommand);
registerCommand(updateRefCommand);
registerCommand(refListCommand);
registerCommand(refUpdateCommand);
registerCommand(refDeleteCommand);
registerCommand(tagunregCommand);
registerCommand(companyCommand);
registerCommand(verifyCronCommand);
registerCommand(tagCompanyCommand);
registerCommand(searchCommand);
registerCommand(analyticsCommand);
registerCommand(devCommand);
registerCommand(warnCommand);
registerCommand(unwarnCommand);
registerCommand(checkWarnCommand);
registerCommand(rmWarnCommand);
registerCommand(rmBlacklistCommand);
registerCommand(spamCommand);
registerCommand(questionCommand);
