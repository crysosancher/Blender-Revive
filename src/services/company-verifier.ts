import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { getDb } from '../db/mongodb';

export interface CompanyVerificationDoc {
  _id: string; // Sanitized input name in uppercase (e.g., "TCS" or "TATA_CONSULTANCY")
  canonicalName: string; // Normalized name (e.g., "Tata_Consultancy_Services")
  displayName: string; // Human-friendly name (e.g., "Tata Consultancy Services")
  status: 'registered' | 'unregistered';
  rank: 'A' | 'B' | 'unranked';
  justification: string;
  verifiedAt: Date;
}

// Local fallback database for common normalizations when Gemini API key is missing or fails
const LOCAL_FALLBACKS: Record<string, { canonicalName: string; displayName: string; status: 'registered' | 'unregistered'; rank: 'A' | 'B' | 'unranked'; justification: string }> = {
  'TCS': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'TATA_CONSULTANCY': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'TATA_CONSULTANCY_SERVICES': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'GOOGLE': {
    canonicalName: 'Google',
    displayName: 'Google',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology giant.'
  },
  'MICROSOFT': {
    canonicalName: 'Microsoft',
    displayName: 'Microsoft',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology giant.'
  },
  'AMAZON': {
    canonicalName: 'Amazon',
    displayName: 'Amazon',
    status: 'registered',
    rank: 'A',
    justification: 'Global e-commerce and cloud giant.'
  },
  'META': {
    canonicalName: 'Meta',
    displayName: 'Meta',
    status: 'registered',
    rank: 'A',
    justification: 'Global social media and technology giant.'
  },
  'INFOSYS': {
    canonicalName: 'Infosys',
    displayName: 'Infosys',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'STUDENT': {
    canonicalName: 'Student',
    displayName: 'Student',
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Academic profile registration.'
  },
  'UNEMPLOYED': {
    canonicalName: 'Unemployed',
    displayName: 'Unemployed',
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Profile registered under Unemployed.'
  }
};

/**
 * Standardizes raw input to an uppercase lookup key.
 */
function toLookupKey(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '_');
}

/**
 * Normalizes a company name using local fallback rules.
 */
function resolveLocalFallback(rawName: string): Omit<CompanyVerificationDoc, '_id' | 'verifiedAt'> {
  const key = toLookupKey(rawName);
  if (LOCAL_FALLBACKS[key]) {
    return LOCAL_FALLBACKS[key];
  }

  // Generic formatting fallback
  const cleanName = rawName
    .trim()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('_');

  const cleanDisplayName = cleanName.replace(/_/g, ' ');

  // Student/Unemployed checks
  const lower = rawName.toLowerCase();
  if (lower.includes('student')) {
    return {
      canonicalName: 'Student',
      displayName: 'Student',
      status: 'unregistered',
      rank: 'unranked',
      justification: 'Identified as student profile.'
    };
  }
  if (lower.includes('unemployed')) {
    return {
      canonicalName: 'Unemployed',
      displayName: 'Unemployed',
      status: 'unregistered',
      rank: 'unranked',
      justification: 'Identified as unemployed profile.'
    };
  }

  return {
    canonicalName: cleanName,
    displayName: cleanDisplayName,
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Local fallback formatting applied; unregistered entity.'
  };
}

/**
 * Verifies and normalizes a company name using Gemini API with structured JSON output.
 * Falls back to local formatting / heuristics if the API fails or key is missing.
 */
export async function verifyAndNormalizeCompany(companyName: string): Promise<CompanyVerificationDoc> {
  const db = getDb();
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');
  const lookupKey = toLookupKey(companyName);

  // 1. Check database cache first (by raw lookup key or matching canonicalName)
  const cached = await verificationsCol.findOne({
    $or: [
      { _id: lookupKey },
      { canonicalName: companyName },
      { canonicalName: companyName.replace(/_/g, ' ') },
      { canonicalName: companyName.replace(/\s+/g, '_') }
    ]
  } as any);
  if (cached) {
    console.log(`[Verifier] Cache HIT for: "${companyName}" -> ${cached.canonicalName} (${cached.rank})`);
    return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  let resolved: Omit<CompanyVerificationDoc, '_id' | 'verifiedAt'>;

  if (!apiKey) {
    console.warn(`[Verifier] GEMINI_API_KEY not found in environment. Using local fallback rules.`);
    resolved = resolveLocalFallback(companyName);
  } else {
    try {
      console.log(`[Verifier] Cache MISS. Querying Gemini for: "${companyName}"...`);
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-flash-latest', // High performance, fast, and structured output support
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              canonicalName: {
                type: SchemaType.STRING,
                description: 'The standardized canonical name of the company in Title_Case_With_Underscores. Examples: "Tata_Consultancy_Services" for TCS or Tata Consultancy, "Google" for Google, "Razorpay" for Razorpay, "Student" for students, "Unemployed" for unemployed.',
              },
              displayName: {
                type: SchemaType.STRING,
                description: 'Human-readable, properly capitalized company name (e.g. "Tata Consultancy Services" or "Google").',
              },
              status: {
                type: SchemaType.STRING,
                enum: ['registered', 'unregistered'],
                description: 'Whether this is a real, officially registered company or organization. Select "unregistered" for invalid inputs, test/fake companies, students, or unemployed registrations.',
              },
              rank: {
                type: SchemaType.STRING,
                enum: ['A', 'B', 'unranked'],
                description: 'Rank: A = Large global or national enterprises (TCS, Google, Microsoft, Infosys, Amazon, Accenture). B = Well-known mid-sized companies, funded startups (Cred, Razorpay, Zomato, Swiggy). unranked = small local startups, personal test names, student, or unemployed.',
              },
              justification: {
                type: SchemaType.STRING,
                description: 'One sentence explaining why it was categorized this way.',
              },
            },
            required: ['canonicalName', 'displayName', 'status', 'rank', 'justification'],
          } as any,
        },
      });

      const prompt = `Analyze, normalize, and verify the company input.
Input raw company name: "${companyName}"`;

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: `You are an expert corporate registry verifier and deduplication agent. Normalize raw company names (e.g. "TCS", "tata consultancy" -> "Tata_Consultancy_Services"). Categorize them as Rank A (Fortune 500, major MNCs, national giants), Rank B (funded startups, established mid-size companies), or unranked (small startups, test entries, students, unemployed). Ensure canonicalName uses Title_Case_With_Underscores.`,
      });

      const responseText = response.response.text();
      const parsed = JSON.parse(responseText);

      // Sanitize the canonical name format to ensure underscores and correct characters
      const sanitizedCanonical = parsed.canonicalName
        .trim()
        .replace(/[\s]+/g, '_');

      resolved = {
        canonicalName: sanitizedCanonical,
        displayName: parsed.displayName,
        status: parsed.status,
        rank: parsed.rank,
        justification: parsed.justification,
      };
    } catch (err) {
      console.error(`[Verifier] Gemini verification failed for "${companyName}". Falling back to local rules:`, err);
      resolved = resolveLocalFallback(companyName);
    }
  }

  // 2. Cache result in MongoDB
  const verificationResult: CompanyVerificationDoc = {
    _id: lookupKey,
    ...resolved,
    verifiedAt: new Date()
  };

  try {
    await verificationsCol.updateOne(
      { _id: lookupKey },
      { $set: verificationResult },
      { upsert: true }
    );
    console.log(`[Verifier] Cached result for "${companyName}" -> ${verificationResult.canonicalName}`);
  } catch (dbErr) {
    console.error(`[Verifier] Failed to cache verification for "${companyName}":`, dbErr);
  }

  return verificationResult;
}

/**
 * Normalizes all company names currently in the database to their canonical values.
 * Uses a SINGLE batch Gemini API call for all uncached companies to avoid rate limits.
 * Cached companies are skipped (no API call needed).
 */
export async function runDatabaseCompanyNormalization(): Promise<{ checked: number; updatedReferrals: number; apiCalls: number }> {
  const db = getDb();
  const referralsCollection = db.collection('referrals');
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');

  // 1. Fetch all distinct company values currently in the referrals collection
  const rawCompanies: string[] = await referralsCollection.distinct('company', { deletedAt: { $exists: false } });
  
  let checked = rawCompanies.length;
  let updatedReferrals = 0;
  let apiCalls = 0;

  // 2. Separate into cached and uncached companies
  const uncachedNames: string[] = [];
  const cachedResults: Map<string, CompanyVerificationDoc> = new Map();

  for (const rawName of rawCompanies) {
    const lookupKey = toLookupKey(rawName);
    const cached = await verificationsCol.findOne({
      $or: [
        { _id: lookupKey },
        { canonicalName: rawName },
        { canonicalName: rawName.replace(/_/g, ' ') },
        { canonicalName: rawName.replace(/\s+/g, '_') }
      ]
    } as any);
    if (cached) {
      console.log(`[Verifier] Cache HIT for: "${rawName}" -> ${cached.canonicalName} (${cached.rank})`);
      cachedResults.set(rawName, cached);
    } else {
      uncachedNames.push(rawName);
    }
  }

  console.log(`[Normalization] ${cachedResults.size} cached, ${uncachedNames.length} uncached companies to verify.`);

  // 3. If there are uncached companies, batch-verify them in ONE Gemini API call
  if (uncachedNames.length > 0) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.warn(`[Verifier] GEMINI_API_KEY not found. Using local fallback for ${uncachedNames.length} companies.`);
      for (const rawName of uncachedNames) {
        const resolved = resolveLocalFallback(rawName);
        const lookupKey = toLookupKey(rawName);
        const doc: CompanyVerificationDoc = { _id: lookupKey, ...resolved, verifiedAt: new Date() };
        try {
          await verificationsCol.updateOne({ _id: lookupKey }, { $set: doc }, { upsert: true });
          console.log(`[Verifier] Cached (fallback) "${rawName}" -> ${doc.canonicalName}`);
        } catch (dbErr) {
          console.error(`[Verifier] Failed to cache fallback for "${rawName}":`, dbErr);
        }
        cachedResults.set(rawName, doc);
      }
    } else {
      // Retry logic for rate limits
      const MAX_RETRIES = 2;
      let attempt = 0;
      let success = false;

      while (attempt <= MAX_RETRIES && !success) {
        try {
          attempt++;
          console.log(`[Verifier] Batch querying Gemini for ${uncachedNames.length} companies (attempt ${attempt}/${MAX_RETRIES + 1})...`);
          apiCalls++;

          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({
            model: 'gemini-flash-latest',
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: SchemaType.OBJECT,
                properties: {
                  companies: {
                    type: SchemaType.ARRAY,
                    items: {
                      type: SchemaType.OBJECT,
                      properties: {
                        inputName: {
                          type: SchemaType.STRING,
                          description: 'The exact input company name from the list (unchanged).',
                        },
                        canonicalName: {
                          type: SchemaType.STRING,
                          description: 'Standardized canonical name in Title_Case_With_Underscores. e.g. "Tata_Consultancy_Services" for TCS, "Google" for Google.',
                        },
                        displayName: {
                          type: SchemaType.STRING,
                          description: 'Human-readable properly capitalized name. e.g. "Tata Consultancy Services".',
                        },
                        status: {
                          type: SchemaType.STRING,
                          enum: ['registered', 'unregistered'],
                          description: 'Whether this is a real, officially registered company. "unregistered" for fake/test names, students, or unemployed.',
                        },
                        rank: {
                          type: SchemaType.STRING,
                          enum: ['A', 'B', 'unranked'],
                          description: 'A = Fortune 500, global/national enterprises. B = funded startups, established mid-size. unranked = small/unknown/student/unemployed.',
                        },
                        justification: {
                          type: SchemaType.STRING,
                          description: 'One sentence explaining the categorization.',
                        },
                      },
                      required: ['inputName', 'canonicalName', 'displayName', 'status', 'rank', 'justification'],
                    },
                  },
                },
                required: ['companies'],
              } as any,
            },
          });

          const companyList = uncachedNames.map((name, i) => `${i + 1}. "${name}"`).join('\n');

          const prompt = `Analyze, normalize, verify, and rank ALL of the following ${uncachedNames.length} company names. Return a result for each one.\n\nCompany list:\n${companyList}`;

          const response = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: `You are an expert corporate registry verifier and deduplication agent. You will receive a batch of raw company names. For EACH name, normalize it (e.g. "TCS", "tata consultancy" -> "Tata_Consultancy_Services"), determine if it's a real registered company, and rank it:
- Rank A: Fortune 500, major MNCs, national giants (TCS, Google, Microsoft, Infosys, Amazon, Accenture, Wipro, Oracle, Salesforce, etc.)
- Rank B: Well-known funded startups, established mid-size companies (Cred, Razorpay, Zomato, Swiggy, Sprinklr, etc.)
- unranked: Small local startups, unknown entities, personal/test names, students, unemployed

Rules:
- canonicalName must use Title_Case_With_Underscores format
- Deduplicate abbreviations to their full canonical form
- "Student", "Unemployed" = status: unregistered, rank: unranked
- Return the inputName EXACTLY as provided (do not modify it)
- Return one entry for EACH input company name`,
          });

          const responseText = response.response.text();
          const parsed = JSON.parse(responseText);
          const batchResults: Array<{ inputName: string; canonicalName: string; displayName: string; status: string; rank: string; justification: string }> = parsed.companies || [];

          console.log(`[Verifier] Gemini returned ${batchResults.length} results for ${uncachedNames.length} companies.`);

          // Build a lookup map from inputName -> result
          const resultMap = new Map<string, typeof batchResults[0]>();
          for (const r of batchResults) {
            resultMap.set(r.inputName, r);
          }

          // Cache each result
          for (const rawName of uncachedNames) {
            const geminiResult = resultMap.get(rawName);
            const lookupKey = toLookupKey(rawName);
            let doc: CompanyVerificationDoc;

            if (geminiResult) {
              const sanitizedCanonical = geminiResult.canonicalName.trim().replace(/[\s]+/g, '_');
              doc = {
                _id: lookupKey,
                canonicalName: sanitizedCanonical,
                displayName: geminiResult.displayName,
                status: geminiResult.status as 'registered' | 'unregistered',
                rank: geminiResult.rank as 'A' | 'B' | 'unranked',
                justification: geminiResult.justification,
                verifiedAt: new Date(),
              };
            } else {
              // Gemini didn't return this one — use local fallback
              console.warn(`[Verifier] Gemini batch missed "${rawName}". Using local fallback.`);
              const resolved = resolveLocalFallback(rawName);
              doc = { _id: lookupKey, ...resolved, verifiedAt: new Date() };
            }

            try {
              await verificationsCol.updateOne({ _id: lookupKey }, { $set: doc }, { upsert: true });
              console.log(`[Verifier] Cached "${rawName}" -> ${doc.canonicalName} (${doc.rank})`);
            } catch (dbErr) {
              console.error(`[Verifier] Failed to cache "${rawName}":`, dbErr);
            }
            cachedResults.set(rawName, doc);
          }
          success = true;
        } catch (err: any) {
          const is429 = err?.status === 429;

          if (is429 && attempt <= MAX_RETRIES) {
            // Extract retry delay from error response (default 60s)
            let waitSeconds = 60;
            if (err?.errorDetails) {
              for (const detail of err.errorDetails) {
                if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
                  const parsed = parseInt(detail.retryDelay);
                  if (!isNaN(parsed)) waitSeconds = parsed + 5; // Add 5s buffer
                }
              }
            }
            console.warn(`[Verifier] Rate limited (429). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES + 1}...`);
            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
            // Continue to next attempt
          } else {
            // Non-429 error OR retries exhausted — DO NOT cache to local fallback (prevents poisoning)
            const reason = is429
              ? `Rate limit quota exhausted after ${MAX_RETRIES + 1} attempts. Daily quota may be depleted — try again later.`
              : `Gemini API error: ${err?.message || err}`;
            console.error(`[Verifier] Batch verification FAILED: ${reason}`);
            console.error(`[Verifier] ${uncachedNames.length} companies remain UNVERIFIED. They will be retried on next run.`);
            // Don't cache anything — leave them uncached so next run re-tries
            break;
          }
        }
      }
    }
  }

  // 4. Now apply normalization: update referrals with canonical names
  for (const rawName of rawCompanies) {
    const verification = cachedResults.get(rawName);
    if (!verification) continue;

    const canonical = verification.canonicalName;
    if (rawName !== canonical) {
      try {
        const result = await referralsCollection.updateMany(
          { company: rawName, deletedAt: { $exists: false } },
          { $set: { company: canonical, updatedAt: new Date() } }
        );
        updatedReferrals += result.modifiedCount;
        if (result.modifiedCount > 0) {
          console.log(`[Normalization] Standardized "${rawName}" -> "${canonical}" (updated ${result.modifiedCount} referrals)`);
        }
      } catch (err) {
        console.error(`[Normalization] Failed to normalize "${rawName}":`, err);
      }
    }
  }

  return { checked, updatedReferrals, apiCalls };
}

/**
 * Flushes stale/fallback-cached verification entries from the database.
 * Deletes ALL entries with rank='unranked' so they can be re-verified by Gemini
 * on the next normalization run (excludes Student and Unemployed which are legitimately unranked).
 * Returns the number of deleted entries.
 */
export async function flushStaleVerifications(): Promise<number> {
  const db = getDb();
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');

  // Delete all unranked entries EXCEPT Student and Unemployed (those are legitimately unranked)
  const result = await verificationsCol.deleteMany({
    rank: 'unranked',
    canonicalName: { $nin: ['Student', 'Unemployed'] }
  });

  console.log(`[Verifier] Flushed ${result.deletedCount} stale/unranked verification entries.`);
  return result.deletedCount;
}

