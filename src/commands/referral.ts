import { Command, sendHumanLikeResponse, isSenderDev, isSenderGroupAdmin } from './index';
import { getDb } from '../db/mongodb';
import { batchResolvePhoneJids, captureGroupParticipantMappings, storeLidPhoneMapping } from '../db/lid-phone-map';
import { proto } from '@whiskeysockets/baileys';
import { verifyAndNormalizeCompany, runDatabaseCompanyNormalization, flushStaleVerifications, CompanyVerificationDoc } from '../services/company-verifier';
import { resolveCompanySanity, sanitizeCompanyName, escapeRegex } from '../services/company-resolver';
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

    // Call verifyAndNormalizeCompany to normalize and check ranking
    const verification = await verifyAndNormalizeCompany(rawCompanyName);
    const companyName = verification.canonicalName;
    const displayCompanyName = verification.displayName;

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
        { text: `⚠️ You are already registered under *${existing.company.replace(/_/g, ' ')}*. Use \`${prefix}update_ref <New Company>\` if you wish to change it.` },
        { quoted: msg }
      );
      return;
    }

    // Insert new or restore/overwrite soft-deleted registration record
    await referralsCollection.updateOne(
      { _id: senderJid } as any,
      {
        $set: {
          company: companyName, // Normalized name
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

    const badge = verification.rank === 'A' ? '⭐ ' : (verification.rank === 'B' ? '✅ ' : '');
    const rankText = verification.rank !== 'unranked' ? ` (Rank ${verification.rank})` : '';

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Registered Successfully*\n*Company:* ${badge}${displayCompanyName}${rankText}\n*User:* ${formatted.text}`,
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

    // Call verifyAndNormalizeCompany to normalize and check ranking
    const verification = await verifyAndNormalizeCompany(rawNewCompany);
    const newCompany = verification.canonicalName;
    const displayCompanyName = verification.displayName;

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
          company: newCompany, // Normalized name
          username: pushName,
          phoneJid: phoneJid || existing.phoneJid,
          updatedAt: new Date(),
        },
      }
    );

    const badge = verification.rank === 'A' ? '⭐ ' : (verification.rank === 'B' ? '✅ ' : '');
    const rankText = verification.rank !== 'unranked' ? ` (Rank ${verification.rank})` : '';

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Company Updated Successfully*\n*Old Company:* ${oldCompany.replace(/_/g, ' ')}\n*New Company:* ${badge}${displayCompanyName}${rankText}`,
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

    // Check if developer. If not, show disabled message.
    if (!(await isSenderDev(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `🚫 *Command Disabled*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ The \`${prefix}reflist\` command is temporarily disabled.\n\n💡 Please register using \`${prefix}reg-ref <companyName>\` first, then use \`${prefix}company\` to check company data.`
        },
        { quoted: msg }
      );
      return;
    }

    // Developer execution - show all registered users grouped by company
    const referralsCollection = getDb().collection<ReferralDoc>('referrals');
    const allRecords = await referralsCollection.find({ deletedAt: { $exists: false } }).toArray();

    if (allRecords.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '🏢 *No registered users found.*' },
        { quoted: msg }
      );
      return;
    }

    // Fetch cached company verifications to display standardized company names
    const verificationsCol = getDb().collection<CompanyVerificationDoc>('company_verifications');
    const verifications = await verificationsCol.find({}).toArray();
    const verificationsMap = new Map<string, CompanyVerificationDoc>();
    for (const v of verifications) {
      verificationsMap.set(v._id, v);
      if (v.canonicalName) {
        verificationsMap.set(v.canonicalName.toUpperCase().replace(/[\s_]+/g, '_'), v);
      }
    }

    // Actively resolve all LID-based user JIDs to phone JIDs
    const lidJids = allRecords
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

    // Group records by company
    const grouped: { [company: string]: ReferralDoc[] } = {};
    for (const record of allRecords) {
      if (!grouped[record.company]) {
        grouped[record.company] = [];
      }
      grouped[record.company].push(record);
    }

    let text = `👑 *Developer Console: Registered Referrals List*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    const allMentions: string[] = [];

    // Sort company names alphabetically
    const sortedCompanies = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

    for (const company of sortedCompanies) {
      const lookupKey = company.toUpperCase().replace(/[\s_]+/g, '_');
      const cache = verificationsMap.get(lookupKey);
      const displayName = cache ? cache.displayName : company.replace(/_/g, ' ');
      const badge = cache ? (cache.rank === 'A' ? '⭐ ' : (cache.rank === 'B' ? '✅ ' : '❓ ')) : '❓ ';

      text += `🏢 *${badge}${displayName}*\n`;
      for (const record of grouped[company]) {
        const resolvedPhone = resolvePhoneForRecord(record);
        const formatted = formatUser(record._id, record.username, jid, record.phoneJid, resolvedPhone);
        text += `  • ${formatted.text}\n`;
        if (formatted.mentions.length > 0) {
          allMentions.push(...formatted.mentions);
        }
      }
      text += `\n`;
    }

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

    // Fetch cached company verifications
    const verificationsCol = getDb().collection<CompanyVerificationDoc>('company_verifications');
    const verifications = await verificationsCol.find({}).toArray();
    const verificationsMap = new Map<string, CompanyVerificationDoc>();
    for (const v of verifications) {
      verificationsMap.set(v._id, v);
      if (v.canonicalName) {
        verificationsMap.set(v.canonicalName.toUpperCase().replace(/[\s_]+/g, '_'), v);
      }
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

      const rankA: { displayName: string; canonicalName: string; count: number }[] = [];
      const rankB: { displayName: string; canonicalName: string; count: number }[] = [];
      const unranked: { displayName: string; canonicalName: string; count: number }[] = [];

      for (const company of sortedCompanies) {
        const count = companyCounts[company];
        const lookupKey = company.toUpperCase().replace(/[\s_]+/g, '_');
        const cache = verificationsMap.get(lookupKey);
        const displayName = cache ? cache.displayName : company.replace(/_/g, ' ');
        const rank = cache ? cache.rank : 'unranked';

        const entry = { displayName, canonicalName: company, count };
        if (rank === 'A') {
          rankA.push(entry);
        } else if (rank === 'B') {
          rankB.push(entry);
        } else {
          unranked.push(entry);
        }
      }

      // Sort display names alphabetically within each rank
      const sortByDisplayName = (a: any, b: any) => a.displayName.localeCompare(b.displayName);
      rankA.sort(sortByDisplayName);
      rankB.sort(sortByDisplayName);
      unranked.sort(sortByDisplayName);

      let text = `🏢 *Registered Companies List*\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (rankA.length > 0) {
        text += `⭐ *Rank A (MNCs & Enterprise)*\n`;
        rankA.forEach((c) => {
          text += `- *${c.displayName}* (${c.count} ${c.count === 1 ? 'user' : 'users'})\n`;
        });
        text += `\n`;
      }

      if (rankB.length > 0) {
        text += `✅ *Rank B (Startups & Mid-size)*\n`;
        rankB.forEach((c) => {
          text += `- *${c.displayName}* (${c.count} ${c.count === 1 ? 'user' : 'users'})\n`;
        });
        text += `\n`;
      }

      if (unranked.length > 0) {
        text += `❓ *Unverified / Unranked*\n`;
        unranked.forEach((c) => {
          text += `- *${c.displayName}* (${c.count} ${c.count === 1 ? 'user' : 'users'})\n`;
        });
        text += `\n`;
      }

      const totalCompanies = rankA.length + rankB.length + unranked.length;
      const totalUsers = allRecords.length;

      text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      text += `📊 *Total:* ${totalCompanies} ${totalCompanies === 1 ? 'company' : 'companies'} • ${totalUsers} ${totalUsers === 1 ? 'user' : 'users'} registered\n\n`;
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

    // First, try to find an existing company in the DB using substring/fuzzy matching.
    // This handles partial inputs like "bdo" -> "BDO_India", "infosys lim" -> "Infosys_Limited", etc.
    const sanityMatch = await resolveCompanySanity(rawTargetCompany);
    const matchedCompany = sanityMatch.matched;

    // Run the matched company through the verifier to get rank, display name, and justification.
    // Falls back to the raw input if the matched name is empty.
    const verification = await verifyAndNormalizeCompany(matchedCompany || rawTargetCompany);
    const displayCompanyName = verification.displayName;
    const badge = verification.rank === 'A' ? '⭐ ' : (verification.rank === 'B' ? '✅ ' : '❓ ');

    // Robust matching for database query — match canonical, space-form, AND underscore-form of the input
    const spaceForm = matchedCompany.replace(/_/g, ' ');
    const records = await referralsCollection.find({
      $or: [
        { company: matchedCompany },
        { company: { $regex: new RegExp(`^${escapeRegex(spaceForm)}$`, 'i') } },
        { company: { $regex: new RegExp(`^${escapeRegex(matchedCompany)}$`, 'i') } },
        { company: { $regex: new RegExp(`^${escapeRegex(rawTargetCompany)}$`, 'i') } }
      ],
      deletedAt: { $exists: false }
    } as any).toArray();

    if (records.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *No referrals found for company:* *${displayCompanyName}*` },
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

    let text = `🏢 *Referrals for ${badge}${displayCompanyName}*\n`;
    if (sanityMatch.isSuggested) {
      text += `💡 _Showing closest match for "${rawTargetCompany}": ${matchedCompany}_\n`;
    }
    if (verification.justification && !sanityMatch.isSuggested) {
      text += `💡 _${verification.justification}_\n`;
    }
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

/**
 * Command: -verify_cron
 * Admin/Dev Command: Manually runs the company verification and database normalization job.
 */
export const verifyCronCommand: Command = {
  name: 'verify_cron',
  aliases: ['verify-cron', 'verifycron', 'normalize_db'],
  description: 'Dev: Manually runs the company verification and database normalization. Use "-flash" or "-flush" to clear stale cache first.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid!;

    // Validate dev rights
    if (!(await isSenderDev(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only developers can trigger this command.' },
        { quoted: msg }
      );
      return;
    }

    // Check for flush/flash flag in the message body
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const shouldFlush = body.toLowerCase().includes('flush') || body.toLowerCase().includes('flash');

    let flushMsg = '';
    if (shouldFlush) {
      try {
        const flushed = await flushStaleVerifications();
        flushMsg = `\n🗑️ *Cache Flushed:* ${flushed} stale fallback entries purged.`;
      } catch (flushErr: any) {
        console.error('[VerifyCron] Cache flush failed:', flushErr);
        flushMsg = `\n⚠️ *Cache flush failed:* ${flushErr.message || flushErr}`;
      }
    }

    await sendHumanLikeResponse(
      sock,
      jid,
      { text: `⚙️ *Running company normalization & verification check...*${flushMsg}\nThis may take a few seconds.` },
      { quoted: msg }
    );

    try {
      const { checked, updatedReferrals, apiCalls } = await runDatabaseCompanyNormalization();
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `✅ *Database Normalization Complete!*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📊 *Results:*\n- Companies Checked: *${checked}*\n- Referrals Normalised/Updated: *${updatedReferrals}*\n- Gemini API Calls: *${apiCalls}*${shouldFlush ? '\n- Stale Cache: *Flushed* ✅' : ''}`
        },
        { quoted: msg }
      );
    } catch (err: any) {
      console.error('[VerifyCron] Normalization failed:', err);
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *Error:* Failed to run company normalization: ${err.message || err}` },
        { quoted: msg }
      );
    }
  }
};

/**
 * Command: -tag_company <Company Name>
 * Admin Command: Tags all group members who are registered under the specified company.
 * Authorisation: Group admins (admin / superadmin) OR the developer.
 */
export const tagCompanyCommand: Command = {
  name: 'tag_company',
  aliases: ['tagcompany', 'tagco'],
  description: 'Admin/Group-admin: Mentions all group members registered under the given company.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // 1. Group-only
    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* This command can only be executed within a group chat.' },
        { quoted: msg }
      );
      return;
    }

    // 2. Authorisation: developer OR group admin
    const isDev = await isSenderDev(sock, msg);
    const isAdmin = !isDev ? await isSenderGroupAdmin(sock, msg) : false;
    if (!isDev && !isAdmin) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only group admins (or the developer) can tag company members.' },
        { quoted: msg }
      );
      return;
    }

    // 3. Parse company name
    const rawTargetCompany = args.join(' ').trim();
    if (!rawTargetCompany) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Usage Error:* Use \`${prefix}tag_company <Company Name>\`` },
        { quoted: msg }
      );
      return;
    }

    // 4. Resolve the company via substring/fuzzy match against existing DB companies
    const sanityMatch = await resolveCompanySanity(rawTargetCompany);
    const matchedCompany = sanityMatch.matched;

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // 5. Fetch all registrations under the matched company (and the raw input as a fallback)
    const spaceForm = matchedCompany.replace(/_/g, ' ');
    const allRegistered = await referralsCollection.find({
      $or: [
        { company: matchedCompany },
        { company: { $regex: new RegExp(`^${escapeRegex(spaceForm)}$`, 'i') } },
        { company: { $regex: new RegExp(`^${escapeRegex(matchedCompany)}$`, 'i') } },
        { company: { $regex: new RegExp(`^${escapeRegex(rawTargetCompany)}$`, 'i') } }
      ],
      deletedAt: { $exists: false }
    } as any).toArray();

    if (allRegistered.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *No registered users found for company:* *${matchedCompany.replace(/_/g, ' ')}*` },
        { quoted: msg }
      );
      return;
    }

    // 6. Fetch group participants and intersect with the registered set
    let metadata;
    try {
      metadata = await sock.groupMetadata(jid);
    } catch (err) {
      console.error('[TagCompany] Failed to fetch group metadata:', err);
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* Failed to retrieve group participant details.' },
        { quoted: msg }
      );
      return;
    }

    // Build a JID lookup so we can match referrals against group participants using either
    // their primary JID (which may be a LID) or their phone JID.
    const participantJids = new Set<string>();
    const participantMap = new Map<string, any>();
    for (const p of metadata.participants as any[]) {
      const cleanP = cleanUserJid(p.id);
      participantJids.add(cleanP);
      participantMap.set(cleanP, p);
      if (p.phoneNumber) {
        // Some Baileys versions expose phoneNumber on the participant object directly
        const phoneJid = `${p.phoneNumber.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        participantJids.add(phoneJid);
        participantMap.set(phoneJid, p);
      }
    }

    // Filter to only the users that exist in this group (using either _id or phoneJid)
    const inGroup = allRegistered.filter((r) => {
      const cleanId = cleanUserJid(r._id);
      if (participantJids.has(cleanId)) return true;
      if (r.phoneJid && participantJids.has(cleanUserJid(r.phoneJid))) return true;
      return false;
    });

    if (inGroup.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `ℹ️ No members from *${matchedCompany.replace(/_/g, ' ')}* are currently in this group.` },
        { quoted: msg }
      );
      return;
    }

    // 7. Resolve LID → phone JIDs for the in-group members (so mentions are clickable)
    const lidJids = inGroup
      .filter((r) => r._id.endsWith('@lid') && !r.phoneJid)
      .map((r) => r._id);

    let lidPhoneMap = new Map<string, string>();
    if (lidJids.length > 0) {
      lidPhoneMap = await batchResolvePhoneJids(sock, lidJids);
    }

    // 8. Get display name + best JID for each member, preferring phone JIDs (which are
    // guaranteed to be in this group) over the raw _id (which may be a LID not in the
    // participant map).
    const members: { name: string; jid: string }[] = [];
    for (const record of inGroup) {
      const phoneJid = record.phoneJid?.endsWith('@s.whatsapp.net')
        ? record.phoneJid
        : (record._id.endsWith('@lid') ? lidPhoneMap.get(record._id) : undefined);
      const targetJid = phoneJid || cleanUserJid(record._id);
      // Use the participant's existing JID if we can find a match, otherwise the targetJid
      const matchedParticipant = participantMap.get(targetJid) || participantMap.get(cleanUserJid(record._id));
      const finalJid = matchedParticipant ? cleanUserJid(matchedParticipant.id) : targetJid;

      members.push({
        name: record.username && record.username !== 'Unknown' ? record.username : finalJid.split('@')[0],
        jid: finalJid,
      });
    }

    // 9. Compose the tag message
    let text = `🏢 *${matchedCompany.replace(/_/g, ' ')}* — ${members.length} ${members.length === 1 ? 'member' : 'members'} in this group:\n\n`;
    if (sanityMatch.isSuggested) {
      text += `💡 _Showing closest match for "${rawTargetCompany}": ${matchedCompany}_\n\n`;
    }
    const mentions: string[] = [];
    for (const m of members) {
      text += `👤 @${m.jid.split('@')[0]}\n`;
      mentions.push(m.jid);
    }

    await sendHumanLikeResponse(
      sock,
      jid,
      { text: text.trim(), mentions },
      { quoted: msg }
    );
  }
};

