import { proto } from '@whiskeysockets/baileys';
import { Command, sendHumanLikeResponse, isSenderDev, isSenderGroupAdmin } from './index';
import { getDb } from '../db/mongodb';
import { resolvePhoneFromLid } from '../db/lid-phone-map';

const prefix = process.env.BOT_PREFIX || '/';

/**
 * Utility to normalize JIDs by removing device identifiers.
 */
function cleanUserJid(jid: string): string {
  const parts = jid.split('@');
  const user = parts[0].split(':')[0];
  const domain = parts[1] || 's.whatsapp.net';
  return `${user}@${domain}`;
}

/**
 * Command: -warn <@user | phone | reply> <reason>
 * Admin Command: Warns a user. On the 3rd warning, removes them from the group.
 */
export const warnCommand: Command = {
  name: 'warn',
  aliases: ['warning', 'w'],
  description: 'Admin/Group-admin: Warns a member. Removes them from the group on the 3rd warning.',
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
        { text: '❌ *Access Denied:* Only group admins (or the developer) can warn members.' },
        { quoted: msg }
      );
      return;
    }

    // 3. Identify the target JID
    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;

    let targetJid: string | null = null;
    let reasonIndex = 0; // index in args where reason starts

    if (ctxInfo?.participant) {
      targetJid = ctxInfo.participant;
      // All args are reason
      reasonIndex = 0;
    } else if (ctxInfo?.mentionedJid && ctxInfo.mentionedJid.length > 0) {
      targetJid = ctxInfo.mentionedJid[0];
      // First arg is the mention, rest is reason
      reasonIndex = 1;
    } else if (args.length > 0) {
      const rawArg = args[0].trim().replace(/^@/, '');
      const digits = rawArg.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        targetJid = `${digits}@s.whatsapp.net`;
        reasonIndex = 1;
      }
    }

    if (!targetJid) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Usage Error:* Mention a user or reply to their message to warn them.\n\n*Examples:*\n- \`${prefix}warn @user <reason>\`\n- Reply to a message with: \`${prefix}warn <reason>\`\n- \`${prefix}warn <phone_number> <reason>\``
        },
        { quoted: msg }
      );
      return;
    }

    // Normalize JID
    targetJid = cleanUserJid(targetJid);

    // Resolve LID and phone JID representations
    let targetPhone: string | null = null;
    let targetLid: string | null = null;

    if (targetJid.endsWith('@lid')) {
      targetLid = targetJid;
      targetPhone = await resolvePhoneFromLid(sock, targetJid);
    } else if (targetJid.endsWith('@s.whatsapp.net')) {
      targetPhone = targetJid;
      try {
        const db = getDb();
        const mapping = await db.collection('lid_phone_map').findOne({ phoneJid: targetJid });
        if (mapping) {
          targetLid = String(mapping._id);
        }
      } catch (err) {
        console.error('[Warn] Failed to lookup LID mapping from DB:', err);
      }
    }

    // 4. Validate if target is the bot itself
    const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    const botJid = sock.user?.id ? cleanUserJid(sock.user.id) : '';
    const envBotNumber = process.env.BOT_NUMBER || '';
    const cleanEnvBotNumber = envBotNumber.replace(/\D/g, '');
    const isBot = targetJid === botJid || 
                  (cleanEnvBotNumber && targetJid.split('@')[0] === cleanEnvBotNumber) ||
                  (targetPhone && (targetPhone === botJid || targetPhone.split('@')[0] === cleanEnvBotNumber)) ||
                  (targetLid && (targetLid === botJid));

    if (isBot) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* You cannot warn the bot.' },
        { quoted: msg }
      );
      return;
    }

    // 5. Validate if target is the sender
    const isSelf = targetJid === senderJid || 
                   (targetPhone && targetPhone === senderJid) || 
                   (targetLid && targetLid === senderJid);
    if (isSelf) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* You cannot warn yourself.' },
        { quoted: msg }
      );
      return;
    }

    // 6. Validate if target is an admin of the group
    let metadata;
    try {
      metadata = await sock.groupMetadata(jid);
    } catch (err) {
      console.error('[Warn] Failed to fetch group metadata:', err);
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* Failed to retrieve group details to verify admin status.' },
        { quoted: msg }
      );
      return;
    }

    // Find the participant using any matching JID field
    const targetParticipant = metadata.participants.find((p: any) => {
      const pIdClean = cleanUserJid(p.id);
      const pLidClean = p.lid ? cleanUserJid(p.lid) : null;
      const pJidClean = p.jid ? cleanUserJid(p.jid) : null;

      return pIdClean === targetJid ||
             (targetPhone && (pIdClean === targetPhone || pLidClean === targetPhone || pJidClean === targetPhone)) ||
             (targetLid && (pIdClean === targetLid || pLidClean === targetLid || pJidClean === targetLid));
    });

    // If the target is not in the group, we can't warn/remove them
    if (!targetParticipant) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* The specified user is not a participant in this group.' },
        { quoted: msg }
      );
      return;
    }

    // Harvest any additional IDs from the participant record
    if (targetParticipant.id.endsWith('@s.whatsapp.net')) {
      targetPhone = cleanUserJid(targetParticipant.id);
    } else if (targetParticipant.id.endsWith('@lid')) {
      targetLid = cleanUserJid(targetParticipant.id);
    }
    if (targetParticipant.lid?.endsWith('@lid')) {
      targetLid = cleanUserJid(targetParticipant.lid);
    }
    if (targetParticipant.jid?.endsWith('@s.whatsapp.net')) {
      targetPhone = cleanUserJid(targetParticipant.jid);
    }

    const isTargetAdmin = targetParticipant.admin === 'admin' || targetParticipant.admin === 'superadmin';
    if (isTargetAdmin) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* You cannot warn/remove group administrators.' },
        { quoted: msg }
      );
      return;
    }

    // 7. Record the warning
    const reason = args.slice(reasonIndex).join(' ').trim() || 'No reason specified';
    const db = getDb();
    const warningsCollection = db.collection('warnings');

    // Build the query to check any potential representation of the target user
    const userQuery = {
      $or: [
        { userId: targetJid },
        ...(targetPhone ? [{ userId: targetPhone }] : []),
        ...(targetLid ? [{ userId: targetLid }] : [])
      ]
    };

    // Count existing warnings
    const previousWarnsCount = await warningsCollection.countDocuments({
      groupId: jid,
      ...userQuery
    });

    const newWarnsCount = previousWarnsCount + 1;
    const canonicalTargetJid = targetPhone || targetLid || targetJid;

    // Insert warning log
    await warningsCollection.insertOne({
      groupId: jid,
      userId: canonicalTargetJid,
      warnedBy: senderJid,
      reason,
      createdAt: new Date()
    });

    // 8. Handle logic depending on warning count
    if (newWarnsCount >= 3) {
      // Try to remove user from the group using their exact group participant ID
      try {
        await sock.groupParticipantsUpdate(jid, [targetParticipant.id], 'remove');
        
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            text: `🚫 *@${canonicalTargetJid.split('@')[0]}* has been removed from the group after receiving 3 warnings.\n\n*Last warning reason:* ${reason}`,
            mentions: [canonicalTargetJid]
          },
          { quoted: msg }
        );
      } catch (err: any) {
        console.error('[Warn] Failed to remove user from group:', err);
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            text: `⚠️ *@${canonicalTargetJid.split('@')[0]}* has reached *3 warnings*, but the bot failed to remove them.\n\n*Reason for failure:* Make sure the bot is an admin with removal privileges.\n\n*Last warning reason:* ${reason}`,
            mentions: [canonicalTargetJid]
          },
          { quoted: msg }
        );
      }
    } else {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Warning ${newWarnsCount}/3 issued to @${canonicalTargetJid.split('@')[0]}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n👤 *Warned By:* @${senderJid.split('@')[0]}\n📝 *Reason:* ${reason}\n\n_If you reach 3 warnings, you will be automatically removed from the group._`,
          mentions: [canonicalTargetJid, senderJid]
        },
        { quoted: msg }
      );
    }
  },
};

/**
 * Command: -unwarn <@user | phone | reply> [all]
 * Admin Command: Removes the most recent warning (or all warnings) from a member.
 */
export const unwarnCommand: Command = {
  name: 'unwarn',
  aliases: ['clearwarn', 'removewarn', 'unwarning', 'un-warn'],
  description: 'Admin/Group-admin: Removes the most recent warning (or all warnings) from a member.',
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
        { text: '❌ *Access Denied:* Only group admins (or the developer) can remove warnings.' },
        { quoted: msg }
      );
      return;
    }

    // 3. Identify target JID
    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;

    let targetJid: string | null = null;
    let clearAll = false;

    if (ctxInfo?.participant) {
      targetJid = ctxInfo.participant;
      clearAll = args[0]?.toLowerCase() === 'all';
    } else if (ctxInfo?.mentionedJid && ctxInfo.mentionedJid.length > 0) {
      targetJid = ctxInfo.mentionedJid[0];
      clearAll = args[1]?.toLowerCase() === 'all';
    } else if (args.length > 0) {
      const rawArg = args[0].trim().replace(/^@/, '');
      const digits = rawArg.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        targetJid = `${digits}@s.whatsapp.net`;
        clearAll = args[1]?.toLowerCase() === 'all';
      }
    }

    if (!targetJid) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Usage Error:* Mention a user or reply to their message to remove a warning.\n\n*Examples:*\n- \`${prefix}unwarn @user\` (removes the last warning)\n- \`${prefix}unwarn @user all\` (removes all warnings)`
        },
        { quoted: msg }
      );
      return;
    }

    targetJid = cleanUserJid(targetJid);

    // Resolve JID representations
    let targetPhone: string | null = null;
    let targetLid: string | null = null;

    if (targetJid.endsWith('@lid')) {
      targetLid = targetJid;
      targetPhone = await resolvePhoneFromLid(sock, targetJid);
    } else if (targetJid.endsWith('@s.whatsapp.net')) {
      targetPhone = targetJid;
      try {
        const db = getDb();
        const mapping = await db.collection('lid_phone_map').findOne({ phoneJid: targetJid });
        if (mapping) {
          targetLid = String(mapping._id);
        }
      } catch (err) {
        // ignore
      }
    }

    const db = getDb();
    const warningsCollection = db.collection('warnings');

    const userQuery = {
      $or: [
        { userId: targetJid },
        ...(targetPhone ? [{ userId: targetPhone }] : []),
        ...(targetLid ? [{ userId: targetLid }] : [])
      ]
    };

    const canonicalTargetJid = targetPhone || targetLid || targetJid;

    if (clearAll) {
      const result = await warningsCollection.deleteMany({
        groupId: jid,
        ...userQuery
      });

      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `✅ *Cleared all warnings for @${canonicalTargetJid.split('@')[0]}*.\n(Removed ${result.deletedCount} warning logs)`,
          mentions: [canonicalTargetJid]
        },
        { quoted: msg }
      );
    } else {
      // Find the most recent warning
      const lastWarn = await warningsCollection.find({
        groupId: jid,
        ...userQuery
      }).sort({ createdAt: -1 }).limit(1).toArray();

      if (lastWarn.length === 0) {
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            text: `ℹ️ *@${canonicalTargetJid.split('@')[0]}* has *0 warnings* to remove.`,
            mentions: [canonicalTargetJid]
          },
          { quoted: msg }
        );
        return;
      }

      await warningsCollection.deleteOne({ _id: lastWarn[0]._id });

      const newCount = await warningsCollection.countDocuments({
        groupId: jid,
        ...userQuery
      });

      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `✅ *Removed last warning for @${canonicalTargetJid.split('@')[0]}*.\nRemaining warnings: *${newCount}/3*`,
          mentions: [canonicalTargetJid]
        },
        { quoted: msg }
      );
    }
  },
};

/**
 * Command: -check-warn <@user | phone | reply>
 * View warning history and count of a user (or self, if no user is specified).
 */
export const checkWarnCommand: Command = {
  name: 'check-warn',
  aliases: ['check_warn', 'warnings', 'warns'],
  description: 'Checks the number of warnings a user has and lists the reasons.',
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

    // 2. Identify target JID
    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;

    let targetJid: string | null = null;

    if (ctxInfo?.participant) {
      targetJid = ctxInfo.participant;
    } else if (ctxInfo?.mentionedJid && ctxInfo.mentionedJid.length > 0) {
      targetJid = ctxInfo.mentionedJid[0];
    } else if (args.length > 0) {
      const rawArg = args[0].trim().replace(/^@/, '');
      const digits = rawArg.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    // Default to self check if no target is specified
    if (!targetJid) {
      targetJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
    }

    targetJid = cleanUserJid(targetJid);

    // Resolve JID representations
    let targetPhone: string | null = null;
    let targetLid: string | null = null;

    if (targetJid.endsWith('@lid')) {
      targetLid = targetJid;
      targetPhone = await resolvePhoneFromLid(sock, targetJid);
    } else if (targetJid.endsWith('@s.whatsapp.net')) {
      targetPhone = targetJid;
      try {
        const db = getDb();
        const mapping = await db.collection('lid_phone_map').findOne({ phoneJid: targetJid });
        if (mapping) {
          targetLid = String(mapping._id);
        }
      } catch (err) {
        // ignore
      }
    }

    const db = getDb();
    const warningsCollection = db.collection('warnings');

    const userQuery = {
      $or: [
        { userId: targetJid },
        ...(targetPhone ? [{ userId: targetPhone }] : []),
        ...(targetLid ? [{ userId: targetLid }] : [])
      ]
    };

    const canonicalTargetJid = targetPhone || targetLid || targetJid;

    const warnings = await warningsCollection.find({
      groupId: jid,
      ...userQuery
    }).toArray();

    const count = warnings.length;
    const isSelf = targetJid === cleanUserJid(msg.key.participant || msg.key.remoteJid!);

    if (count === 0) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: isSelf
            ? `✅ *You have 0 warnings in this group.*`
            : `✅ *@${canonicalTargetJid.split('@')[0]}* has *0 warnings* in this group.`,
          mentions: [canonicalTargetJid]
        },
        { quoted: msg }
      );
      return;
    }

    // Format output exactly as requested
    let text = `⚠️ *Warnings for @${canonicalTargetJid.split('@')[0]}:*\n`;
    for (let i = 0; i < count; i++) {
      text += `* Warning ${i + 1}: ${warnings[i].reason}\n`;
    }

    const mentions = [canonicalTargetJid];

    await sendHumanLikeResponse(
      sock,
      jid,
      { text: text.trim(), mentions },
      { quoted: msg }
    );
  },
};
