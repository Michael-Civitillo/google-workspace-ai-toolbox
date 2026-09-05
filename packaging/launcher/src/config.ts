import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * The launcher's own settings: the admin password for the web UI, the session
 * signing secret, and the port to come back up on.
 *
 * Stored as plain JSON next to tenants.json and sso.json, which already hold a
 * Gemini API key and an OIDC client secret respectively, and next to the
 * service-account keys themselves. The protection is the per-user permissions
 * on the application-data folder; hashing the password here would not change
 * that, because the app compares APP_PASSWORD from the environment.
 */

export const CONFIG_VERSION = 1;
export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_PORT = 3000;

export interface LauncherConfig {
  version: number;
  port: number;
  password: string;
  sessionSecret: string;
  openBrowser: boolean;
}

export function readConfigFile(file: string): Partial<LauncherConfig> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as Record<string, unknown>;
    const out: Partial<LauncherConfig> = {};
    if (typeof raw.version === "number" && Number.isInteger(raw.version)) {
      out.version = raw.version;
    }
    if (typeof raw.port === "number" && Number.isInteger(raw.port)) out.port = raw.port;
    if (typeof raw.password === "string" && raw.password) out.password = raw.password;
    if (typeof raw.sessionSecret === "string" && raw.sessionSecret) {
      out.sessionSecret = raw.sessionSecret;
    }
    if (typeof raw.openBrowser === "boolean") out.openBrowser = raw.openBrowser;
    return out;
  } catch {
    // Missing or hand-mangled: start from defaults rather than refusing to run.
    return {};
  }
}

/** Atomic write, same tmp-then-rename discipline as the app's own JSON stores. */
export function writeConfigFile(file: string, config: LauncherConfig): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the folder ACL is what protects it there.
  }
}

/**
 * Parse a `KEY=VALUE` file. Blank lines and `#` comments are skipped, values
 * are trimmed, and one layer of matching quotes is removed so a path with
 * spaces can be written either way.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Apply a launcher.env file to the process environment. Real environment
 * variables win: the file is a convenience for people who would rather not
 * touch Windows' system settings, not an override of what they typed.
 */
export function applyEnvFile(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export function generateSessionSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function generatePassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

const CTRL_C = "\u0003";
const DELETE = "\u007f";

/** Read a line from a TTY without echoing it. Shows one `*` per character. */
export function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("no interactive terminal"));
      return;
    }

    process.stdout.write(promptText);
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === DELETE || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        process.stdout.write("*");
      }
    };

    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}

export interface PasswordPromptResult {
  password: string;
  /** True when the password was generated rather than chosen by a person. */
  generated: boolean;
}

/**
 * Ask for a password twice, or generate one when there is no terminal to ask
 * on (a scheduled task, a service wrapper, output piped to a file).
 */
export async function promptForPassword(
  writeLine: (s: string) => void,
  askSecret: (p: string) => Promise<string> = readSecret,
  interactive: boolean = Boolean(process.stdin.isTTY)
): Promise<PasswordPromptResult> {
  if (!interactive) return { password: generatePassword(), generated: true };

  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await askSecret("Password: ");
    if (first.length < MIN_PASSWORD_LENGTH) {
      writeLine(`  Too short - use at least ${MIN_PASSWORD_LENGTH} characters.`);
      continue;
    }
    const second = await askSecret("Confirm:  ");
    if (first !== second) {
      writeLine("  Those don't match. Try again.");
      continue;
    }
    return { password: first, generated: false };
  }

  return { password: generatePassword(), generated: true };
}
