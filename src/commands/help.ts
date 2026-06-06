import { Command, getRegisteredCommands, sendHumanLikeResponse } from './index';
import dotenv from 'dotenv';

dotenv.config();

const prefix = process.env.BOT_PREFIX || '/';

/**
 * Help command: Dynamically lists all registered commands in the bot registry.
 * Utilizes the custom human typing simulation helper to respond.
 */
export const helpCommand: Command = {
  name: 'help',
  aliases: ['h', 'menu', 'commands'],
  description: 'Displays the list of all available bot commands and their syntax.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const commands = getRegisteredCommands();

    let text = `🤖 *BlenderRevive High-Performance Bot Menu*\n\n`;
    text += `Below is a list of commands you can use:\n\n`;

    for (const cmd of commands) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 
        ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
        : '';
      
      text += `🔹 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `💡 _Tip: This bot runs on an async queue. Under high group load, your messages will be processed sequentially to prevent delays and disconnects._\n\n`;
    text += `⚡ *System:* Node.js + TS + MongoDB + Redis (BullMQ)`;

    // Send response simulating human typing speed
    await sendHumanLikeResponse(sock, jid, { text }, { quoted: msg });
  },
};
