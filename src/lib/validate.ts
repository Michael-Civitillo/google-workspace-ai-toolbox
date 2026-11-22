/**
 * Strict input validation for values that flow into Workspace mutating calls.
 *
 * Goal: stop typos and malformed input from reaching the gws CLI / Admin SDK,
 * and provide a single trustworthy place to reject anything that doesn't look
 * like a real Google Workspace identifier.
 */

// Email validation lives in validate-email.ts (client-safe module — this file
// imports node:path further down, which browser bundles must never see).
// Re-exported here so server code keeps its single import site.
import { isValidEmail } from "./validate-email";
export { isValidEmail };

const DOMAIN_RE =
  /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const USERNAME_RE = /^[A-Za-z0-9._%+'\-]{1,64}$/;

export function isValidDomain(s: unknown): s is string {
  return typeof s === "string" && s.length <= 253 && DOMAIN_RE.test(s);
}

export function isValidUsername(s: unknown): s is string {
  return typeof s === "string" && USERNAME_RE.test(s);
}

export function emailDomain(email: string): string {
  return email.slice(email.indexOf("@") + 1).toLowerCase();
}

/**
 * Throws a user-facing error if any required field is missing or malformed.
 * Use at the top of every mutating route.
 */
// Surrounding whitespace is never meaningful in an identifier, and every page
// gates its buttons on the trimmed value — so trim here rather than bounce a
// pasted address with a trailing space back to the operator.
function trimmed(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

export function requireEmail(value: unknown, field: string): string {
  const s = trimmed(value);
  if (!isValidEmail(s)) {
    throw new ValidationError(`${field} must be a valid email address`);
  }
  return s.toLowerCase();
}

export function requireDomain(value: unknown, field: string): string {
  const s = trimmed(value);
  if (!isValidDomain(s)) {
    throw new ValidationError(`${field} must be a valid domain`);
  }
  return s.toLowerCase();
}

export function requireUsername(value: unknown, field: string): string {
  const s = trimmed(value);
  if (!isValidUsername(s)) {
    throw new ValidationError(`${field} must contain only letters, numbers, dots, dashes, underscores, apostrophes, plus, or percent`);
  }
  return s;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Reject service-account credential paths that look unsafe.
 *
 * Threats from a malicious-but-authenticated user:
 *   - Path traversal: "../../etc/shadow" — Node would refuse for permissions
 *     but error messages can leak file existence.
 *   - Reading an unrelated file as JSON: causes a parse error that may echo
 *     part of the file content.
 *   - Reading a service-account key for a tenant they shouldn't access.
 *
 * Rules: must be absolute (POSIX or Windows), must end in .json, no `..`
 * segments, no embedded NUL bytes, no control characters. If
 * GWS_CREDENTIALS_DIR is set, the path must live inside that directory.
 */
export function validateCredentialsFilePath(p: unknown): string {
  if (typeof p !== "string" || !p.trim()) {
    throw new ValidationError("credentialsFile is required");
  }
  const raw = p.trim();
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw new ValidationError("credentialsFile contains illegal characters");
  }
  if (!path.isAbsolute(raw)) {
    throw new ValidationError(
      "credentialsFile must be an absolute path"
    );
  }
  // A network path (\\server\share\key.json, or a \\?\ device path): on
  // Windows, opening one makes the machine connect out to that server and
  // offer it the signed-in user's credentials. A key belongs on this disk.
  if (/^[\\/]{2}/.test(raw)) {
    throw new ValidationError(
      "credentialsFile must be on this computer's own disk, not a network path"
    );
  }
  // Reject `..` segments using either separator.
  if (raw.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new ValidationError(
      "credentialsFile must not contain `..` path segments"
    );
  }
  if (!raw.toLowerCase().endsWith(".json")) {
    throw new ValidationError(
      "credentialsFile must point to a .json service-account key"
    );
  }
  // Normalise to the OS-native form for consistent storage and the
  // GWS_CREDENTIALS_DIR check below.
  const resolved = path.resolve(raw);
  const allowedDir = process.env.GWS_CREDENTIALS_DIR;
  if (allowedDir) {
    const allowedResolved = path.resolve(allowedDir);
    const outside = (dir: string, file: string) => {
      const rel = path.relative(dir, file);
      return rel.startsWith("..") || path.isAbsolute(rel);
    };
    if (outside(allowedResolved, resolved)) {
      throw new ValidationError(
        `credentialsFile must live under ${allowedDir} (set by GWS_CREDENTIALS_DIR)`
      );
    }
    // And where it really is: a link inside the folder can point anywhere.
    // For a file that doesn't exist yet (a restore writes it), its folder.
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : null);
    const realDir = real(allowedResolved) ?? allowedResolved;
    const target = real(resolved) ?? (real(path.dirname(resolved)) ? path.join(real(path.dirname(resolved))!, path.basename(resolved)) : null);
    if (target !== null && outside(realDir, target)) {
      throw new ValidationError(
        `credentialsFile must live under ${allowedDir} (set by GWS_CREDENTIALS_DIR); it is a link to somewhere else`
      );
    }
  }
  return resolved;
}
