import { appendFileSync } from "fs";
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
export function audit(entry: AuditEntry): void {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
        params: redactSensitive(entry.params),
      }) + "\n";
    appendFileSync(LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Logging must never throw into the request handler.
  }
}

const SENSITIVE_KEYS = new Set(["password", "geminiApiKey", "apiKey", "token"]);

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}
