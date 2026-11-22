import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileAtomicSync } from "./fsutil.ts";
import { isLoopbackHost } from "./signin.ts";

/**
 * "Is a copy of this already running?" - answered with a lock file, a check
 * that its process is alive, an HTTP probe, and finally a proof that whatever
 * answers on the port knows the secret this launcher gave the server it
 * started. Without the proof, any program that happened to be listening on the
 * port named in a stale lock file (closing the window leaves one behind, and
 * process ids are reused) was taken for Open Admin and handed the password.
 */

export interface LockRecord {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  /**
   * The instance token the server was started with (64 hex characters).
   * Absent in locks written by launchers older than the proof check, which
   * therefore never count as ours.
   */
  token: string | null;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** A fresh secret for one server start: 32 random bytes, as lower-case hex. */
export function generateInstanceToken(): string {
  return randomBytes(32).toString("hex");
}

export function readLock(file: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Partial<Record<keyof LockRecord, unknown>>;
    if (typeof rec.pid !== "number" || typeof rec.port !== "number") return null;
    return {
      pid: rec.pid,
      port: rec.port,
      host: typeof rec.host === "string" ? rec.host : "127.0.0.1",
      startedAt: typeof rec.startedAt === "string" ? rec.startedAt : "",
      token: typeof rec.token === "string" && TOKEN_RE.test(rec.token) ? rec.token : null,
    };
  } catch {
    return null;
  }
}

/**
 * Record the running server. Owner-only: the token in it is what lets a later
 * launch tell this server from an impostor, so anyone who could read it could
 * pass for this server.
 */
export function writeLock(file: string, record: LockRecord): void {
  try {
    writeFileAtomicSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A missing lock file only costs us the "already running" shortcut.
  }
}

/**
 * Remove the lock file, but only if it is the one this process wrote: another
 * copy may have replaced it since (after deciding this one was not its own).
 */
export function removeOwnLock(file: string, token: string): void {
  try {
    const current = readLock(file);
    if (current && current.token === token && current.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    // Ignore: best-effort cleanup on the way out.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET the given path; resolves with the status code, or null on any failure. */
export function probeHttp(
  host: string,
  port: number,
  pathname: string,
  timeoutMs: number
): Promise<number | null> {
  return getText(host, port, pathname, timeoutMs).then((r) => (r ? r.status : null));
}

const MAX_ANSWER_BYTES = 8192;

/** GET a path and read at most a few kilobytes of the answer. Null on any failure. */
function getText(
  host: string,
  port: number,
  pathname: string,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < MAX_ANSWER_BYTES) body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Must match INSTANCE_PROOF_LABEL in src/lib/launch-tickets.ts. */
export const INSTANCE_PROOF_LABEL = "open-admin-instance-proof:";

/** HMAC-SHA256 keyed by the token (as UTF-8 text) over label + challenge. */
export function expectedProof(token: string, challenge: string): Buffer {
  return createHmac("sha256", Buffer.from(token, "utf8"))
    .update(INSTANCE_PROOF_LABEL + challenge, "utf8")
    .digest();
}

/** Constant-time comparison of a claimed proof (hex) with the expected one. */
export function proofMatches(token: string, challenge: string, claimed: unknown): boolean {
  if (typeof claimed !== "string" || !TOKEN_RE.test(claimed)) return false;
  const expected = expectedProof(token, challenge);
  const actual = Buffer.from(claimed, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Does the server on host:port know `token`? It is asked for the HMAC of a
 * challenge chosen here, fresh each time, so an answer seen before is no use.
 */
export async function verifyInstance(
  host: string,
  port: number,
  token: string,
  timeoutMs = 2000
): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const challenge = randomBytes(32).toString("hex");
  const answer = await getText(
    host,
    port,
    `/api/auth/launch-ticket?challenge=${challenge}`,
    timeoutMs
  );
  if (!answer || answer.status !== 200) return false;
  try {
    return proofMatches(token, challenge, (JSON.parse(answer.body) as { proof?: unknown }).proof);
  } catch {
    return false;
  }
}

export type RunningInstance =
  /** Our own server: safe to send the password to. */
  | { kind: "ours"; host: string; port: number }
  /**
   * The lock names a live process and something answers on its port, but it
   * could not prove it is the server this lock was written for: another
   * program, or a copy of Open Admin too old to answer the proof.
   */
  | { kind: "unverified"; pid: number; host: string; port: number }
  | { kind: "none" };

export interface FindDeps {
  isAlive?: (pid: number) => boolean;
  probe?: (host: string, port: number) => Promise<number | null>;
  verify?: (host: string, port: number, token: string) => Promise<boolean>;
  /** Where to reach a server bound to `host` (see address.ts). */
  reach?: (host: string) => string;
}

/**
 * Is one of our servers already up? The lock file names the port it took,
 * which is what we hand back - a second launch should open the window the
 * first one is serving, whatever port that turned out to be.
 */
export async function findRunningInstance(
  lockFile: string,
  deps: FindDeps = {}
): Promise<RunningInstance> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const probe = deps.probe ?? ((h: string, p: number) => probeHttp(h, p, "/login", 2000));
  const verify = deps.verify ?? ((h: string, p: number, t: string) => verifyInstance(h, p, t));
  const reach = deps.reach ?? ((h: string) => h);

  const lock = readLock(lockFile);
  if (!lock || !isAlive(lock.pid)) return { kind: "none" };
  const host = reach(lock.host);
  if ((await probe(host, lock.port)) === null) return { kind: "none" };
  if (lock.token && (await verify(host, lock.port, lock.token))) {
    return { kind: "ours", host: lock.host, port: lock.port };
  }
  return { kind: "unverified", pid: lock.pid, host: lock.host, port: lock.port };
}

/**
 * Can we bind host:port? Checked up front because Next's standalone server
 * calls process.exit(1) on EADDRINUSE, which would give the user a stack
 * trace instead of "port 3000 is busy, try --port 3001".
 */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host, port, exclusive: true });
  });
}

/** Errors that mean "this address does not exist here", not "it is taken". */
const NO_SUCH_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL", "ENOTFOUND"]);

/**
 * Is anything listening on address:port, or holding it? Both a connection
 * attempt and a trial bind are made: on Windows a program listening on every
 * address can still receive loopback connections while a trial bind of the
 * loopback address alone succeeds. An address this machine does not have (no
 * IPv6, say) holds nothing.
 */
export async function isAddressTaken(address: string, port: number, timeoutMs = 1000): Promise<boolean> {
  const answers = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (answers) return true;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(!NO_SUCH_ADDRESS.has(e.code ?? "")));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen({ host: address, port, exclusive: true });
  });
}

/**
 * The loopback addresses a browser sent to "localhost" may try, other than
 * the one the server binds. The launcher binds one address but opens
 * "localhost" (single sign-on redirect URIs are registered with that name),
 * and "localhost" may resolve to either.
 */
export function otherLoopbacks(host: string): string[] {
  if (host === "127.0.0.1") return ["::1"];
  if (host === "::1") return ["127.0.0.1"];
  return ["127.0.0.1", "::1"];
}

export interface AvailabilityDeps {
  isFree?: (host: string, port: number) => Promise<boolean>;
  isTaken?: (address: string, port: number) => Promise<boolean>;
}

/**
 * Can this run use host:port? The port must be free to bind and, when the
 * server is for this machine only, nothing else may be listening on the other
 * loopback address at that port: a browser opening "localhost" could reach
 * that program instead, along with the one-time sign-in ticket.
 */
export async function isPortAvailable(
  host: string,
  port: number,
  deps: AvailabilityDeps = {}
): Promise<boolean> {
  const isFree = deps.isFree ?? isPortFree;
  const isTaken = deps.isTaken ?? ((a: string, p: number) => isAddressTaken(a, p));
  if (!(await isFree(host, port))) return false;
  if (!isLoopbackHost(host)) return true;
  for (const other of otherLoopbacks(host)) {
    if (await isTaken(other, port)) return false;
  }
  return true;
}

/** How many ports above a busy one are tried before giving up. */
export const PORT_FALLBACK_SPAN = 20;

/**
 * The first free port in `first .. first + span - 1`, or null when every one
 * is taken.
 *
 * Someone who double-clicked the executable has no way to act on "start with
 * --port 3001": there is no command line in front of them. When the port they
 * would normally get is busy, the launcher takes the next free one for that
 * run instead. `isFree` is injectable for tests.
 */
export async function findFreePort(
  host: string,
  first: number,
  span: number = PORT_FALLBACK_SPAN,
  isFree: (host: string, port: number) => Promise<boolean> = isPortAvailable
): Promise<number | null> {
  const last = Math.min(first + span - 1, 65535);
  for (let port = first; port <= last; port++) {
    if (await isFree(host, port)) return port;
  }
  return null;
}
