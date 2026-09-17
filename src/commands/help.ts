import { Command, getRegisteredCommands, sendHumanLikeResponse, isSenderDev } from './index';
import dotenv from 'dotenv';

dotenv.config();

const prefix = process.env.BOT_PREFIX || '/';

/**
 * Help command: Explains the bot's purpose as a referral discovery tool for job seekers,
 * walks users through the workflow, then lists available commands.
 * Tone: confident, slightly savage, Gen-Z friendly.
 */
export const helpCommand: Command = {
  name: 'help',
  aliases: ['h', 'menu', 'commands'],
  description: 'Shows what this bot does, how to use it, and all available commands.',
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

    // Sort utility category: dev, ping, help, question
    const utilityOrder = ['dev', 'ping', 'help', 'question'];
    categories.utility.sort((a, b) => utilityOrder.indexOf(a.name) - utilityOrder.indexOf(b.name));

    // ── Build the help message ──
    let text = `🔥 *BlenderRevive — Your Referral Cheat Code*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // WHAT IS THIS BOT
    text += `Stop cold-applying to jobs like it's 2015. 💀\n`;
    text += `This bot helps you *find real employees* at companies you want to work at — so you can DM them and ask for a *referral* instead of praying your resume gets past the ATS.\n\n`;

    // HOW IT WORKS
    text += `🎯 *How to Actually Get Referrals:*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `*Step 1️⃣ — Register yourself*\n`;
    text += `   \`${prefix}reg_ref <Your Company>\`\n`;
    text += `   _Student? Unemployed? No shame, just type:_\n`;
    text += `   \`${prefix}reg_ref Student\` or \`${prefix}reg_ref Unemployed\`\n\n`;

    text += `*Step 2️⃣ — Find your dream company*\n`;
    text += `   \`${prefix}company Google\` → see who's at Google\n`;
    text += `   \`${prefix}company\` → list ALL companies with registered users\n`;
    text += `   _Works with aliases too: HP, TCS, GS, etc._ 😎\n\n`;

    text += `*Step 3️⃣ — Search for people*\n`;
    text += `   \`${prefix}search @person\` → look up a specific person\n`;
    text += `   \`${prefix}search Bhumik\` → search by name\n`;
    text += `   \`${prefix}search TCS\` → search by company name\n\n`;

    text += `*Step 4️⃣ — DM them & ask for a referral* 🚀\n`;
    text += `   Go to their company's job portal, find a JD that matches your experience, and message them with your resume + the job link. That's it. You're welcome.\n\n`;

    // REAL-WORLD EXAMPLE
    text += `💡 *Real-World Example:*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `You want to join Google → type \`${prefix}company Google\`\n`;
    text += `→ You see 3 Google employees registered\n`;
    text += `→ Go to careers.google.com, find a role that fits you\n`;
    text += `→ DM one of them with your resume + job link\n`;
    text += `→ They refer you internally → you skip the ATS black hole\n`;
    text += `→ Interview? *Secured.* 🎯\n\n`;

    // COMMANDS LIST
    text += `📋 *All Commands:*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `🔍 *Find & Search*\n`;
    for (const cmd of categories.user.filter(c => ['company', 'search'].includes(c.name))) {
        const displayedAliases = cmd.aliases ? cmd.aliases.slice(0, 3) : [];
        const aliasStr = displayedAliases.length > 0 
          ? ` (or ${displayedAliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
      text += `🔹 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `📝 *Register & Update*\n`;
    for (const cmd of categories.user.filter(c => ['reg_ref', 'update_ref'].includes(c.name))) {
        const displayedAliases = cmd.aliases ? cmd.aliases.slice(0, 3) : [];
        const aliasStr = displayedAliases.length > 0 
          ? ` (or ${displayedAliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
      text += `🔹 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `👥 *Group Admin Commands*\n`;
    for (const cmd of categories.groupAdmin) {
        const displayedAliases = cmd.aliases ? cmd.aliases.slice(0, 3) : [];
        const aliasStr = displayedAliases.length > 0 
          ? ` (or ${displayedAliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
      text += `🔸 *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    if (isDev) {
      text += `🛡️ *Developer Admin Commands*\n`;
      for (const cmd of categories.dev) {
        const displayedAliases = cmd.aliases ? cmd.aliases.slice(0, 3) : [];
        const aliasStr = displayedAliases.length > 0 
          ? ` (or ${displayedAliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
        const isDisabled = cmd.name === 'ref_list' ? ' _[Temporarily Disabled for Users]_' : '';
        text += `👑 *${prefix}${cmd.name}*${aliasStr}${isDisabled}\n`;
        text += `   _${cmd.description}_\n\n`;
      }
    }

    text += `ℹ️ *System & Utility*\n`;
    for (const cmd of categories.utility) {
        const displayedAliases = cmd.aliases ? cmd.aliases.slice(0, 3) : [];
        const aliasStr = displayedAliases.length > 0 
          ? ` (or ${displayedAliases.map(a => `\`${prefix}${a}\``).join(', ')})` 
          : '';
      text += `▫️ *${prefix}${cmd.name}*${aliasStr}\n`;
      text += `   _${cmd.description}_\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `⚡ _Pro tip: This isn't a regular WhatsApp bot. It's a referral network. Register, explore, and stop applying into the void._ 🕳️`;

    // Send response simulating human typing speed
    await sendHumanLikeResponse(sock, jid, { text }, { quoted: msg });
  },
};

