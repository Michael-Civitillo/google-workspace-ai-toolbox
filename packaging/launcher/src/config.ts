import fs from "node:fs";
import crypto from "node:crypto";
import { writeFileAtomicSync } from "./fsutil.ts";

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

/**
 * What launcher.json holds. The password is absent when the only one known
 * came from the environment for a single run, which is not saved.
 */
export type StoredConfig = Omit<LauncherConfig, "password"> & { password?: string };

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
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
    // A port nothing can listen on (0, 70000, -1) would stop every start, or
    // in the case of 0 have Next pick its own while the launcher waits on
    // another: dropped like any other bad field, so the default applies.
    if (isValidPort(raw.port)) out.port = raw.port;
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

/**
 * Save launcher.json the way the app saves its own stores
 * (src/lib/json-store.ts): an unpredictable temporary name created
 * exclusively, owner-only from the start, fully written and flushed, renamed
 * into place with retries for Windows, and removed if anything fails, since it
 * holds the password. Returns false when the file could not be made private
 * because the drive has no POSIX permissions (see writeFileAtomicSync).
 */
export function writeConfigFile(file: string, config: StoredConfig): boolean {
  return writeFileAtomicSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
 * Settings launcher.env may not make. The file sits in the data folder, which
 * in portable mode is beside the executable and can be somewhere other people
 * write to; a line there must not be able to turn off certificate checking or
 * choose code for this program, the server, or the programs it starts to load
 * or run. Anyone who really needs one of these sets it in the environment
 * instead, where it applies only to what they start. Proxy settings
 * (HTTPS_PROXY, NO_PROXY, ...) remain allowed.
 */
const REFUSED_ENV_NAMES: ReadonlySet<string> = new Set([
  // Turn off, or widen, certificate checks.
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Load code into Node, or into programs started with this environment.
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_COMPILE_CACHE",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
  // Choose which program runs.
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "GWS_BIN",
]);
const REFUSED_ENV_PREFIXES = ["LD_", "DYLD_"];

/** True for a name launcher.env may not set (case-insensitive, as on Windows). */
export function isRefusedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return REFUSED_ENV_NAMES.has(upper) || REFUSED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

export interface EnvFileResult {
  /** Names set from the file. */
  applied: string[];
  /** Names in the file that were ignored because the file may not set them. */
  refused: string[];
}

/**
 * Apply a launcher.env file to the process environment. Real environment
 * variables win: the file is a convenience for people who would rather not
 * touch Windows' system settings, not an override of what they typed.
 */
export function applyEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): EnvFileResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { applied: [], refused: [] };
  }
  const applied: string[] = [];
  const refused: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (isRefusedEnvName(key)) {
      refused.push(key);
    } else if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return { applied, refused };
}

export function generateSessionSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function generatePassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

let warnedAboutCommandLinePassword = false;

/**
 * `--password` puts the value in the process argument list, where `ps` and Task
 * Manager show it to every other user on the machine, and the shell keeps a copy
 * in its history file. Written straight to stderr rather than through log.ts:
 * launcher.log is the file people attach to a bug report, and the password path
 * is kept out of it the same way the generated password is.
 */
export function warnPasswordOnCommandLine(): void {
  if (warnedAboutCommandLinePassword) return;
  warnedAboutCommandLinePassword = true;
  process.stderr.write(
    "Warning: --password is visible to every user on this machine (it shows up in\n" +
      "  the process list) and stays in your shell history. On a shared machine, set\n" +
      "  APP_PASSWORD in launcher.env or the environment, run --set-password to be\n" +
      "  prompted without echo, or use the password saved in launcher.json.\n"
  );
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
