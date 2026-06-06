import { Command, sendHumanLikeResponse, isSenderAdmin } from './index';
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

    const companyName = args.join(' ').trim();
    if (!companyName) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Please specify a company.* \nUsage: \`${prefix}reg_ref <Company Name>\`` },
        { quoted: msg }
      );
      return;
    }

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Check if user is already registered under any company
    const existing = await referralsCollection.findOne({ _id: senderJid } as any);
    if (existing) {
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

    // Insert new registration record
    await referralsCollection.insertOne({
      _id: senderJid,
      company: companyName,
      username: pushName,
      phoneJid,
      createdAt: new Date(),
    });

    const formatted = formatUser(senderJid, pushName, jid, phoneJid);

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Registered Successfully*\n*Company:* ${companyName}\n*User:* ${formatted.text}`,
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

    const newCompany = args.join(' ').trim();
    if (!newCompany) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Please specify the new company.* \nUsage: \`${prefix}update_ref <New Company Name>\`` },
        { quoted: msg }
      );
      return;
    }

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    const existing = await referralsCollection.findOne({ _id: senderJid } as any);
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

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ *Company Updated Successfully*\n*Old Company:* ${oldCompany}\n*New Company:* ${newCompany}`,
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
    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Retroactively capture the sender's phoneJid if they run -ref_list
    const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    const currentPhoneJid = resolvePhoneJid(msg);
    if (currentPhoneJid) {
      await referralsCollection.updateOne(
        { _id: senderJid, phoneJid: { $exists: false } } as any,
        { $set: { phoneJid: currentPhoneJid } }
      );
      // Also store in the LID mapping if sender uses LID
      if (senderJid.endsWith('@lid')) {
        await storeLidPhoneMapping(senderJid, currentPhoneJid);
      }
    }

    // If in a group, capture LID→Phone mappings from all group participants
    if (jid.endsWith('@g.us')) {
      try {
        const metadata = await sock.groupMetadata(jid);
        await captureGroupParticipantMappings(metadata.participants);
      } catch (err) {
        console.error('[RefList] Failed to capture group participant mappings:', err);
      }
    }

    const allRecords = await referralsCollection.find({}).toArray();

    // DEBUG: Log all record data to understand what JIDs and phone JIDs are stored
    console.log('[RefList] DEBUG - All records:');
    for (const r of allRecords) {
      console.log(`  _id=${r._id} | username=${r.username} | phoneJid=${r.phoneJid || 'NONE'} | company=${r.company}`);
    }

    if (allRecords.length === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '🏢 *No registered company referrals found.*' },
        { quoted: msg }
      );
      return;
    }

    // Actively resolve all LID-based user JIDs to phone JIDs by querying WhatsApp servers.
    // This is the key step that makes DM mentions clickable.
    const lidJids = allRecords
      .filter((r) => r._id.endsWith('@lid') && !r.phoneJid)
      .map((r) => r._id);
    console.log(`[RefList] Resolving ${lidJids.length} LID(s) to phone JIDs via WhatsApp...`);
    const lidPhoneMap = await batchResolvePhoneJids(sock, lidJids);

    // Also try to resolve from stored phoneJid field on records
    // and from the fresh LID mapping
    const resolvePhoneForRecord = (record: ReferralDoc): string | undefined => {
      // 1. Already has a phone JID stored on the record
      if (record.phoneJid?.endsWith('@s.whatsapp.net')) return record.phoneJid;
      // 2. Resolved from LID mapping service
      if (record._id.endsWith('@lid')) return lidPhoneMap.get(record._id);
      // 3. The _id itself is a phone JID
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

    let text = `🏢 *Registered Companies & Users*\n\n`;
    const allMentions: string[] = [];

    // Sort company names alphabetically
    const sortedCompanies = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

    for (const company of sortedCompanies) {
      text += `*${company}*\n`;
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
 * Command: -ref_update <Old Name> <New Name>
 * Admin Command: Renames a company across all registered users.
 */
export const refUpdateCommand: Command = {
  name: 'ref_update',
  description: 'Admin: Updates a company name globally.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // Validate admin rights
    if (!(await isSenderAdmin(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only administrators can manage company records.' },
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

    const oldCompany = args[0];
    const newCompany = args.slice(1).join(' ').trim();

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Match company case-insensitively using regex
    const updateResult = await referralsCollection.updateMany(
      { company: { $regex: new RegExp(`^${oldCompany}$`, 'i') } } as any,
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
  description: 'Admin: Deletes a company and all user registrations under it.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // Validate admin rights
    if (!(await isSenderAdmin(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only administrators can manage company records.' },
        { quoted: msg }
      );
      return;
    }

    const targetCompany = args.join(' ').trim();
    if (!targetCompany) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⚠️ *Usage Error:* Use \`${prefix}ref_delete <Company Name>\`` },
        { quoted: msg }
      );
      return;
    }

    const referralsCollection = getDb().collection<ReferralDoc>('referrals');

    // Delete matches case-insensitively using regex
    const deleteResult = await referralsCollection.deleteMany({
      company: { $regex: new RegExp(`^${targetCompany}$`, 'i') },
    } as any);

    if (deleteResult.deletedCount === 0) {
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
        text: `✅ *Company Deleted Successfully*\n_Removed registrations: ${deleteResult.deletedCount}_`,
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
  description: 'Admin: Mentions all group members who have not registered in the referral system.',
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

    // 2. Validate admin rights
    if (!(await isSenderAdmin(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only administrators can tag unregistered group members.' },
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

    // 4. Fetch all registered users from database
    const allRegistered = await referralsCollection.find({}).toArray();
    const registeredJids = new Set(allRegistered.map((r) => cleanUserJid(r._id)));

    // Get connection details to exclude the bot's own number
    const botJid = cleanUserJid(sock.user.id);

    // 5. Filter for unregistered participants
    const unregistered = participants.filter((p: any) => {
      const cleanJid = cleanUserJid(p.id);
      return !registeredJids.has(cleanJid) && cleanJid !== botJid;
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
