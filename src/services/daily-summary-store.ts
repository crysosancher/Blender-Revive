import { getDb } from '../db/mongodb';

/**
 * Timezone used by all cron jobs and "day" boundaries for this bot.
 * The nightly analytics cron runs at 23:00 IST, so we use IST consistently.
 */
export const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * A single persisted daily analytics result for one group.
 * Written by runGroupAnalytics() and later aggregated by the leaderboard service.
 */
export interface DailySummaryDoc {
  _id: string; // `${groupId}_${date}` (YYYY-MM-DD in IST) — idempotent per group per day
  groupId: string;
  date: string; // YYYY-MM-DD in IST
  dateTs: Date; // UTC instant representing 00:00 IST of that day (for range queries)
  totalMessages: number;
  participantCount: number;
  mvp: { jid: string; name: string; reason: string };
  annoying: { topic: string; jid: string; name: string; reason: string };
  summary: string[];
  senderCounts: Array<{ jid: string; name: string; count: number }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveDailySummaryInput {
  groupId: string;
  totalMessages: number;
  participantCount: number;
  mvp: { jid: string; name: string; reason: string };
  annoying: { topic: string; jid: string; name: string; reason: string };
  summary: string[];
  senderCounts: Array<{ jid: string; name: string; count: number }>;
}

/**
 * Formats a Date as a `YYYY-MM-DD` string in IST.
 * Built from formatToParts so it is stable across ICU/locale differences.
 */
export function getIstDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Returns the UTC Date that corresponds to 00:00:00 IST for the given day.
 * Used for efficient `dateTs >= start` range queries.
 */
export function getIstDayStart(date: Date = new Date()): Date {
  // IST is a fixed UTC+05:30 offset (no DST), so an explicit offset is safe.
  return new Date(`${getIstDateString(date)}T00:00:00+05:30`);
}

/**
 * Returns true if the given date is the last day of its month in IST.
 */
export function isLastDayOfMonthIst(date: Date = new Date()): boolean {
  const tomorrow = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  return getIstDateString(tomorrow).slice(8, 10) === '01';
}

let indexesEnsured = false;

/**
 * Ensures the indexes needed for fast leaderboard range queries exist.
 * Safe to call repeatedly; the underlying createIndex calls are idempotent.
 */
async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  try {
    const col = getDb().collection<DailySummaryDoc>('daily_summaries');
    await col.createIndex({ groupId: 1, dateTs: -1 });
    indexesEnsured = true;
  } catch (err) {
    // Index creation is an optimization only — never block persistence on it.
    console.error('[DailySummary] Failed to create indexes:', err);
  }
}

/**
 * Upserts the daily analytics result for a group.
 *
 * Idempotent: re-running analytics for the same group on the same IST day
 * overwrites the previous document instead of creating a duplicate.
 */
export async function saveDailySummary(input: SaveDailySummaryInput): Promise<void> {
  try {
    const db = getDb();
    const col = db.collection<DailySummaryDoc>('daily_summaries');

    const now = new Date();
    const date = getIstDateString(now);
    const _id = `${input.groupId}_${date}`;
    const dateTs = getIstDayStart(now);

    await col.updateOne(
      { _id } as any,
      {
        $set: {
          groupId: input.groupId,
          date,
          dateTs,
          totalMessages: input.totalMessages,
          participantCount: input.participantCount,
          mvp: input.mvp,
          annoying: input.annoying,
          summary: input.summary,
          senderCounts: input.senderCounts,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    await ensureIndexes();
    console.log(`[DailySummary] Saved daily summary for ${input.groupId} on ${date}.`);
  } catch (err) {
    // Persistence must never break the analytics report that was already posted.
    console.error('[DailySummary] Failed to persist daily summary:', err);
  }
}
