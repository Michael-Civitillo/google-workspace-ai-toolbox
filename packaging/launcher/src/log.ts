import fs from "node:fs";
import path from "node:path";

/**
 * Console logging that also lands in a rotating file, so a user who closed
 * the window can still tell us what happened.
 */

const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_ROTATIONS = 5;

let logFilePath: string | null = null;

function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_LOG_BYTES) return;
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Logging must never be the reason the app fails to start.
  }
}

/** Point the file half of the logger at `<dir>/launcher.log`. */
export function initLogFile(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "launcher.log");
    rotate(file);
    logFilePath = file;
  } catch {
    logFilePath = null;
  }
}

function toFile(level: string, message: string): void {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(
      logFilePath,
      `${new Date().toISOString()} ${level} ${message}\n`,
      "utf-8"
    );
  } catch {
    // Disk full, folder deleted mid-run: keep serving.
  }
}

export function info(message: string): void {
  console.log(message);
  toFile("INFO", message);
}

export function warn(message: string): void {
  console.warn(message);
  toFile("WARN", message);
}

export function error(message: string): void {
  console.error(message);
  toFile("ERROR", message);
}

/** Console output that is deliberately quiet in the log file (prompts, blanks). */
export function plain(message: string): void {
  console.log(message);
}
