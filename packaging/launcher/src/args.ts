import { warnPasswordOnCommandLine } from "./config.ts";

/**
 * Command-line parsing for the packaged launcher.
 *
 * Deliberately tiny and dependency-free: the launcher is bundled into the
 * executable, and every kilobyte of parser is a kilobyte a Workspace admin
 * downloads. Both `--flag value` and `--flag=value` are accepted because
 * people type both.
 */

export interface ParsedArgs {
  port: number | null;
  host: string | null;
  dataDir: string | null;
  root: string | null;
  password: string | null;
  setPassword: boolean;
  noBrowser: boolean;
  resetAppCache: boolean;
  help: boolean;
  version: boolean;
}

export interface ParseResult {
  args: ParsedArgs | null;
  error: string | null;
}

const VALUE_FLAGS = new Set(["port", "host", "data-dir", "root", "password"]);
const BOOLEAN_FLAGS = new Set([
  "set-password",
  "no-browser",
  "reset-app-cache",
  "help",
  "version",
]);

function emptyArgs(): ParsedArgs {
  return {
    port: null,
    host: null,
    dataDir: null,
    root: null,
    password: null,
    setPassword: false,
    noBrowser: false,
    resetAppCache: false,
    help: false,
    version: false,
  };
}

export function parseArgs(argv: string[]): ParseResult {
  const args = emptyArgs();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "-v") {
      args.version = true;
      continue;
    }
    if (!token.startsWith("--")) {
      return { args: null, error: `unexpected argument: ${token}` };
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        return { args: null, error: `--${name} does not take a value` };
      }
      const on = inlineValue !== "false";
      if (name === "set-password") args.setPassword = on;
      else if (name === "no-browser") args.noBrowser = on;
      else if (name === "reset-app-cache") args.resetAppCache = on;
      else if (name === "help") args.help = on;
      else if (name === "version") args.version = on;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      return { args: null, error: `unknown option: --${name}` };
    }

    let value = inlineValue;
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { args: null, error: `--${name} needs a value` };
      }
      value = next;
      i++;
    }
    if (value === "") {
      return { args: null, error: `--${name} needs a value` };
    }

    if (name === "port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { args: null, error: `--port must be a number between 1 and 65535` };
      }
      args.port = port;
    } else if (name === "host") args.host = value;
    else if (name === "data-dir") args.dataDir = value;
    else if (name === "root") args.root = value;
    else if (name === "password") args.password = value;
  }

  // Only on a line that parsed: a run that dies on a bad flag prints usage and
  // stops, and a second warning there is just noise.
  if (args.password !== null) warnPasswordOnCommandLine();

  return { args, error: null };
}

export function usage(exeName: string): string {
  return `Google Workspace Open Admin — single-file desktop build

Usage: ${exeName} [options]

  --port <n>           HTTP port (default 3000, remembered after first use)
  --host <addr>        bind address (default 127.0.0.1 — this machine only)
  --data-dir <path>    where tenants, sign-on config, audit log and keys live
  --root <path>        override the whole application folder (app cache + data)
  --set-password       set a new admin password for the web UI
  --password <pw>      set the admin password (saved; visible in the process list)
  --no-browser         don't open a browser window on start
  --reset-app-cache    re-extract the bundled application files
  --version, -v        print version information
  --help, -h           show this help

Everything runs on this machine: the server listens on loopback only, and
your configuration stays in the data folder shown at startup.`;
}
