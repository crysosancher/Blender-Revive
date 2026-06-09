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

    const categories = {
      user: [] as Command[],
      admin: [] as Command[],
      utility: [] as Command[],
    };

    // Classify
    for (const cmd of commands) {
      if (['company', 'reg_ref', 'update_ref', 'ref_list'].includes(cmd.name)) {
        categories.user.push(cmd);
      } else if (['ref_update', 'ref_delete', 'tagunreg'].includes(cmd.name)) {
        categories.admin.push(cmd);
      } else {
        categories.utility.push(cmd);
      }
    }

    // Sort user category according to specified order: company, reg_ref, update_ref, ref_list
    const userOrder = ['company', 'reg_ref', 'update_ref', 'ref_list'];
    categories.user.sort((a, b) => userOrder.indexOf(a.name) - userOrder.indexOf(b.name));

    // Sort admin category: ref_update, ref_delete, tagunreg
    const adminOrder = ['ref_update', 'ref_delete', 'tagunreg'];
    categories.admin.sort((a, b) => adminOrder.indexOf(a.name) - adminOrder.indexOf(b.name));

    // Sort utility category: dev, ping, help
    const utilityOrder = ['dev', 'ping', 'help'];
    categories.utility.sort((a, b) => utilityOrder.indexOf(a.name) - utilityOrder.indexOf(b.name));

    let text = `🤖 *BlenderRevive Bot Help Menu*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `📋 *User Commands (Referrals & Search)*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const cmd of categories.user) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 
        ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
        : '';
      const isDisabled = cmd.name === 'ref_list' ? ' _[Temporarily Disabled]_' : '';
      text += `🔹 *${prefix}${cmd.name}*${aliasStr}${isDisabled}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `⚡ *Developer Admin Commands*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const cmd of categories.admin) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 
        ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
        : '';
      text += `🔸 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `ℹ️ *System & Utility Commands*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const cmd of categories.utility) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 
        ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
        : '';
      text += `▫️ *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `💡 _Tip: Under high group message volume, requests are queued asynchronously to prevent socket disconnects._\n\n`;
    text += `⚡ *System:* Node.js + TS + MongoDB + Redis (BullMQ)`;

    // Send response simulating human typing speed
    await sendHumanLikeResponse(sock, jid, { text }, { quoted: msg });
  },
};
