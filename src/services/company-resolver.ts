import { getDb } from '../db/mongodb';
import { getLevenshteinDistance } from '../commands';

/**
 * Represents a referral record (only the fields we care about for company resolution).
 */
export interface MinimalReferralDoc {
  _id: string;
  company: string;
  username: string;
  phoneJid?: string;
  deletedAt?: Date;
}

/**
 * Sanitizes a company name by capitalizing the first letter of each word and replacing spaces with underscores.
 */
export function sanitizeCompanyName(name: string): string {
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
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves a company name by checking for exact matches, substring matches, or close typos in the database.
 * If a match is found, returns the matched company name and a boolean indicating if it was a suggestion.
 * If no match is found, returns the sanitized input.
 */
export async function resolveCompanySanity(rawName: string): Promise<{ matched: string; isSuggested: boolean }> {
  const sanitized = sanitizeCompanyName(rawName);
  if (!sanitized) return { matched: '', isSuggested: false };

  const referralsCollection = getDb().collection<MinimalReferralDoc>('referrals');

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
