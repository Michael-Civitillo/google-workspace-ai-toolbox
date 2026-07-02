import { appendFileSync, chmodSync, statSync } from "fs";
import path from "path";

/**
 * Resolve the audit log path once at module load. We prefer an explicit env
 * var so a systemd-managed deployment never writes audit entries somewhere
 * unexpected if cwd changes (e.g. service restart in /). Falls back to
 * <cwd>/audit.log for local dev.
 */
const LOG_PATH = path.resolve(
  process.env.AUDIT_LOG_PATH || path.join(process.cwd(), "audit.log")
);

// Re-tighten file permissions at module load: `appendFileSync` only applies
// `mode` on file creation, so a pre-existing log written under a permissive
// umask would keep its old mode forever. Idempotent for the common case.
try {
  const stat = statSync(LOG_PATH);
  if ((stat.mode & 0o777) !== 0o600) {
    chmodSync(LOG_PATH, 0o600);
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
 * against a Workspace tenant. Lives next to tenants.json on the host.
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

export function audit(entry: AuditEntry): void {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
        params: redactSensitive(entry.params),
      }) + "\n";
    appendFileSync(LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    // Logging must never throw into the request handler — but a silent failure
    // means mutating actions run unaudited indefinitely and invisibly, which
    // defeats the log's purpose. Emit a throttled warning so operators notice.
    const now = Date.now();
    if (now - lastAuditFailureWarn >= AUDIT_FAILURE_WARN_INTERVAL_MS) {
      lastAuditFailureWarn = now;
      console.error(
        `[audit] failed to write to ${LOG_PATH} — mutating actions are running unaudited:`,
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
