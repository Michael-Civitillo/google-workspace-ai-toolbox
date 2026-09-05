import fs from "node:fs";
import http from "node:http";
import net from "node:net";

/**
 * "Is a copy of this already running?" — answered with a lock file plus an
 * actual HTTP probe, because a stale pid or a recycled pid would otherwise
 * make the launcher refuse to start for no reason.
 */

export interface LockRecord {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export function readLock(file: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Partial<LockRecord>;
    if (typeof rec.pid !== "number" || typeof rec.port !== "number") return null;
    return {
      pid: rec.pid,
      port: rec.port,
      host: typeof rec.host === "string" ? rec.host : "127.0.0.1",
      startedAt: typeof rec.startedAt === "string" ? rec.startedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeLock(file: string, record: LockRecord): void {
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // A missing lock file only costs us the "already running" shortcut.
  }
}

export function removeLock(file: string): void {
  try {
    fs.rmSync(file, { force: true });
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
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathname, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
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
