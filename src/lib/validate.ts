/**
 * Strict input validation for values that flow into Workspace mutating calls.
 *
 * Goal: stop typos and malformed input from reaching the gws CLI / Admin SDK,
 * and provide a single trustworthy place to reject anything that doesn't look
 * like a real Google Workspace identifier.
 */

// Practical, conservative email regex. Rejects spaces, control chars, leading
// dashes, and anything without a plausible domain. Not RFC 5322 — intentional.
const EMAIL_RE =
  /^(?!-)[A-Za-z0-9._%+\-]{1,64}@(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const DOMAIN_RE =
  /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const USERNAME_RE = /^[A-Za-z0-9._%+\-]{1,64}$/;

export function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);
}

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
export function requireEmail(value: unknown, field: string): string {
  if (!isValidEmail(value)) {
    throw new ValidationError(`${field} must be a valid email address`);
  }
  return (value as string).toLowerCase();
}

export function requireDomain(value: unknown, field: string): string {
  if (!isValidDomain(value)) {
    throw new ValidationError(`${field} must be a valid domain`);
  }
  return (value as string).toLowerCase();
}

export function requireUsername(value: unknown, field: string): string {
  if (!isValidUsername(value)) {
    throw new ValidationError(`${field} must contain only letters, numbers, dots, dashes, underscores, plus, or percent`);
  }
  return value as string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
