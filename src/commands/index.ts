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
  const name = command.name.toLowerCase();
  commandRegistry.set(name, command);
  if (name.includes('_')) {
    commandRegistry.set(name.replace(/_/g, '-'), command);
  }
  if (command.aliases) {
    for (const alias of command.aliases) {
      const loweredAlias = alias.toLowerCase();
      commandRegistry.set(loweredAlias, command);
      if (loweredAlias.includes('_')) {
        commandRegistry.set(loweredAlias.replace(/_/g, '-'), command);
      }
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
  const senderJid = msg.key.participant || msg.key.remoteJid!;

  // 1. Bot owner/fromMe is always developer
  if (msg.key.fromMe) return true;

  // 2. Check env developer numbers
  const devEnv = process.env.DEVELOPER_NUMBER || '';
  const devNumbers = devEnv.split(',').map((n) => n.trim().replace(/\D/g, ''));
  const senderNumber = senderJid.split('@')[0];
  if (devNumbers.includes(senderNumber)) return true;

  return false;
}

/**
 * Core command dispatcher. Parses the message body, matches it to a registered command,
 * and executes the command asynchronously.
 */
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
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Ignore status updates
  if (jid === 'status@broadcast') return;

  // Ignore messages sent by the bot itself to prevent infinite loops
  if (msg.key.fromMe) return;

  const text = getMessageText(msg).trim();
  if (!text) return;

  const isDm = !jid.endsWith('@g.us');

  // Check if message starts with the designated command prefix
  if (!text.startsWith(prefix)) {
    if (isDm) {
      // In DM, if the message is not a command, prompt them to use help or contact the developer
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `🤖 *BlenderRevive Bot*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nI didn't recognize that message as a command.\n\n💡 Please use \`${prefix}help\` to see a list of all available commands.\n\n👤 Or contact my developer, *Virat Pandey*:\n- GitHub: https://github.com/crysosancher\n- LinkedIn: https://linkedin.com/in/crysosancher`
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
            text: `⚠️ *Unknown command.*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n💡 Type \`${prefix}help\` to see all available commands.\n\n👤 Or contact my developer, *Virat Pandey*:\n- GitHub: https://github.com/crysosancher\n- LinkedIn: https://linkedin.com/in/crysosancher`
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

  try {
    await command.execute(sock, msg, args);
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
  companyCommand
} from './referral';
import { devCommand } from './dev';

registerCommand(pingCommand);
registerCommand(helpCommand);
registerCommand(regRefCommand);
registerCommand(updateRefCommand);
registerCommand(refListCommand);
registerCommand(refUpdateCommand);
registerCommand(refDeleteCommand);
registerCommand(tagunregCommand);
registerCommand(companyCommand);
registerCommand(devCommand);
