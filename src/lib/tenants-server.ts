import {
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "fs";
import path from "path";
import type { Tenant, PublicTenant } from "./tenant-types";

/**
 * Strip the server-only Gemini API key before a tenant crosses to the browser,
 * exposing only whether one is set. Use for every API response that returns
 * tenant objects.
 */
export function toPublicTenant(tenant: Tenant): PublicTenant {
  const { geminiApiKey, hasGeminiApiKey: _ignored, ...rest } = tenant;
  void _ignored;
  return { ...rest, hasGeminiApiKey: Boolean(geminiApiKey) };
}

interface TenantStore {
  activeTenantId: string | null;
  tenants: Tenant[];
}

const STORE_PATH = path.join(process.cwd(), "tenants.json");
const STORE_TMP_PATH = path.join(process.cwd(), "tenants.json.tmp");

/**
 * Single-process write mutex. All read-modify-write sequences serialise
 * through this so concurrent API requests can't lose each other's changes.
 */
let writeLock: Promise<unknown> = Promise.resolve();

/**
 * Move the on-disk store aside under a timestamped name so a subsequent write
 * can't silently overwrite it. Used only when the file is genuinely unusable
 * (empty or unparseable) — never for a transient read error.
 */
function quarantineStore(): void {
  try {
    renameSync(STORE_PATH, `${STORE_PATH}.corrupt-${Date.now()}`);
  } catch {
    // If we can't even move it, fall through — we still avoid throwing into the
    // request handler for the corruption case.
  }
}

function readStore(): TenantStore {
  if (!existsSync(STORE_PATH)) {
    return { activeTenantId: null, tenants: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(STORE_PATH, "utf-8");
  } catch (e) {
    // A read failure is NOT corruption — it can be transient (EBUSY/EMFILE, an
    // antivirus / Search Indexer lock on Windows, fd exhaustion). Quarantining
    // here would permanently evict a healthy store on a blip. Surface the error
    // instead: the file stays intact, the next read succeeds, and a
    // read-modify-write under withLock aborts rather than persisting an empty
    // store over the real config.
    throw new Error(
      `Failed to read tenant store at ${STORE_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!raw.trim()) {
    // Existing-but-empty file: preserve it before returning an empty store so a
    // subsequent write can't overwrite a (possibly externally truncated) config
    // with no trace. After the rename the path is gone, so this happens once.
    quarantineStore();
    return { activeTenantId: null, tenants: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      activeTenantId: parsed.activeTenantId ?? null,
      tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [],
    };
  } catch {
    // Unparseable content is real corruption — quarantine it so the next write
    // doesn't clobber the evidence, then start from an empty store.
    quarantineStore();
    return { activeTenantId: null, tenants: [] };
  }
}

async function writeStoreAtomic(store: TenantStore): Promise<void> {
  // Write to a temp file, fsync it, then rename — guarantees we never leave a
  // half-written OR zero-length tenants.json on disk if the process is killed
  // mid-write. The explicit fsync before rename matters: on ext4/xfs a rename
  // can become durable before the file's data blocks, so a crash could
  // otherwise leave an empty tenants.json that readStore treats as "no tenants"
  // and the next write makes permanent.
  const fd = openSync(STORE_TMP_PATH, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // On Windows the rename can transiently fail with EPERM/EBUSY if
  // antivirus / Windows Search Indexer briefly holds the destination
  // file open. Retry a couple of times with tiny backoffs before giving up.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(STORE_TMP_PATH, STORE_PATH);
      // Best-effort: fsync the containing directory so the rename itself is
      // durable. Directory fsync isn't supported on Windows (EPERM/EISDIR) — a
      // no-op there, so swallow failures rather than fail an otherwise-good write.
      try {
        const dirFd = openSync(path.dirname(STORE_PATH), "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Directory fsync unsupported on this platform — ignore.
      }
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      const transient =
        code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Yield with a real timer instead of spinning — the withLock() mutex
      // already serialises writers, so awaiting here never interleaves a
      // concurrent read-modify-write, and it keeps the event loop free.
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
  try {
    if (existsSync(STORE_TMP_PATH)) unlinkSync(STORE_TMP_PATH);
  } catch {}
  throw lastError;
}

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>((res) => {
    release = res;
  });
  try {
    await previous;
    // `await` (not a bare `return fn()`) so the lock is held until the async
    // critical section fully settles. Without it the `finally` below would run
    // release() the moment fn() returns its pending promise — freeing the lock
    // mid-write and letting a concurrent writer read stale state and clobber
    // the shared temp file.
    return await fn();
  } finally {
    release();
  }
}

export function getTenants(): Tenant[] {
  return readStore().tenants;
}

export function getTenantById(id: string): Tenant | null {
  return readStore().tenants.find((t) => t.id === id) ?? null;
}

export function getActiveTenantId(): string | null {
  return readStore().activeTenantId;
}

/**
 * @deprecated Prefer resolveTenant(tenantId). The "active" tenant is global
 * server state and is unsafe when more than one admin (or one admin in two
 * tabs) uses the app at once. Kept only for the bootstrap fallback.
 */
export function getActiveTenant(): Tenant | null {
  const store = readStore();
  if (!store.activeTenantId) return null;
  return store.tenants.find((t) => t.id === store.activeTenantId) ?? null;
}

/**
 * Resolve the tenant to use for a request.
 * Prefers an explicit tenantId from the caller. Falls back to the persisted
 * active tenant only when no ID is supplied. Throws if a tenantId is supplied
 * but doesn't exist — that means a tenant was deleted or the client is stale,
 * and we must NOT silently run against whatever happens to be active.
 */
export function resolveTenant(tenantId: string | null | undefined): Tenant | null {
  if (tenantId) {
    const t = getTenantById(tenantId);
    if (!t) {
      throw new Error(
        `Tenant "${tenantId}" not found. It may have been deleted — refresh the page and pick a tenant.`
      );
    }
    return t;
  }
  return getActiveTenant();
}

export async function setActiveTenant(id: string): Promise<void> {
  await withLock(async () => {
    const store = readStore();
    const tenant = store.tenants.find((t) => t.id === id);
    if (!tenant) throw new Error(`Tenant "${id}" not found`);
    store.activeTenantId = id;
    await writeStoreAtomic(store);
  });
}

export async function addTenant(tenant: Omit<Tenant, "id">): Promise<Tenant> {
  return withLock(async () => {
    const store = readStore();
    const id =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newTenant: Tenant = { ...tenant, id };
    store.tenants.push(newTenant);
    if (store.tenants.length === 1) {
      store.activeTenantId = id;
    }
    await writeStoreAtomic(store);
    return newTenant;
  });
}

export async function updateTenant(
  id: string,
  updates: Partial<Omit<Tenant, "id">>
): Promise<Tenant> {
  return withLock(async () => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Tenant "${id}" not found`);
    store.tenants[idx] = { ...store.tenants[idx], ...updates };
    await writeStoreAtomic(store);
    return store.tenants[idx];
  });
}

export async function deleteTenant(id: string): Promise<void> {
  await withLock(async () => {
    const store = readStore();
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Tenant "${id}" not found`);
    store.tenants.splice(idx, 1);
    if (store.activeTenantId === id) {
      store.activeTenantId = store.tenants[0]?.id ?? null;
    }
    await writeStoreAtomic(store);
  });
}
