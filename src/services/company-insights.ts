import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { getDb } from '../db/mongodb';
import { getDirectoryEntry, CompanyDirectoryEntry } from './company-directory';

/**
 * Real-world, public-facing facts about a company surfaced by `/company <name>`.
 * Every field is optional because the free data sources don't cover every company.
 */
export interface CompanyInsights {
  /** Approximate total employee headcount (from Wikidata, else Gemini). */
  employeeStrength?: number;
  /** Number of currently open roles (from a public ATS board, else Gemini). */
  openRolesCount?: number;
  /** Official careers / jobs page URL. */
  careersLink?: string;
}

interface CompanyInsightsDoc extends CompanyInsights {
  _id: string; // normalized company key
  displayName?: string;
  fetchedAt: Date;
}

/** Cached results are considered fresh for 24 hours. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-request timeout so a slow third-party API can't stall the command. */
const HTTP_TIMEOUT_MS = 3500;

const USER_AGENT = 'BlenderRevive-ReferralBot/1.0 (+https://github.com/crysosancher)';

/**
 * Normalizes a company name into a stable cache key.
 */
function toInsightsKey(input: string): string {
  return (input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Fetches JSON with a hard timeout. Returns null on any network/parse failure so
 * callers can fall back gracefully instead of surfacing an error to the user.
 */
async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Employee strength from Wikidata (property P1128 "number of employees").
 * Free, no API key. Prefers `preferred` rank statements and, among those, the
 * most recent `point in time` (P585) qualifier.
 */
async function fetchEmployeeStrengthFromWikidata(displayName: string): Promise<number | undefined> {
  if (!displayName) return undefined;

  const searchUrl =
    'https://www.wikidata.org/w/api.php?action=wbsearchentities' +
    `&search=${encodeURIComponent(displayName)}&language=en&format=json&limit=1&type=item`;
  const search = await fetchJson(searchUrl);
  const qid: string | undefined = search?.search?.[0]?.id;
  if (!qid) return undefined;

  const entityUrl =
    'https://www.wikidata.org/w/api.php?action=wbgetentities' +
    `&ids=${qid}&props=claims&format=json`;
  const entity = await fetchJson(entityUrl);
  const claims: any[] = entity?.entities?.[qid]?.claims?.P1128;
  if (!Array.isArray(claims) || claims.length === 0) return undefined;

  const withValue = claims.filter((c) => c?.mainsnak?.datavalue?.value?.amount !== undefined);
  if (withValue.length === 0) return undefined;

  const preferred = withValue.filter((c) => c.rank === 'preferred');
  const pool = preferred.length > 0 ? preferred : withValue;
  pool.sort((a, b) => {
    const ta = a?.qualifiers?.P585?.[0]?.datavalue?.value?.time || '';
    const tb = b?.qualifiers?.P585?.[0]?.datavalue?.value?.time || '';
    return tb.localeCompare(ta);
  });

  const amount = pool[0]?.mainsnak?.datavalue?.value?.amount;
  const parsed = parseInt(String(amount).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Live open-role count from a public ATS job board. No API key required.
 * Supports Greenhouse, Lever, Ashby and SmartRecruiters.
 */
async function fetchOpenRolesFromAts(entry?: CompanyDirectoryEntry): Promise<number | undefined> {
  if (!entry?.atsType || !entry?.boardToken) return undefined;

  let url: string;
  switch (entry.atsType) {
    case 'greenhouse':
      url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.boardToken)}/jobs`;
      break;
    case 'lever':
      url = `https://api.lever.co/v0/postings/${encodeURIComponent(entry.boardToken)}?mode=json`;
      break;
    case 'ashby':
      url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(entry.boardToken)}`;
      break;
    case 'smartrecruiters':
      url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(entry.boardToken)}/postings`;
      break;
    default:
      return undefined;
  }

  const data = await fetchJson(url);
  if (data === null || data === undefined) return undefined;

  switch (entry.atsType) {
    case 'greenhouse':
      if (typeof data?.meta?.total === 'number') return data.meta.total;
      return Array.isArray(data?.jobs) ? data.jobs.length : undefined;
    case 'lever':
      return Array.isArray(data) ? data.length : undefined;
    case 'ashby':
      return Array.isArray(data?.jobs) ? data.jobs.length : undefined;
    case 'smartrecruiters':
      if (typeof data?.totalFound === 'number') return data.totalFound;
      return Array.isArray(data?.content) ? data.content.length : undefined;
    default:
      return undefined;
  }
}

/**
 * Gemini fallback used only for fields the free sources could not supply.
 * Unknown numeric values come back as 0 and an unknown URL as an empty string,
 * which callers treat as "unavailable".
 */
async function fetchInsightsFromGemini(displayName: string): Promise<CompanyInsights> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return {};

  // Insights are a nice-to-have, so keep this snappy: try each model once and
  // never sit in a backoff loop that would stall the WhatsApp command.
  const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];

  const prompt =
    `Provide public facts about the company "${displayName}".\n` +
    'employeeStrength = approximate total number of employees (headcount) as a plain integer.\n' +
    'openRolesCount = approximate number of currently open job positions as a plain integer.\n' +
    'careersLink = the official careers/jobs page URL (must start with http).\n' +
    'If you are not confident about a value, return 0 for numbers and an empty string for the link.';

  for (const modelName of modelsToTry) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            employeeStrength: {
              type: SchemaType.NUMBER,
              description: 'Approximate total employee headcount. Use 0 if unknown.',
            },
            openRolesCount: {
              type: SchemaType.NUMBER,
              description: 'Approximate number of currently open roles. Use 0 if unknown.',
            },
            careersLink: {
              type: SchemaType.STRING,
              description: 'Official careers/jobs page URL. Use an empty string if unknown.',
            },
          },
          required: ['employeeStrength', 'openRolesCount', 'careersLink'],
        } as any,
      },
    });

    try {
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction:
          'You are a corporate data assistant. Return factual, up-to-date values. ' +
          'Never invent a careers URL — return an empty string when unsure.',
      });

      const parsed = JSON.parse(response.response.text());
      const result: CompanyInsights = {};

      const emp = Number(parsed?.employeeStrength);
      if (Number.isFinite(emp) && emp > 0) result.employeeStrength = Math.round(emp);

      // The prompt uses 0 to mean "unknown", so only accept positive values here.
      // (A genuine zero from an ATS board is preserved separately.)
      const roles = Number(parsed?.openRolesCount);
      if (Number.isFinite(roles) && roles > 0) result.openRolesCount = Math.round(roles);

      const link = typeof parsed?.careersLink === 'string' ? parsed.careersLink.trim() : '';
      if (/^https?:\/\//i.test(link)) result.careersLink = link;

      return result;
    } catch (err: any) {
      const status = err?.status || err?.response?.status;
      const msg = err?.message || '';
      console.warn(`[Insights] Gemini ${modelName} failed (${status ?? 'n/a'}): ${msg}`);
      // Fall through to the next model.
    }
  }

  return {};
}

/**
 * Fetches employee strength, open-role count and careers link for a company.
 *
 * Strategy (cheapest & most reliable first):
 *   1. MongoDB cache (24h TTL)
 *   2. Wikidata -> employee strength   (free, no key)
 *   3. Public ATS board -> open roles  (free, no key, when known)
 *   4. Static directory -> careers link
 *   5. Gemini -> fills any remaining gaps
 *
 * Never throws: missing data is simply omitted so the command can render "—".
 */
export async function fetchCompanyInsights(
  canonicalName: string,
  displayName: string
): Promise<CompanyInsights> {
  const name = (displayName || canonicalName || '').trim();
  if (!name) return {};

  const key = toInsightsKey(canonicalName || name);

  // 1. Cache
  let collection: any = null;
  try {
    collection = getDb().collection<CompanyInsightsDoc>('company_insights');
    const cached = await collection.findOne({ _id: key });
    if (cached?.fetchedAt) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age >= 0 && age < CACHE_TTL_MS) {
        return {
          employeeStrength: cached.employeeStrength,
          openRolesCount: cached.openRolesCount,
          careersLink: cached.careersLink,
        };
      }
    }
  } catch (err) {
    console.warn('[Insights] Cache read failed:', err);
  }

  const entry =
    getDirectoryEntry(canonicalName) ||
    getDirectoryEntry(name) ||
    getDirectoryEntry(displayName);

  // 2 + 3. Free sources in parallel
  const [wikiStrength, atsRoles] = await Promise.all([
    fetchEmployeeStrengthFromWikidata(displayName || name).catch((): number | undefined => undefined),
    fetchOpenRolesFromAts(entry).catch((): number | undefined => undefined),
  ]);

  const insights: CompanyInsights = {};
  if (typeof wikiStrength === 'number') insights.employeeStrength = wikiStrength;
  if (typeof atsRoles === 'number') insights.openRolesCount = atsRoles;
  if (entry?.careersLink) insights.careersLink = entry.careersLink;

  // 5. Gemini fallback for whatever is still missing
  const needsGemini =
    insights.employeeStrength === undefined ||
    insights.openRolesCount === undefined ||
    !insights.careersLink;

  if (needsGemini) {
    const gemini = await fetchInsightsFromGemini(displayName || name).catch(
      () => ({} as CompanyInsights)
    );
    if (insights.employeeStrength === undefined && gemini.employeeStrength !== undefined) {
      insights.employeeStrength = gemini.employeeStrength;
    }
    if (insights.openRolesCount === undefined && gemini.openRolesCount !== undefined) {
      insights.openRolesCount = gemini.openRolesCount;
    }
    if (!insights.careersLink && gemini.careersLink) {
      insights.careersLink = gemini.careersLink;
    }
  }

  // 4. Cache only when we actually learned something (so empty results retry next time)
  const hasAny =
    insights.employeeStrength !== undefined ||
    insights.openRolesCount !== undefined ||
    insights.careersLink !== undefined;

  if (hasAny && collection) {
    try {
      await collection.updateOne(
        { _id: key },
        {
          $set: {
            ...insights,
            _id: key,
            displayName: displayName || name,
            fetchedAt: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(
        `[Insights] Cached "${name}" (employees=${insights.employeeStrength ?? '—'}, ` +
        `roles=${insights.openRolesCount ?? '—'}, careers=${insights.careersLink ?? '—'})`
      );
    } catch (err) {
      console.warn('[Insights] Cache write failed:', err);
    }
  }

  return insights;
}
