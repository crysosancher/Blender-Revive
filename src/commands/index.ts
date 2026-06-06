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
  commandRegistry.set(command.name.toLowerCase(), command);
  if (command.aliases) {
    for (const alias of command.aliases) {
      commandRegistry.set(alias.toLowerCase(), command);
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
  const textLength = content.text ? content.text.length : 0;
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
 * Core command dispatcher. Parses the message body, matches it to a registered command,
 * and executes the command asynchronously.
 */
export async function handleIncomingMessage(sock: any, msg: proto.IWebMessageInfo): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Ignore status updates
  if (jid === 'status@broadcast') return;

  // Ignore messages sent by the bot itself to prevent infinite loops
  if (msg.key.fromMe) return;

  const text = getMessageText(msg).trim();
  if (!text) return;

  // Check if message starts with the designated command prefix
  if (!text.startsWith(prefix)) return;

  // Parse command name and arguments
  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const command = commandRegistry.get(commandName);
  if (!command) return;

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

registerCommand(pingCommand);
registerCommand(helpCommand);
