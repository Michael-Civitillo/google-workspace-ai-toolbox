/**
 * Email validation split out of validate.ts so client components can import
 * it: validate.ts pulls in node:path (for credential-path validation), which
 * must never land in a browser bundle.
 */

// Practical, conservative email regex. Rejects spaces, control chars, leading
// dashes, and anything without a plausible domain. Not RFC 5322 — intentional.
// Apostrophes are included in the local part: Google Workspace allows them in
// usernames (e.g. o'brien@…), and rejecting one here would lock every flow out
// of operating on that account.
const EMAIL_RE =
  /^(?!-)[A-Za-z0-9._%+'\-]{1,64}@(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);
}
