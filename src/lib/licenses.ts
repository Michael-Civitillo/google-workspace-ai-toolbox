/**
 * Licences: who holds which, and which are probably being paid for and not
 * used.
 *
 * Google's licensing API answers one question: which account holds which
 * licence. It does not say how many an organisation has bought, so nothing
 * here claims to know what is spare. What it can say, by putting the licence
 * list next to the directory, is which licences sit on accounts that are
 * suspended or that nobody has signed in to for a long time.
 *
 * No Node imports and no network: the page shares these rules and the tests
 * hand them made-up tenants.
 */
import { inactiveFinding, isInactiveAt, type DirectoryAccount } from "./security-check";

export interface LicenseProduct {
  /** The product id the licensing API is asked about. */
  id: string;
  /** A fallback name. Google's own name is shown when it sends one. */
  name: string;
  /**
   * A licence of this product never counts as reclaimable: either it costs
   * nothing, or it is where an account that is no longer used belongs.
   */
  neverReclaim?: boolean;
}

/**
 * The products asked about. The API has no "list everything" call, so each is
 * asked in turn, and one this organisation doesn't have simply comes back
 * empty or unknown.
 *
 * The first three ids are from Google's product and SKU reference. The rest
 * are from memory and could not be checked from here; a wrong one costs one
 * empty request, and the names shown come from Google's answers, not from
 * this list.
 */
export const LICENSE_PRODUCTS: readonly LicenseProduct[] = [
  { id: "Google-Apps", name: "Google Workspace" },
  { id: "101031", name: "Google Workspace for Education" },
  { id: "101034", name: "Google Workspace Archived User", neverReclaim: true },
  { id: "101037", name: "Google Workspace for Education" },
  { id: "101001", name: "Cloud Identity", neverReclaim: true },
  { id: "101005", name: "Cloud Identity Premium" },
  { id: "101033", name: "Google Voice" },
];

/** Accounts idle this long are reported as probably not using their licence. */
export const LICENSE_IDLE_DAYS = 180;

const PRODUCT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function isKnownProduct(productId: unknown): productId is string {
  return typeof productId === "string" && LICENSE_PRODUCTS.some((p) => p.id === productId);
}

/** SKU ids are short codes like "1010020028" or "Google-Apps-For-Business". */
export function isValidSkuId(skuId: unknown): skuId is string {
  return typeof skuId === "string" && PRODUCT_ID_RE.test(skuId);
}

export interface LicenseAssignment {
  /** The holder's primary email, lower case. */
  user: string;
  productId: string;
  productName: string;
  skuId: string;
  skuName: string;
}

export interface SkuSummary {
  productId: string;
  productName: string;
  skuId: string;
  skuName: string;
  /** Accounts holding this licence. */
  assigned: number;
  /** Of those, how many are suspended or long idle. */
  reclaimable: number;
}

export type ReclaimReason = "suspended" | "idle";

export interface ReclaimableLicense extends LicenseAssignment {
  name: string;
  reason: ReclaimReason;
  /** Days since the last sign-in. Null when suspended, or when Google gave no date. */
  idleDays: number | null;
  /** True when the account has never been signed in to. */
  neverSignedIn: boolean;
}

export interface LicenseReport {
  skus: SkuSummary[];
  reclaimable: ReclaimableLicense[];
  /** Active accounts that hold no licence in any product that was read. */
  unlicensed: Array<{ user: string; name: string }>;
  /**
   * Licences whose holder is not in the directory listing. Counted, never
   * guessed at: it usually means an address changed between the two reads.
   */
  unknownHolders: number;
}

const skuKey = (a: { productId: string; skuId: string }) => `${a.productId}/${a.skuId}`;

/**
 * Put the licence list next to the directory.
 *
 * `allProductsRead` says whether every product could be read. When one could
 * not, "this account has no licence" is not something the data supports, so
 * no account is reported as unlicensed.
 */
export function summariseLicenses(
  assignments: readonly LicenseAssignment[],
  accounts: readonly DirectoryAccount[],
  opts: { now: number; allProductsRead: boolean }
): LicenseReport {
  const byUser = new Map(accounts.map((a) => [a.primaryEmail.toLowerCase(), a]));
  const neverReclaim = new Set(
    LICENSE_PRODUCTS.filter((p) => p.neverReclaim).map((p) => p.id)
  );

  const skus = new Map<string, SkuSummary>();
  const reclaimable: ReclaimableLicense[] = [];
  const licensed = new Set<string>();
  let unknownHolders = 0;

  for (const a of assignments) {
    const user = a.user.toLowerCase();
    licensed.add(user);
    let sku = skus.get(skuKey(a));
    if (!sku) {
      sku = {
        productId: a.productId,
        productName: a.productName,
        skuId: a.skuId,
        skuName: a.skuName,
        assigned: 0,
        reclaimable: 0,
      };
      skus.set(skuKey(a), sku);
    }
    sku.assigned++;

    const account = byUser.get(user);
    if (!account) {
      unknownHolders++;
      continue;
    }
    if (neverReclaim.has(a.productId)) continue;

    if (account.suspended && !account.archived) {
      sku.reclaimable++;
      reclaimable.push({
        ...a,
        user,
        name: account.fullName,
        reason: "suspended",
        idleDays: null,
        neverSignedIn: false,
      });
      continue;
    }
    // Shares the Security Check's definition of idle, so the two pages never
    // disagree about the same account.
    const idle = inactiveFinding(account, opts.now);
    // An account Google gives no dates for is not called idle here: taking a
    // licence away is not something to suggest on "we can't tell".
    if (idle && idle.idleDays !== null && isInactiveAt(idle, LICENSE_IDLE_DAYS)) {
      sku.reclaimable++;
      reclaimable.push({
        ...a,
        user,
        name: account.fullName,
        reason: "idle",
        idleDays: idle.idleDays,
        neverSignedIn: idle.lastLoginTime === null,
      });
    }
  }

  reclaimable.sort(
    (x, y) =>
      Number(y.reason === "suspended") - Number(x.reason === "suspended") ||
      (y.idleDays ?? 0) - (x.idleDays ?? 0) ||
      x.user.localeCompare(y.user) ||
      x.skuName.localeCompare(y.skuName)
  );

  const unlicensed = opts.allProductsRead
    ? accounts
        .filter((a) => !a.suspended && !a.archived && !licensed.has(a.primaryEmail.toLowerCase()))
        .map((a) => ({ user: a.primaryEmail.toLowerCase(), name: a.fullName }))
        .sort((x, y) => x.user.localeCompare(y.user))
    : [];

  return {
    skus: [...skus.values()].sort(
      (x, y) => y.assigned - x.assigned || x.skuName.localeCompare(y.skuName)
    ),
    reclaimable,
    unlicensed,
    unknownHolders,
  };
}

/** "Suspended", "No sign-in for 412 days", "Never signed in (created 300 days ago)". */
export function reclaimReasonText(r: ReclaimableLicense): string {
  if (r.reason === "suspended") return "Suspended";
  if (r.neverSignedIn) return `Never signed in (created ${r.idleDays} days ago)`;
  return `No sign-in for ${r.idleDays} days`;
}
