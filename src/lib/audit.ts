import {
  appendFileSync,
  chmodSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import path from "path";
import { dataPath } from "./data-dir";

/**
 * Resolve the audit log path once at module load. We prefer an explicit env
 * var so a systemd-managed deployment never writes audit entries somewhere
 * unexpected if cwd changes (e.g. service restart in /). Falls back to
 * audit.log in the data directory — the working directory for a normal
 * install, a per-user folder for the packaged desktop build (see data-dir.ts).
 */
export const AUDIT_LOG_PATH = path.resolve(
  process.env.AUDIT_LOG_PATH || dataPath("audit.log")
);

// Re-tighten file permissions at module load: `appendFileSync` only applies
// `mode` on file creation, so a pre-existing log written under a permissive
// umask would keep its old mode forever. Idempotent for the common case.
try {
  const stat = statSync(AUDIT_LOG_PATH);
  if ((stat.mode & 0o777) !== 0o600) {
    chmodSync(AUDIT_LOG_PATH, 0o600);
  }
} catch {
  // File doesn't exist yet — the next append will create it with 0o600.
}

export interface AuditEntry {
  /** Action identifier (e.g. "domain_change", "calendar_transfer.remove") */
  action: string;
  tenantId: string | null;
  tenantName: string | null;
  params: Record<string, unknown>;
  outcome: "success" | "error";
  error?: string;
  /** Optional caller identifier (e.g. session id) when auth is wired up */
  actor?: string;
}

/**
 * Append-only JSON-lines audit log of every mutating action this tool runs
 * against a Workspace tenant. Lives next to tenants.json on the host, and
 * rotates by size so a long-lived install cannot fill its disk one entry at
 * a time.
 *
 * If logging fails we swallow the error — we never want a logging failure to
 * mask a real action error to the caller — but the route still returns its
 * own success/failure based on the actual API result.
 */
// Throttle the "audit write failed" warning so a persistent problem (disk
// full, deleted log dir, permissions change) surfaces in service logs without
// flooding them on every mutating request.
let lastAuditFailureWarn = 0;
const AUDIT_FAILURE_WARN_INTERVAL_MS = 60_000;

/**
 * Rotation cap: 8 MB per file, 3 kept archives — ~32 MB and tens of thousands
 * of entries, sized for the desktop-to-small-server installs this tool
 * targets. The in-app viewer (audit-reader.ts) reads the archives after the
 * live file.
 */
const MAX_AUDIT_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_ROTATED_LOGS = 3;

// audit() runs on every mutating request, so we carry the size we have
// written instead of stat()ing per append, and only touch the filesystem when
// the counter nears the cap or has had time to drift (a second instance
// sharing the data directory, an operator truncating the file by hand).
let trackedLogSize: number | null = null;
let appendsSinceStat = 0;
const STAT_RESYNC_APPENDS = 256;

// Gate retries after a failed rotation: a read-only data directory or a
// Windows handle on one of the archives would otherwise re-attempt the renames
// on every request. The gate doubles as the throttle for its warning.
let rotationRetryAfter = 0;
const ROTATION_RETRY_INTERVAL_MS = 60_000;

/**
 * Move audit.log aside once it reaches the cap, shifting audit.log.1 up and
 * dropping what falls off the end. Never throws, and all or nothing: every
 * rename is undone if a later one fails, and the oldest archive is only
 * deleted once everything else is in place. Before, the oldest archive was
 * deleted and the others shifted ahead of the step most likely to fail (the
 * live file, held open on Windows by a viewer or log shipper), so each retry
 * lost another archive while the live log never rotated.
 */
function rotateIfAtCap(): void {
  if (
    trackedLogSize !== null &&
    trackedLogSize < MAX_AUDIT_LOG_BYTES &&
    appendsSinceStat < STAT_RESYNC_APPENDS
  ) {
    return;
  }
  const now = Date.now();
  if (now < rotationRetryAfter) return;

  let size: number;
  try {
    size = statSync(AUDIT_LOG_PATH).size;
  } catch {
    // No log yet, or it vanished under us: the append recreates it at 0600.
    trackedLogSize = 0;
    appendsSinceStat = 0;
    return;
  }
  trackedLogSize = size;
  appendsSinceStat = 0;
  if (size < MAX_AUDIT_LOG_BYTES) return;

  const done: Array<[from: string, to: string]> = [];
  const move = (from: string, to: string) => {
    renameSync(from, to);
    done.push([from, to]);
  };
  const stamp = `${process.pid}-${now}`;
  const outgoing = `${AUDIT_LOG_PATH}.rotating-${stamp}`;
  const doomed = `${AUDIT_LOG_PATH}.${KEEP_ROTATED_LOGS}.dropping-${stamp}`;
  try {
    // The live file first: if it is held open, nothing has changed yet.
    move(AUDIT_LOG_PATH, outgoing);
    const oldest = `${AUDIT_LOG_PATH}.${KEEP_ROTATED_LOGS}`;
    if (existsSync(oldest)) move(oldest, doomed);
    for (let i = KEEP_ROTATED_LOGS - 1; i >= 1; i--) {
      const from = `${AUDIT_LOG_PATH}.${i}`;
      if (existsSync(from)) move(from, `${AUDIT_LOG_PATH}.${i + 1}`);
    }
    move(outgoing, `${AUDIT_LOG_PATH}.1`);
  } catch (e) {
    // Put back whatever moved, newest move first. A step that can't be undone
    // leaves its file under its temporary name, which is still on disk.
    for (const [from, to] of done.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // Nothing more to do without risking another file.
      }
    }
    rotationRetryAfter = now + ROTATION_RETRY_INTERVAL_MS;
    console.error(
      "[audit] could not rotate the audit log — appending to the current file instead:",
      e instanceof Error ? e.message : e
    );
    return;
  }
  try {
    if (existsSync(doomed)) unlinkSync(doomed);
  } catch {
    // An undeletable old archive costs disk space, not entries.
  }
  try {
    // rename carries the mode over, but a log written before this module's
    // load-time chmod could have been looser — pin the archive at 0600 too.
    chmodSync(`${AUDIT_LOG_PATH}.1`, 0o600);
  } catch {
    // Best effort.
  }
  trackedLogSize = 0;
}

/** Forget the cached log size and any rotation back-off. For tests. */
export function resetAuditWriterState(): void {
  trackedLogSize = null;
  appendsSinceStat = 0;
  rotationRetryAfter = 0;
}

/**
 * Size limits for one entry. Typical entries are a few hundred bytes; these
 * only bite on something pathological, such as a rejected request carrying a
 * multi-megabyte field. Before, such a request wrote a line of the same size,
 * so a handful of them rotated every earlier entry out of the log.
 */
const ENTRY_LIMITS = {
  stringChars: 1_000,
  keyChars: 100,
  arrayItems: 50,
  objectKeys: 100,
  depth: 6,
  paramsBytes: 16 * 1024,
  fieldChars: { action: 100, tenantId: 100, tenantName: 200, actor: 320, error: 2_000 },
} as const;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [${value.length} chars]` : value;
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return clip(value, ENTRY_LIMITS.stringChars);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= ENTRY_LIMITS.depth) return "[nested too deep]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, ENTRY_LIMITS.arrayItems)
      .map((v) => boundValue(v, depth + 1));
    if (value.length > ENTRY_LIMITS.arrayItems) {
      items.push(`… ${value.length - ENTRY_LIMITS.arrayItems} more`);
    }
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, ENTRY_LIMITS.objectKeys)) {
      out[clip(k, ENTRY_LIMITS.keyChars)] = boundValue(v, depth + 1);
    }
    if (entries.length > ENTRY_LIMITS.objectKeys) {
      out.omittedKeys = entries.length - ENTRY_LIMITS.objectKeys;
    }
    return out;
  }
  return `[${typeof value}]`;
}

/**
 * Params bounded field by field, then, if the whole is still too large, the
 * largest values replaced by a note of their size until it fits. Small fields
 * (who, which tenant, counts) survive; it is the bulk that goes.
 */
function boundParams(params: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundValue(params, 0) as Record<string, unknown>;
  let size = JSON.stringify(bounded).length;
  if (size <= ENTRY_LIMITS.paramsBytes) return bounded;
  const bySize = Object.entries(bounded)
    .map(([k, v]) => [k, JSON.stringify(v ?? null).length] as const)
    .sort((a, b) => b[1] - a[1]);
  for (const [k, n] of bySize) {
    if (size <= ENTRY_LIMITS.paramsBytes) break;
    bounded[k] = `[omitted: ${n} bytes]`;
    size = JSON.stringify(bounded).length;
  }
  return bounded;
}

function clipField(value: string | null | undefined, max: number) {
  return typeof value === "string" ? clip(value, max) : value;
}

/** An entry as it will be written: redacted, then bounded. Exported for tests. */
export function preparedEntry(entry: AuditEntry, ts: string): Record<string, unknown> {
  const { fieldChars } = ENTRY_LIMITS;
  return {
    ts,
    ...entry,
    action: clipField(entry.action, fieldChars.action),
    tenantId: clipField(entry.tenantId, fieldChars.tenantId),
    tenantName: clipField(entry.tenantName, fieldChars.tenantName),
    actor: clipField(entry.actor, fieldChars.actor),
    error: clipField(entry.error, fieldChars.error),
    params: boundParams(redactSensitive(entry.params ?? {})),
  };
}

export function audit(entry: AuditEntry): void {
  try {
    const line = JSON.stringify(preparedEntry(entry, new Date().toISOString())) + "\n";
    rotateIfAtCap();
    appendFileSync(AUDIT_LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
    if (trackedLogSize !== null) trackedLogSize += Buffer.byteLength(line);
    appendsSinceStat++;
  } catch (e) {
    // Logging must never throw into the request handler — but a silent failure
    // means mutating actions run unaudited indefinitely and invisibly, which
    // defeats the log's purpose. Emit a throttled warning so operators notice.
    const now = Date.now();
    if (now - lastAuditFailureWarn >= AUDIT_FAILURE_WARN_INTERVAL_MS) {
      lastAuditFailureWarn = now;
      console.error(
        `[audit] failed to write to ${AUDIT_LOG_PATH} — mutating actions are running unaudited:`,
        e instanceof Error ? e.message : e
      );
    }
  }
}

/**
 * Keys we never want to land in the audit log. Matched case-insensitively
 * and with separators (`_`, `-`) stripped, so `password`, `Password`,
 * `client_secret`, `clientSecret`, and `CLIENT-SECRET` all redact.
 */
const SENSITIVE_KEYS_NORMALIZED: ReadonlySet<string> = new Set([
  "password",
  "apikey",
  "geminiapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "secret",
  "clientsecret",
  "privatekey",
  "credentials",
  "credential",
  "authorization",
  "cookie",
]);

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, "");
}

function isSensitiveKey(k: string): boolean {
  return SENSITIVE_KEYS_NORMALIZED.has(normalizeKey(k));
}

function redactValue(value: unknown, depth: number): unknown {
  // Bound recursion so a malicious or buggy caller can't get us to overflow.
  if (depth > 8) return "[redacted: depth-limit]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  return redactValue(obj, 0) as Record<string, unknown>;
}

const BOUNDED_MAX_KEYS = 20;
const BOUNDED_MAX_CHARS = 320;

/**
 * A request body reduced to what an audit entry on the error path needs:
 * the identifiers the operator sent (short strings, numbers, booleans),
 * with long strings truncated and nested values summarised. Routes used to
 * log `params: body` when validation failed, which let a looping client grow
 * the log by up to a megabyte per request and hid the entry from the reader
 * once the line outgrew its window.
 */
export function boundedParams(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { bodyType: Array.isArray(body) ? "array" : typeof body };
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(body as Record<string, unknown>);
  for (const [rawKey, v] of entries.slice(0, BOUNDED_MAX_KEYS)) {
    // Key names come from the caller too: a multi-megabyte key used to pass
    // through untouched.
    const k = clip(rawKey, 64);
    if (typeof v === "string") {
      out[k] =
        v.length > BOUNDED_MAX_CHARS
          ? `${v.slice(0, BOUNDED_MAX_CHARS)}… [${v.length} chars]`
          : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[array of ${v.length}]`;
    } else if (typeof v === "object") {
      out[k] = `[object with ${Object.keys(v as object).length} keys]`;
    } else {
      out[k] = `[${typeof v}]`;
    }
  }
  if (entries.length > BOUNDED_MAX_KEYS) {
    out.omittedKeys = entries.length - BOUNDED_MAX_KEYS;
  }
  return out;
}
