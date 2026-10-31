import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { getDb } from '../db/mongodb';
import { DailySummaryDoc, isLastDayOfMonthIst, IST_TIMEZONE } from './daily-summary-store';

dotenv.config();

// Initialize the Google Gen AI SDK (same pattern as gemini-analytics.ts)
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenerativeAI(apiKey);

export type LeaderboardPeriod = 'week' | 'month' | 'year';

/** Number of days each leaderboard window looks back (rolling window). */
const PERIOD_DAYS: Record<LeaderboardPeriod, number> = { week: 7, month: 30, year: 365 };
const PERIOD_LABEL: Record<LeaderboardPeriod, string> = {
  week: 'Weekly',
  month: 'Monthly',
  year: 'Yearly',
};
const PERIOD_WINDOW_LABEL: Record<LeaderboardPeriod, string> = {
  week: 'Last 7 days',
  month: 'Last 30 days',
  year: 'Last 365 days',
};

interface LeaderboardEntry {
  rank: number;
  jid: string;
  name: string;
  score: number;
  reason: string;
}

/**
 * Start of the rolling window for a leaderboard period.
 */
export function getPeriodStart(period: LeaderboardPeriod, now: Date = new Date()): Date {
  return new Date(now.getTime() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
}

/**
 * Returns the most comprehensive periodic leaderboard due on the given day (IST),
 * or null on a normal day. Priority: yearly > monthly > weekly.
 *
 * This is used by the daily analytics cron to skip the daily summary on days when
 * a weekly/monthly/yearly leaderboard is posted, and by the periodic cron jobs to
 * prevent multiple leaderboard posts on the same day (e.g. Dec 31).
 */
export function getPeriodicLeaderboardType(date: Date = new Date()): LeaderboardPeriod | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';

  const month = Number(get('month'));
  const day = Number(get('day'));

  if (month === 12 && day === 31) return 'year';
  if (isLastDayOfMonthIst(date)) return 'month';
  if (get('weekday') === 'Sun') return 'week';
  return null;
}

/**
 * Number of saved daily summaries available for a group within a period.
 */
export async function countDailySummaries(groupId: string, period: LeaderboardPeriod): Promise<number> {
  const col = getDb().collection<DailySummaryDoc>('daily_summaries');
  return col.countDocuments({ groupId, dateTs: { $gte: getPeriodStart(period) } });
}

interface AggregatedMember {
  jid: string;
  name: string;
  messageCount: number;
  mvpDays: number;
}

function aggregateMembers(summaries: DailySummaryDoc[]): AggregatedMember[] {
  const map = new Map<string, AggregatedMember>();

  const ensure = (jid: string, name: string): AggregatedMember => {
    let member = map.get(jid);
    if (!member) {
      member = { jid, name: name || 'Unknown', messageCount: 0, mvpDays: 0 };
      map.set(jid, member);
    } else if (name && name !== 'Unknown') {
      member.name = name;
    }
    return member;
  };

  for (const summary of summaries) {
    for (const count of summary.senderCounts || []) {
      if (count.jid) ensure(count.jid, count.name).messageCount += count.count || 0;
    }
    if (summary.mvp?.jid) ensure(summary.mvp.jid, summary.mvp.name).mvpDays += 1;
  }

  return Array.from(map.values());
}

/**
 * Deterministic fallback ranking used when Gemini is unavailable.
 * Raw score = message count + a bonus for every day the member was the MVP,
 * then normalized so the top member scores 100 (matching Gemini's 0-100 scale).
 */
function buildFallbackLeaderboard(summaries: DailySummaryDoc[]): LeaderboardEntry[] {
  const scored = aggregateMembers(summaries).map((member) => ({
    jid: member.jid,
    name: member.name,
    messageCount: member.messageCount,
    mvpDays: member.mvpDays,
    raw: member.messageCount + member.mvpDays * 15,
  }));

  const maxRaw = scored.reduce((max, member) => Math.max(max, member.raw), 0) || 1;

  return scored
    .map((member) => ({
      rank: 0,
      jid: member.jid,
      name: member.name,
      score: Math.round((member.raw / maxRaw) * 100),
      reason:
        member.mvpDays > 0
          ? `Most active contributor — ${member.messageCount} messages and ${member.mvpDays} MVP day(s).`
          : `Active contributor with ${member.messageCount} messages this period.`,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Asks Gemini to rank the top 5 contributors from the saved daily summaries.
 * Returns null when every model fails so the caller can use the fallback.
 */
async function generateLeaderboardWithGemini(
  period: LeaderboardPeriod,
  summaries: DailySummaryDoc[]
): Promise<LeaderboardEntry[] | null> {
  const digest = summaries
    .map((s) => {
      const mvp = s.mvp?.jid
        ? `MVP: ${s.mvp.name} (${s.mvp.jid}) — ${s.mvp.reason}`
        : 'MVP: none';
      const counts = (s.senderCounts || [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((c) => `${c.name} (${c.jid}): ${c.count} msgs`)
        .join(', ');
      const points = (s.summary || []).map((p) => `- ${p}`).join('\n');
      return `### ${s.date} — ${s.totalMessages} messages from ${s.participantCount} participants\n${mvp}\nActivity: ${counts || 'n/a'}\nDaily summary:\n${points || '- n/a'}`;
    })
    .join('\n\n');

  const prompt = `You are a witty but fair group-chat performance analyst. Below are the saved DAILY SUMMARIES for one WhatsApp group over the past ${PERIOD_DAYS[period]} days (${PERIOD_WINDOW_LABEL[period]}).

--- DAILY SUMMARIES ---
${digest}
--- END OF DAILY SUMMARIES ---

Rank the TOP 5 group members by their overall CONTRIBUTION SCORE for this ${period}.

Consider ALL of the following (do not rank on message count alone):
- How active they were across the period (message counts above).
- How often they were picked as the daily MVP / most valuable contributor, and why.
- The quality and impact of what they discussed, as described in the daily summaries.
A member who consistently carried the group with value should rank high. Someone who only spammed low-effort messages should NOT outrank a genuinely valuable contributor.

Return ONLY valid JSON in exactly this shape (no markdown, no prose):
{
  "leaderboard": [
    { "rank": 1, "jid": "number@s.whatsapp.net", "name": "Display Name", "score": 92, "reason": "Short, punchy reason" }
  ]
}

Rules:
- Return at most 5 entries and at least 1.
- Ranks must be 1..N with no ties; score is an integer 0-100 (higher = better rank).
- Use the exact JIDs and display names as they appear above.
- Each reason must be brief (one line), specific, and slightly fun.`;

  const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
  const MAX_RETRIES_PER_MODEL = 2;
  let aiResponseText = '';

  modelLoop: for (const modelName of modelsToTry) {
    const model = ai.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json' },
    });
    console.log(`[Leaderboard] Trying Gemini model: ${modelName}`);

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        aiResponseText = result.response.text();
        console.log(`[Leaderboard] Success with model: ${modelName}`);
        break modelLoop;
      } catch (apiErr: any) {
        const status = apiErr?.status || apiErr?.response?.status;
        const errMsg = apiErr?.message || '';
        const isRetryable =
          status === 503 || status === 429 ||
          errMsg.includes('503') || errMsg.includes('429') ||
          errMsg.includes('Service Unavailable') || errMsg.includes('high demand');

        if (isRetryable && attempt < MAX_RETRIES_PER_MODEL) {
          const backoffMs = 3000 * Math.pow(2, attempt - 1);
          console.warn(`[Leaderboard] Model ${modelName} retryable error (status: ${status || 'unknown'}), retrying in ${backoffMs / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        } else {
          console.warn(`[Leaderboard] Model ${modelName} failed on attempt ${attempt}: ${errMsg}`);
          break;
        }
      }
    }
  }

  if (!aiResponseText) {
    console.error('[Leaderboard] All Gemini models failed to generate content.');
    return null;
  }

  console.log('[Leaderboard] Gemini raw response:', aiResponseText);

  let parsed: any = null;
  try {
    parsed = JSON.parse(aiResponseText);
  } catch {
    const match = aiResponseText.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
    }
  }

  const rawEntries: any[] = Array.isArray(parsed?.leaderboard)
    ? parsed.leaderboard
    : Array.isArray(parsed) ? parsed : [];

  const entries: LeaderboardEntry[] = rawEntries
    .filter((e) => e && typeof e.jid === 'string' && e.jid.includes('@'))
    .slice(0, 5)
    .map((e, index) => ({
      rank: Number.isFinite(Number(e.rank)) ? Number(e.rank) : index + 1,
      jid: e.jid,
      name: typeof e.name === 'string' && e.name.trim() ? e.name : 'Unknown',
      score: Math.max(0, Math.min(100, Math.round(Number(e.score) || 0))),
      reason:
        typeof e.reason === 'string' && e.reason.trim()
          ? e.reason
          : 'Contributed to the group this period.',
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return entries.length > 0 ? entries : null;
}

function formatLeaderboardMessage(
  period: LeaderboardPeriod,
  entries: LeaderboardEntry[],
  source: 'gemini' | 'fallback'
): string {
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const lines = entries
    .map((entry, index) => {
      const medal = medals[index] || `${entry.rank}.`;
      const mention = entry.jid ? `@${entry.jid.split('@')[0]}` : entry.name;
      return `${medal} *${mention}* (${entry.name}) — *${entry.score} pts*\n   _${entry.reason}_`;
    })
    .join('\n\n');

  const footer =
    source === 'gemini'
      ? '_Generated automatically using Gemini AI_ 🤖'
      : '_Ranked from message activity — Gemini was unavailable_ 📊';

  return `🏆 *${PERIOD_LABEL[period]} Group Leaderboard* 🏆
📅 _${PERIOD_WINDOW_LABEL[period]}_
━━━━━━━━━━━━━━━━━━━━━━━━

${lines}

━━━━━━━━━━━━━━━━━━━━━━━━
${footer}`;
}

/**
 * Builds and posts the leaderboard for a single group over the given period.
 * Uses a Gemini ranking pass and falls back to a deterministic ranking on failure.
 */
export async function runPeriodicLeaderboard(
  sock: any,
  groupId: string,
  period: LeaderboardPeriod
): Promise<void> {
  const { sendHumanLikeResponse } = await import('../commands');

  try {
    const col = getDb().collection<DailySummaryDoc>('daily_summaries');
    const summaries = await col
      .find({ groupId, dateTs: { $gte: getPeriodStart(period) } })
      .sort({ dateTs: 1 })
      .toArray();

    if (summaries.length === 0) {
      console.log(`[Leaderboard] No daily summaries for ${groupId} in the ${period} window — skipping.`);
      await sendHumanLikeResponse(sock, groupId, {
        text: `⚠️ *Not enough data for the ${PERIOD_LABEL[period].toLowerCase()} leaderboard yet.*\nNo saved daily summaries were found for this ${period}. I need at least one day of analytics first.`,
      });
      return;
    }

    console.log(`[Leaderboard] Building ${period} leaderboard for ${groupId} from ${summaries.length} day(s).`);

    let entries = await generateLeaderboardWithGemini(period, summaries);
    let source: 'gemini' | 'fallback' = 'gemini';
    if (!entries) {
      console.warn(`[Leaderboard] Gemini ranking failed for ${groupId} — using deterministic fallback.`);
      entries = buildFallbackLeaderboard(summaries);
      source = 'fallback';
    }

    if (entries.length === 0) {
      await sendHumanLikeResponse(sock, groupId, {
        text: `⚠️ *Could not build the ${period} leaderboard.* No active members were found in the saved summaries.`,
      });
      return;
    }

    const mentions = entries.map((e) => e.jid).filter(Boolean);
    await sendHumanLikeResponse(sock, groupId, {
      text: formatLeaderboardMessage(period, entries, source),
      mentions,
    });
    console.log(`[Leaderboard] Sent ${period} leaderboard to group ${groupId} (${entries.length} entries).`);
  } catch (err) {
    console.error(`[Leaderboard] Error building ${period} leaderboard for ${groupId}:`, err);
  }
}

/**
 * Runs the periodic leaderboard for every group that has saved daily summaries
 * within the period window. Used by the weekly/monthly/yearly cron jobs.
 */
export async function runAllPeriodicLeaderboards(sock: any, period: LeaderboardPeriod): Promise<void> {
  const col = getDb().collection<DailySummaryDoc>('daily_summaries');
  const groups = await col
    .aggregate([
      { $match: { dateTs: { $gte: getPeriodStart(period) } } },
      { $group: { _id: '$groupId' } },
    ])
    .toArray();

  console.log(`[Leaderboard] Running ${period} leaderboard for ${groups.length} group(s).`);
  for (const group of groups) {
    await runPeriodicLeaderboard(sock, group._id as string, period);
  }
}
