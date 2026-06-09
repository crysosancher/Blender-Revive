import { Command, sendHumanLikeResponse, isSenderDev, getLevenshteinDistance } from './index';
import { getDb } from '../db/mongodb';
import { batchResolvePhoneJids, captureGroupParticipantMappings, storeLidPhoneMapping } from '../db/lid-phone-map';
import { proto } from '@whiskeysockets/baileys';
import dotenv from 'dotenv';

dotenv.config();

const prefix = process.env.BOT_PREFIX || '-';

interface ReferralDoc {
  _id: string; // Cleaned User JID (e.g. 111261480181792@lid or 913379676899@s.whatsapp.net)
  company: string; // Company Name
  username: string; // User pushName
  phoneJid?: string; // Resolved phone JID ending in @s.whatsapp.net
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date; // Added for soft delete support
}

/**
 * Utility to normalize JIDs by removing device identifiers (e.g., '913379676899:1@s.whatsapp.net' -> '913379676899@s.whatsapp.net').
 */
function cleanUserJid(jid: string): string {
  const parts = jid.split('@');
  const user = parts[0].split(':')[0];
  const domain = parts[1] || 's.whatsapp.net';
  return `${user}@${domain}`;
}

/**
 * Sanitizes a company name by capitalizing the first letter of each word and replacing spaces with underscores.
 */
function sanitizeCompanyName(name: string): string {
  if (!name) return '';
  return name
    .trim()
    .split(/[_\s]+/) // Split by spaces or underscores
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('_');
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves a company name by checking for exact matches, substring matches, or close typos in the database.
 * If a match is found, returns the matched company name and a boolean indicating if it was a suggestion.
 * If no match is found, returns the sanitized input.
 */
async function resolveCompanySanity(rawName: string): Promise<{ matched: string; isSuggested: boolean }> {
  const sanitized = sanitizeCompanyName(rawName);
  if (!sanitized) return { matched: '', isSuggested: false };

  const referralsCollection = getDb().collection<ReferralDoc>('referrals');

  // 1. Check exact/case-insensitive match (not soft-deleted)
  const exactMatch = await referralsCollection.findOne({
    company: { $regex: new RegExp(`^${escapeRegex(sanitized)}$`, 'i') },
    deletedAt: { $exists: false }
  } as any);

  if (exactMatch) {
    return { matched: exactMatch.company, isSuggested: false };
  }

  // Get all unique companies (not soft-deleted)
  const allCompanies = await referralsCollection.distinct('company', { deletedAt: { $exists: false } });
  if (allCompanies.length === 0) {
    return { matched: sanitized, isSuggested: false };
  }

  // 2. Try substring matching
  const substringMatches = allCompanies.filter((c) =>
    c.toLowerCase().includes(sanitized.toLowerCase())
  );

  if (substringMatches.length > 0) {
    substringMatches.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(sanitized.toLowerCase());
      const bStarts = b.toLowerCase().startsWith(sanitized.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.length - b.length;
    });
    return { matched: substringMatches[0], isSuggested: true };
  }

  // 3. Try Levenshtein fuzzy matching
  let closestMatch: string | null = null;
  let minDistance = Infinity;

  for (const company of allCompanies) {
    const dist = getLevenshteinDistance(sanitized.toLowerCase(), company.toLowerCase());
    if (dist < minDistance) {
      minDistance = dist;
      closestMatch = company;
    }
  }

  let threshold = 3;
  if (sanitized.length <= 3) {
    threshold = 1;
  } else if (sanitized.length <= 6) {
    threshold = 2;
  }

  if (closestMatch && minDistance <= threshold) {
    return { matched: closestMatch, isSuggested: true };
  }

  // No match found - treat as a brand new company name
  return { matched: sanitized, isSuggested: false };
}


/**
 * Resolves the phone-based JID (@s.whatsapp.net) of the sender from a message key,
 * mapping it away from an LID (@lid) if possible.
 */
function resolvePhoneJid(msg: proto.IWebMessageInfo): string | null {
  const jid = msg.key.remoteJid!;
  if (jid.endsWith('@s.whatsapp.net')) return jid;

  if (jid.endsWith('@g.us')) {
    const part = msg.key.participant;
    const partAlt = (msg.key as any).participantAlt;
    if (part?.endsWith('@s.whatsapp.net')) return part;
    if (partAlt?.endsWith('@s.whatsapp.net')) return partAlt;
  } else {
    const remoteAlt = (msg.key as any).remoteJidAlt;
    if (remoteAlt?.endsWith('@s.whatsapp.net')) return remoteAlt;
  }

  return null;
}

/**
 * Helper to format a user identifier according to the location (Group vs DM).
 * - Group: Displays the pushName text without any mention tag.
 * - DM: Displays a clickable mention tag using the user's phone-based JID.
 *        Falls back to LID-based mention if phone JID is unavailable.
 *
 * @param resolvedPhoneJid - Pre-resolved phone JID from the LID mapping service.
 *   Pass this to avoid async lookups; the caller should batch-resolve before calling.
 */
function formatUser(
  userJid: string,
  pushName: string,
  remoteJid: string,
  phoneJid?: string,
  resolvedPhoneJid?: string
): { text: string; mentions: string[] } {
  const cleanJid = cleanUserJid(userJid);
  const isGroup = remoteJid.endsWith('@g.us');
  
  if (isGroup) {
    if (pushName && pushName !== 'Unknown') {
      return { text: pushName, mentions: [] };
    }
    // Fallback if name is Unknown in a group: display the number/ID but DO NOT add to mentions array (no notification)
    const targetJid = resolvedPhoneJid || phoneJid || cleanJid;
    const num = targetJid.split('@')[0];
    return { text: `@${num}`, mentions: [] };
  } else {
    // In DMs: use the mention tag so the receiver's app resolves the username dynamically
    const targetJid = resolvedPhoneJid || phoneJid || cleanJid;
    if (targetJid.endsWith('@s.whatsapp.net')) {
      const phone = targetJid.split('@')[0];
      return { text: `@${phone}`, mentions: [targetJid] };
    }
    const lidNum = targetJid.split('@')[0];
    return { text: `@${lidNum}`, mentions: [targetJid] };
  }
}

/**
 * Command: -reg_ref <Company Name>
 * Registers the sender under the specified company.
 */
export const regRefCommand: Command = {
  name: 'reg_ref',
  aliases: ['register_ref'],
  description: 'Registers yourself under a company.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;
    const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    const pushName = msg.pushName || 'User';
    const phoneJid = resolvePhoneJid(msg) || undefined;

    // Capture LID→Phone mapping if available
    if (senderJid.endsWith('@lid') && phoneJid) {
      await storeLidPhoneMapping(senderJid, phoneJid);
    }

    const rawCompanyName = args.join(' ').trim();
    if (!rawCompanyName) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Please specify a company.* \nUsage: \`${prefix}reg_ref <Company Name>\`` },
        { quoted: msg }
      );
      return;
    }
    const { matched: companyName, isSuggested } = await resolveCompanySanity(rawCompanyName);

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Check if user is already registered under any company (not soft-deleted)
    const existing = await referralsCollection.findOne({ _id: senderJid } as any);
    if (existing && !existing.deletedAt) {
      // If we found a phoneJid now but didn't have it before, update it retroactively
      if (phoneJid && !existing.phoneJid) {
        await referralsCollection.updateOne({ _id: senderJid } as any, { $set: { phoneJid } });
      }

      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ You are already registered under *${existing.company}*. Use \`${prefix}update_ref <New Company>\` if you wish to change it.` },
        { quoted: msg }
      );
      return;
    }

    // Insert new or restore/overwrite soft-deleted registration record
    await referralsCollection.updateOne(
      { _id: senderJid } as any,
      {
        $set: {
          company: companyName,
          username: pushName,
          phoneJid,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { deletedAt: "" }
      },
      { upsert: true }
    );

    const formatted = formatUser(senderJid, pushName, jid, phoneJid);

    const companyStr = isSuggested 
      ? `${companyName} _(closest match for "${rawCompanyName}")_` 
      : companyName;

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Registered Successfully*\n*Company:* ${companyStr}\n*User:* ${formatted.text}`,
        mentions: formatted.mentions,
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -update_ref <New Company Name>
 * Updates the sender's company affiliation.
 */
export const updateRefCommand: Command = {
  name: 'update_ref',
  aliases: ['update_referral'],
  description: 'Updates your registered company affiliation.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;
    const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    const pushName = msg.pushName || 'User';
    const phoneJid = resolvePhoneJid(msg) || undefined;

    // Capture LID→Phone mapping if available
    if (senderJid.endsWith('@lid') && phoneJid) {
      await storeLidPhoneMapping(senderJid, phoneJid);
    }

    const rawNewCompany = args.join(' ').trim();
    if (!rawNewCompany) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Please specify the new company.* \nUsage: \`${prefix}update_ref <New Company Name>\`` },
        { quoted: msg }
      );
      return;
    }
    const { matched: newCompany, isSuggested } = await resolveCompanySanity(rawNewCompany);

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    const existing = await referralsCollection.findOne({ _id: senderJid, deletedAt: { $exists: false } } as any);
    if (!existing) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ You have not registered yet. Use \`${prefix}reg_ref <Company Name>\` to register first.` },
        { quoted: msg }
      );
      return;
    }

    const oldCompany = existing.company;

    // Update registration details, incorporating the phoneJid if resolved
    await referralsCollection.updateOne(
      { _id: senderJid } as any,
      {
        $set: {
          company: newCompany,
          username: pushName,
          phoneJid: phoneJid || existing.phoneJid,
          updatedAt: new Date(),
        },
      }
    );

    const companyStr = isSuggested 
      ? `${newCompany} _(closest match for "${rawNewCompany}")_` 
      : newCompany;

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Company Updated Successfully*\n*Old Company:* ${oldCompany}\n*New Company:* ${companyStr}`,
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -ref_list
 * Displays all registered companies and users sorted by company.
 */
export const refListCommand: Command = {
  name: 'ref_list',
  aliases: ['reflist'],
  description: 'Lists all companies and registered users.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid!;
    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `🚫 *Command Disabled*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ The \`${prefix}reflist\` command is temporarily disabled.\n\n💡 Please register using \`${prefix}reg-ref <companyName>\` first, then use \`${prefix}company\` to check company data.`
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -company [<Company Name>]
 * Lists all registered companies, or shows users registered under a specific company.
 */
export const companyCommand: Command = {
  name: 'company',
  aliases: ['companies', 'campnay', 'compney', 'compnay'],
  description: 'Lists registered companies or gets users under a specific company.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;
    const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Authentication: Check if the user is registered first
    const existing = await referralsCollection.findOne({
      $or: [
        { _id: senderJid },
        ...((msg.key.participant || msg.key.remoteJid!).endsWith('@lid') && resolvePhoneJid(msg) ? [{ phoneJid: resolvePhoneJid(msg) }] : [])
      ],
      deletedAt: { $exists: false }
    } as any);

    if (!existing) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `🤖 *BlenderRevive Bot Policy*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *Registration Required*\n\nAs per the bot policy, you must register yourself first before accessing company data.\n\n👉 Please register using the command:\n\`${prefix}reg-ref <companyName>\`\n\n📝 *Important Notes:*\n- If you register under a false company, the developer or administrators might ban you.\n- If you are a student or unemployed, please register yourself as *Student* or *Unemployed* (e.g. \`${prefix}reg-ref Student\` or \`${prefix}reg-ref Unemployed\`).\n\nThank you for your cooperation! 🙏`
        },
        { quoted: msg }
      );
      return;
    }

    // Case 1: No arguments - show list of all companies
    if (args.length === 0) {
      const allRecords = await referralsCollection.find({ deletedAt: { $exists: false } }).toArray();
      if (allRecords.length === 0) {
        await sendHumanLikeResponse(
          sock,
          jid,
          { text: '🏢 *No registered companies found.*' },
          { quoted: msg }
        );
        return;
      }

      // Count users per company
      const companyCounts: { [company: string]: number } = {};
      for (const r of allRecords) {
        companyCounts[r.company] = (companyCounts[r.company] || 0) + 1;
      }

      const sortedCompanies = Object.keys(companyCounts).sort((a, b) => a.localeCompare(b));

      let text = `🏢 *Registered Companies List*\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      sortedCompanies.forEach((company, index) => {
        const count = companyCounts[company];
        text += `${index + 1}. *${company}* (${count} ${count === 1 ? 'user' : 'users'})\n`;
      });

      text += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      text += `💡 _Tip: Use \`${prefix}company <company_name>\` to view users registered under that company._`;

      await sendHumanLikeResponse(
        sock,
        jid,
        { text: text.trim() },
        { quoted: msg }
      );
      return;
    }

    // Case 2: Company name is provided - find registrations under it
    const rawTargetCompany = args.join(' ').trim();
    const { matched: matchedCompany, isSuggested } = await resolveCompanySanity(rawTargetCompany);

    // Search case-insensitively using regex
    const records = await referralsCollection.find({
      company: { $regex: new RegExp(`^${escapeRegex(matchedCompany)}$`, 'i') },
      deletedAt: { $exists: false }
    } as any).toArray();

    if (records.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *No referrals found for company:* *${matchedCompany}*` },
        { quoted: msg }
      );
      return;
    }

    // Actively resolve all LID-based user JIDs to phone JIDs
    const lidJids = records
      .filter((r) => r._id.endsWith('@lid') && !r.phoneJid)
      .map((r) => r._id);
    
    let lidPhoneMap = new Map<string, string>();
    if (lidJids.length > 0) {
      lidPhoneMap = await batchResolvePhoneJids(sock, lidJids);
    }

    const resolvePhoneForRecord = (record: ReferralDoc): string | undefined => {
      if (record.phoneJid?.endsWith('@s.whatsapp.net')) return record.phoneJid;
      if (record._id.endsWith('@lid')) return lidPhoneMap.get(record._id);
      if (record._id.endsWith('@s.whatsapp.net')) return record._id;
      return undefined;
    };

    let text = isSuggested
      ? `🏢 *Referrals for ${matchedCompany}* _(showing closest match for "${rawTargetCompany}")_\n`
      : `🏢 *Referrals for ${matchedCompany}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const allMentions: string[] = [];
    for (const record of records) {
      const resolvedPhone = resolvePhoneForRecord(record);
      const formatted = formatUser(record._id, record.username, jid, record.phoneJid, resolvedPhone);
      text += `👤 ${formatted.text}\n`;
      if (formatted.mentions.length > 0) {
        allMentions.push(...formatted.mentions);
      }
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 *Total:* ${records.length} ${records.length === 1 ? 'user' : 'users'}`;

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: text.trim(),
        mentions: allMentions,
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -ref_update <Old Name> <New Name>
 * Admin Command: Renames a company across all registered users.
 */
export const refUpdateCommand: Command = {
  name: 'ref_update',
  description: 'Dev: Updates a company name globally.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // Validate dev rights
    if (!(await isSenderDev(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only developers can manage company records.' },
        { quoted: msg }
      );
      return;
    }

    if (args.length < 2) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Usage Error:* Use \`${prefix}ref_update <Old Company Name> <New Company Name>\`` },
        { quoted: msg }
      );
      return;
    }

    const rawOldCompany = args[0];
    const rawNewCompany = args.slice(1).join(' ').trim();
    const oldCompany = sanitizeCompanyName(rawOldCompany);
    const newCompany = sanitizeCompanyName(rawNewCompany);

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Match company case-insensitively using regex (only active ones)
    const updateResult = await referralsCollection.updateMany(
      { company: { $regex: new RegExp(`^${escapeRegex(oldCompany)}$`, 'i') }, deletedAt: { $exists: false } } as any,
      {
        $set: {
          company: newCompany,
          updatedAt: new Date(),
        },
      }
    );

    if (updateResult.matchedCount === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *Error:* No company found matching *${oldCompany}*.` },
        { quoted: msg }
      );
      return;
    }

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Company Updated*\n*Old Name:* ${oldCompany}\n*New Name:* ${newCompany}\n_Modified registrations: ${updateResult.modifiedCount}_`,
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -ref_delete <Company Name>
 * Admin Command: Deletes a company and all user registrations under it.
 */
export const refDeleteCommand: Command = {
  name: 'ref_delete',
  description: 'Dev: Deletes a company and all user registrations under it.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // Validate dev rights
    if (!(await isSenderDev(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only developers can manage company records.' },
        { quoted: msg }
      );
      return;
    }

    const rawTargetCompany = args.join(' ').trim();
    if (!rawTargetCompany) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Usage Error:* Use \`${prefix}ref_delete <Company Name>\`` },
        { quoted: msg }
      );
      return;
    }
    const targetCompany = sanitizeCompanyName(rawTargetCompany);

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Soft-delete matches case-insensitively using regex by setting deletedAt field
    const deleteResult = await referralsCollection.updateMany(
      { company: { $regex: new RegExp(`^${escapeRegex(targetCompany)}$`, 'i') }, deletedAt: { $exists: false } } as any,
      {
        $set: {
          deletedAt: new Date(),
        },
      }
    );

    if (deleteResult.modifiedCount === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *Error:* No registered users found under company *${targetCompany}*.` },
        { quoted: msg }
      );
      return;
    }

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Company Soft-Deleted Successfully*\n_Deactivated registrations: ${deleteResult.modifiedCount}_`,
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: -tagunreg
 * Admin Command: Tags all members in a group chat who have not yet registered under any company.
 */
export const tagunregCommand: Command = {
  name: 'tagunreg',
  aliases: ['tagunregistered', 'tagallunregistered'],
  description: 'Dev: Mentions all group members who have not registered in the referral system.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid!;

    // 1. Must be in a group chat
    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* This command can only be executed within a group chat.' },
        { quoted: msg }
      );
      return;
    }

    // 2. Validate dev rights
    if (!(await isSenderDev(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only developers can tag unregistered group members.' },
        { quoted: msg }
      );
      return;
    }

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // 3. Fetch all participants in the group
    let metadata;
    try {
      metadata = await sock.groupMetadata(jid);
    } catch (err) {
      console.error('[TagAll] Failed to fetch group metadata:', err);
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* Failed to retrieve group participant details.' },
        { quoted: msg }
      );
      return;
    }

    const participants = metadata.participants;

    // 4. Fetch all registered users from database (excluding soft-deleted)
    const allRegistered = await referralsCollection.find({ deletedAt: { $exists: false } }).toArray();
    const registeredJids = new Set(allRegistered.map((r) => cleanUserJid(r._id)));

    // Get connection details to exclude the bot's own number
    const envBotNumber = process.env.BOT_NUMBER || '';
    const cleanEnvBotNumber = envBotNumber.replace(/\D/g, ''); // Extract only digits
    const botJid = sock.user?.id ? cleanUserJid(sock.user.id) : '';

    // 5. Filter for unregistered participants
    const unregistered = participants.filter((p: any) => {
      const cleanJid = cleanUserJid(p.id);
      const isBot = (botJid && cleanJid === botJid) || 
                    (cleanEnvBotNumber && cleanJid.split('@')[0] === cleanEnvBotNumber);
      return !registeredJids.has(cleanJid) && !isBot;
    });

    if (unregistered.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '🎉 *All set!* Every member of this group is already registered under a company.' },
        { quoted: msg }
      );
      return;
    }

    // 6. Format and send the tagall message
    let text = `📢 *Attention Unregistered Members!*\n\nYou have not registered under any company yet. Please register using \`${prefix}reg_ref <Company Name>\`:\n\n`;
    const mentions: string[] = [];

    for (const member of unregistered) {
      const phone = member.id.split('@')[0];
      text += `@${phone} `;
      mentions.push(member.id);
    }

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: text.trim(),
        mentions,
      },
      { quoted: msg }
    );
  },
};
