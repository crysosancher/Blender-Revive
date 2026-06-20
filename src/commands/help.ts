import { Command, getRegisteredCommands, sendHumanLikeResponse, isSenderDev } from './index';
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

    const isDev = await isSenderDev(sock, msg);
    const commands = getRegisteredCommands();

    const categories = {
      user: [] as Command[],
      groupAdmin: [] as Command[],
      dev: [] as Command[],
      utility: [] as Command[],
    };

    // Classify
    for (const cmd of commands) {
      if (['company', 'search', 'reg_ref', 'update_ref'].includes(cmd.name)) {
        categories.user.push(cmd);
      } else if (['tag_company', 'warn', 'unwarn', 'check-warn'].includes(cmd.name)) {
        categories.groupAdmin.push(cmd);
      } else if (['ref_list', 'ref_update', 'ref_delete', 'tagunreg', 'verify_cron'].includes(cmd.name)) {
        categories.dev.push(cmd);
      } else {
        categories.utility.push(cmd);
      }
    }

    // Sort user category according to specified order: company, search, reg_ref, update_ref
    const userOrder = ['company', 'search', 'reg_ref', 'update_ref'];
    categories.user.sort((a, b) => userOrder.indexOf(a.name) - userOrder.indexOf(b.name));

    // Sort groupAdmin category: tag_company, warn, unwarn, check-warn
    const groupAdminOrder = ['tag_company', 'warn', 'unwarn', 'check-warn'];
    categories.groupAdmin.sort((a, b) => groupAdminOrder.indexOf(a.name) - groupAdminOrder.indexOf(b.name));

    // Sort dev category: ref_list, ref_update, ref_delete, tagunreg, verify_cron
    const devOrder = ['ref_list', 'ref_update', 'ref_delete', 'tagunreg', 'verify_cron'];
    categories.dev.sort((a, b) => devOrder.indexOf(a.name) - devOrder.indexOf(b.name));

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
      text += `🔹 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `👥 *Group Admin Commands*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const cmd of categories.groupAdmin) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 
        ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
        : '';
      text += `🔸 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    if (isDev) {
      text += `🛡️ *Developer Admin Commands*\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const cmd of categories.dev) {
        const aliasStr = cmd.aliases && cmd.aliases.length > 0 
          ? ` (or ${cmd.aliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
        const isDisabled = cmd.name === 'ref_list' ? ' _[Temporarily Disabled for Users]_' : '';
        text += `👑 *${prefix}${cmd.name}*${aliasStr}${isDisabled}\n`;
        text += `   _${cmd.description}_\n\n`;
      }
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
