import { createHash } from 'crypto';
import { getDb } from './mongodb';

export interface CommandUsageEvent {
  commandName: string;
  senderJid: string;
  isGroup: boolean;
  groupId?: string;
  success: boolean;
}

function hashJid(jid: string): string {
  const salt = process.env.USAGE_HASH_SALT || 'blenderrevive';
  return createHash('sha256').update(`${salt}:${jid}`).digest('hex').slice(0, 24);
}

export async function logCommandUsage(event: CommandUsageEvent): Promise<void> {
  try {
    const db = getDb();
    await db.collection('command_usage').insertOne({
      commandName: event.commandName,
      senderJidHash: hashJid(event.senderJid),
      isGroup: event.isGroup,
      groupId: event.isGroup ? event.groupId : undefined,
      success: event.success,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[Analytics] Failed to log command usage:', err);
  }
}
