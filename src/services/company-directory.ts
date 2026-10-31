/**
 * Static directory of well-known companies -> careers information and, where the
 * company uses a public applicant-tracking system (ATS), the board coordinates
 * needed to fetch a live count of open roles (no API key required).
 *
 * Lookup keys are normalized (uppercase, non-alphanumerics -> "_"), so
 * "Tata Consultancy Services", "tata_consultancy_services" and "TCS" all match.
 */

export type AtsType = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';

export interface CompanyDirectoryEntry {
  /** Official careers / jobs page. */
  careersLink?: string;
  /** Public ATS that hosts the company's job board, if known. */
  atsType?: AtsType;
  /** Board identifier used by the ATS public API. */
  boardToken?: string;
}

/**
 * Normalizes a company name into a stable lookup key.
 */
export function toDirectoryKey(input: string): string {
  return (input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const RAW_DIRECTORY: Record<string, CompanyDirectoryEntry> = {
  // ── Big Tech (custom careers sites) ─────────────────────────────
  GOOGLE: { careersLink: 'https://careers.google.com' },
  ALPHABET: { careersLink: 'https://careers.google.com' },
  MICROSOFT: { careersLink: 'https://careers.microsoft.com' },
  AMAZON: { careersLink: 'https://www.amazon.jobs' },
  AMAZON_WEB_SERVICES: { careersLink: 'https://www.amazon.jobs/en/teams/aws' },
  AWS: { careersLink: 'https://www.amazon.jobs/en/teams/aws' },
  META: { careersLink: 'https://www.metacareers.com' },
  FACEBOOK: { careersLink: 'https://www.metacareers.com' },
  APPLE: { careersLink: 'https://jobs.apple.com' },
  NETFLIX: { careersLink: 'https://jobs.netflix.com' },
  NVIDIA: { careersLink: 'https://www.nvidia.com/en-us/about-nvidia/careers/' },
  INTEL: { careersLink: 'https://jobs.intel.com' },
  AMD: { careersLink: 'https://jobs.amd.com' },
  IBM: { careersLink: 'https://www.ibm.com/careers' },
  ORACLE: { careersLink: 'https://careers.oracle.com' },
  SALESFORCE: { careersLink: 'https://careers.salesforce.com' },
  SAP: { careersLink: 'https://jobs.sap.com' },
  CISCO: { careersLink: 'https://jobs.cisco.com' },
  ADOBE: { careersLink: 'https://careers.adobe.com' },
  UBER: { careersLink: 'https://www.uber.com/careers' },
  ATLASSIAN: { careersLink: 'https://www.atlassian.com/company/careers' },

  // ── Public ATS boards (live open-role counts) ──────────────────
  AIRBNB: { careersLink: 'https://careers.airbnb.com', atsType: 'greenhouse', boardToken: 'airbnb' },
  COINBASE: { careersLink: 'https://www.coinbase.com/careers', atsType: 'greenhouse', boardToken: 'coinbase' },
  DROPBOX: { careersLink: 'https://jobs.dropbox.com', atsType: 'greenhouse', boardToken: 'dropbox' },
  REDDIT: { careersLink: 'https://redditinc.com/careers', atsType: 'greenhouse', boardToken: 'reddit' },
  PINTEREST: { careersLink: 'https://careers.pinterest.com', atsType: 'greenhouse', boardToken: 'pinterest' },
  ROBINHOOD: { careersLink: 'https://careers.robinhood.com', atsType: 'greenhouse', boardToken: 'robinhood' },
  INSTACART: { careersLink: 'https://instacart.careers', atsType: 'greenhouse', boardToken: 'instacart' },
  FIGMA: { careersLink: 'https://www.figma.com/careers', atsType: 'greenhouse', boardToken: 'figma' },
  FLEXPORT: { careersLink: 'https://www.flexport.com/careers', atsType: 'greenhouse', boardToken: 'flexport' },
  STRIPE: { careersLink: 'https://stripe.com/jobs', atsType: 'greenhouse', boardToken: 'stripe' },
  DISCORD: { careersLink: 'https://discord.com/careers', atsType: 'greenhouse', boardToken: 'discord' },
  OPENAI: { careersLink: 'https://openai.com/careers', atsType: 'ashby', boardToken: 'openai' },
  RAMP: { careersLink: 'https://ramp.com/careers', atsType: 'ashby', boardToken: 'ramp' },
  LINEAR: { careersLink: 'https://linear.app/careers', atsType: 'ashby', boardToken: 'linear' },
  CANVA: { careersLink: 'https://www.lifeatcanva.com', atsType: 'smartrecruiters', boardToken: 'Canva' },

  // ── Indian IT / Consulting ─────────────────────────────────────
  TATA_CONSULTANCY_SERVICES: { careersLink: 'https://www.tcs.com/careers' },
  TCS: { careersLink: 'https://www.tcs.com/careers' },
  INFOSYS: { careersLink: 'https://www.infosys.com/careers' },
  WIPRO: { careersLink: 'https://careers.wipro.com' },
  HCL_TECHNOLOGIES: { careersLink: 'https://www.hcltech.com/careers' },
  HCL: { careersLink: 'https://www.hcltech.com/careers' },
  TECH_MAHINDRA: { careersLink: 'https://careers.techmahindra.com' },
  COGNIZANT: { careersLink: 'https://careers.cognizant.com' },
  ACCENTURE: { careersLink: 'https://www.accenture.com/careers' },
  CAPGEMINI: { careersLink: 'https://www.capgemini.com/careers' },
  MPHASIS: { careersLink: 'https://www.mphasis.com/home/careers.html' },
  COFORGE: { careersLink: 'https://www.coforge.com/careers' },
  PERSISTENT_SYSTEMS: { careersLink: 'https://www.persistent.com/careers' },
  LTIMINDTREE: { careersLink: 'https://www.ltimindtree.com/careers' },
  LTI_MINDTREE: { careersLink: 'https://www.ltimindtree.com/careers' },

  // ── Consulting / Finance ───────────────────────────────────────
  GOLDMAN_SACHS: { careersLink: 'https://www.goldmansachs.com/careers' },
  JPMORGAN_CHASE: { careersLink: 'https://careers.jpmorgan.com' },
  MORGAN_STANLEY: { careersLink: 'https://www.morganstanley.com/careers' },
  DEUTSCHE_BANK: { careersLink: 'https://careers.db.com' },
  BANK_OF_AMERICA: { careersLink: 'https://careers.bankofamerica.com' },
  CITIBANK: { careersLink: 'https://jobs.citi.com' },
  CITI: { careersLink: 'https://jobs.citi.com' },
  BARCLAYS: { careersLink: 'https://home.barclays/careers' },
  HSBC: { careersLink: 'https://www.hsbc.com/careers' },
  UBS: { careersLink: 'https://www.ubs.com/careers' },
  DELOITTE: { careersLink: 'https://www.deloitte.com/careers' },
  PRICEWATERHOUSECOOPERS: { careersLink: 'https://www.pwc.com/careers' },
  PWC: { careersLink: 'https://www.pwc.com/careers' },
  ERNST_AND_YOUNG: { careersLink: 'https://www.ey.com/careers' },
  EY: { careersLink: 'https://www.ey.com/careers' },
  KPMG: { careersLink: 'https://kpmg.com/careers' },
  MCKINSEY: { careersLink: 'https://www.mckinsey.com/careers' },
  BOSTON_CONSULTING_GROUP: { careersLink: 'https://careers.bcg.com' },
  BCG: { careersLink: 'https://careers.bcg.com' },
  BAIN_AND_COMPANY: { careersLink: 'https://www.bain.com/careers' },
  BAIN: { careersLink: 'https://www.bain.com/careers' },
  BDO_INDIA: { careersLink: 'https://www.bdo.in/careers' },
  BDO: { careersLink: 'https://www.bdo.in/careers' },

  // ── Indian Startups / Product ──────────────────────────────────
  ZOMATO: { careersLink: 'https://www.zomato.com/careers' },
  SWIGGY: { careersLink: 'https://careers.swiggy.com' },
  RAZORPAY: { careersLink: 'https://razorpay.com/jobs' },
  CRED: { careersLink: 'https://careers.cred.club' },
  ZERODHA: { careersLink: 'https://zerodha.com/careers' },
  GROWW: { careersLink: 'https://groww.in/careers' },
  MEESHO: { careersLink: 'https://www.meesho.io/jobs' },
  FLIPKART: { careersLink: 'https://www.flipkartcareers.com' },
  PAYTM: { careersLink: 'https://paytm.com/careers' },
  PHONEPE: { careersLink: 'https://www.phonepe.com/careers' },
  DREAM11: { careersLink: 'https://www.dream11.com/careers' },
  FRESHWORKS: { careersLink: 'https://www.freshworks.com/company/careers' },
  ZOHO: { careersLink: 'https://www.zoho.com/careers' },
  JUSPAY: { careersLink: 'https://juspay.io/careers' },
  SPRINKLR: { careersLink: 'https://www.sprinklr.com/careers/dream-jobs' },
};

// Build a normalized lookup table once at module load.
const DIRECTORY: Map<string, CompanyDirectoryEntry> = new Map();
for (const [key, entry] of Object.entries(RAW_DIRECTORY)) {
  DIRECTORY.set(toDirectoryKey(key), entry);
}

/**
 * Returns the directory entry for a company, or undefined when unknown.
 * Accepts canonical names ("Tata_Consultancy_Services"), display names
 * ("Tata Consultancy Services") and common aliases ("TCS").
 */
export function getDirectoryEntry(name: string): CompanyDirectoryEntry | undefined {
  if (!name) return undefined;

  const direct = DIRECTORY.get(toDirectoryKey(name));
  if (direct) return direct;

  // Try stripping common corporate suffixes so "Infosys Limited" -> "INFOSYS".
  const stripped = name
    .replace(
      /\b(limited|ltd|llc|inc|incorporated|corp|corporation|co|plc|llp|private|pvt|gmbh|technologies|technology|services|solutions)\b/gi,
      ' '
    )
    .trim();

  if (stripped && stripped !== name) {
    const strippedEntry = DIRECTORY.get(toDirectoryKey(stripped));
    if (strippedEntry) return strippedEntry;
  }

  return undefined;
}
