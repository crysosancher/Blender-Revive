import { Command, sendHumanLikeResponse } from './index';
import { LeaderboardPeriod, countDailySummaries, runPeriodicLeaderboard } from '../services/leaderboard';
import dotenv from 'dotenv';

dotenv.config();

const prefix = process.env.BOT_PREFIX || '/';

/**
 * Command: /leaderboard [week|month|year] (aliases: /top, /lb, /rank)
 * Posts the top 5 contributing members for the requested period, ranked by score.
 * Group-only and open to all group members.
 */
export const leaderboardCommand: Command = {
  name: 'leaderboard',
  aliases: ['top', 'lb', 'rank', 'ranks', 'leader'],
  description: 'Shows the top 5 contributing members of this group for the week, month, or year.',
  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid!;
    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '⚠️ *This command can only be used inside a group chat.*' },
        { quoted: msg }
      );
      return;
    }

    const raw = (args[0] || '').trim().toLowerCase();
    let period: LeaderboardPeriod = 'week';

    if (['week', 'weekly', 'w'].includes(raw)) {
      period = 'week';
    } else if (['month', 'monthly', 'm'].includes(raw)) {
      period = 'month';
    } else if (['year', 'yearly', 'annual', 'y'].includes(raw)) {
      period = 'year';
    } else if (raw) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Unknown period:* \`${raw}\`.\nUse \`${prefix}leaderboard week\`, \`${prefix}leaderboard month\`, or \`${prefix}leaderboard year\`.`,
        },
        { quoted: msg }
      );
      return;
    }

    try {
      const days = await countDailySummaries(jid, period);
      if (days === 0) {
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            text: `⚠️ *No saved daily analytics for the ${period} yet.*\nThe leaderboard builds from daily summaries, so give the bot a day or two first.`,
          },
          { quoted: msg }
        );
        return;
      }

      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `⏳ *Crunching the ${period} leaderboard from ${days} day(s) of daily summaries...*` },
        { quoted: msg }
      );

      await runPeriodicLeaderboard(sock, jid, period);
    } catch (err) {
      console.error('[Command: leaderboard] Failed to build leaderboard:', err);
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: `❌ *Error building the ${period} leaderboard:* ${(err as Error).message}` },
        { quoted: msg }
      );
    }
  },
};
