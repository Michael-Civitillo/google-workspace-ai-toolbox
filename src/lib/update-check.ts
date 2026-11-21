/**
 * "Is there a newer version?"
 *
 * Off unless the operator turns it on in App Settings. When on, the server
 * asks GitHub's public API which release of Open Admin is the newest, at most
 * twice a day, and the sidebar says so if it is newer than the one running.
 *
 * What it deliberately is not: it downloads nothing, installs nothing and
 * runs nothing. It reads two fields of the answer (the version number and
 * the release page's address), checks both for shape, and shows a link. The
 * request carries nothing about the organisation, its tenants or the person
 * signed in: a fixed address and a generic User-Agent.
 */

export const REPOSITORY = "Michael-Civitillo/google-workspace-ai-toolbox";
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

/** How long an answer is reused before GitHub is asked again. */
export const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
/** A failed check is retried sooner, but not on every page load. */
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;
const MAX_RESPONSE_CHARS = 300_000;

export type Version = [number, number, number];

/** "v0.3.0" or "0.3.0" → [0, 3, 0]. Anything else, pre-releases included, is null. */
export function parseVersion(value: unknown): Version | null {
  if (typeof value !== "string") return null;
  const match = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewer(latest: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

export interface UpdateCheckResult {
  /** The newest release, without a leading "v". Null when the check failed. */
  latest: string | null;
  updateAvailable: boolean;
  /** Where to get it. Always a page of this project's releases on github.com. */
  url: string;
  checkedAt: string;
  error: string | null;
}

/** The version this build was made from, set at build time. */
export function runningVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
}

/**
 * Where to ask. OPEN_ADMIN_UPDATE_URL replaces GitHub's address, for an
 * organisation that mirrors releases internally (and for the tests). It must
 * answer in the same shape: { "tag_name": "v1.2.3", "html_url": "..." }.
 */
export function updateCheckUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.OPEN_ADMIN_UPDATE_URL?.trim();
  if (override && /^https?:\/\//i.test(override)) return override;
  return LATEST_RELEASE_API;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Ask once. Never throws: a failure is a result with `error` set, because
 * "could not check" is something to show, not something to crash a page on.
 */
export async function fetchLatestRelease(opts: {
  currentVersion: string;
  url?: string;
  fetchImpl?: Fetch;
  now?: number;
}): Promise<UpdateCheckResult> {
  const checkedAt = new Date(opts.now ?? Date.now()).toISOString();
  const fail = (error: string): UpdateCheckResult => ({
    latest: null,
    updateAvailable: false,
    url: RELEASES_PAGE,
    checkedAt,
    error,
  });
  const current = parseVersion(opts.currentVersion);
  if (!current) return fail(`This build has no usable version number ("${opts.currentVersion}").`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.url ?? updateCheckUrl(), {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        // GitHub requires one. Deliberately generic: it says nothing about
        // who is asking or which version they run.
        "user-agent": "open-admin-update-check",
      },
      redirect: "error",
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.status === 404) return fail("No published release was found.");
    if (res.status === 403 || res.status === 429) {
      return fail("GitHub is limiting requests from this network. It will be tried again later.");
    }
    if (!res.ok) return fail(`The release server answered ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) return fail("The release server's answer was too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail("The release server's answer could not be read.");
    }
    const release = (body ?? {}) as { tag_name?: unknown; html_url?: unknown };
    const latest = parseVersion(release.tag_name);
    if (!latest) return fail("The newest release has no usable version number.");
    // The link is shown to an admin and clicked. Only ever this project's
    // release pages; anything else in the answer is replaced by the fixed one.
    const page =
      typeof release.html_url === "string" &&
      release.html_url.startsWith(`https://github.com/${REPOSITORY}/releases/`) &&
      !/[\s"'<>\\]/.test(release.html_url) &&
      release.html_url.length < 300
        ? release.html_url
        : RELEASES_PAGE;
    return {
      latest: latest.join("."),
      updateAvailable: isNewer(latest, current),
      url: page,
      checkedAt,
      error: null,
    };
  } catch (e) {
    return fail(
      controller.signal.aborted
        ? "The release server did not answer in time."
        : `The release server could not be reached${e instanceof Error && e.message ? `: ${e.message.slice(0, 120)}` : "."}`
    );
  } finally {
    clearTimeout(timer);
  }
}

let cached: UpdateCheckResult | null = null;
let inFlight: Promise<UpdateCheckResult> | null = null;

/**
 * The latest answer, asking GitHub only when the one held is old. `force`
 * asks now regardless (the "Check now" button). Simultaneous callers share
 * one request.
 */
export async function latestRelease(
  opts: { force?: boolean; fetchImpl?: Fetch; now?: number; currentVersion?: string } = {}
): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now();
  if (cached && !opts.force) {
    const age = now - Date.parse(cached.checkedAt);
    if (age >= 0 && age < (cached.error ? UPDATE_CHECK_RETRY_MS : UPDATE_CHECK_TTL_MS)) {
      return cached;
    }
  }
  if (!inFlight) {
    inFlight = fetchLatestRelease({
      currentVersion: opts.currentVersion ?? runningVersion(),
      fetchImpl: opts.fetchImpl,
      now,
    })
      .then((result) => {
        cached = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Forget the held answer. Called when the setting is switched off. */
export function clearUpdateCheck(): void {
  cached = null;
}
