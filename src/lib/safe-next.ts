/**
 * Restrict a post-login destination to an internal page path, so `?next=`
 * can never become an open redirect.
 *
 * One implementation shared by the login page (client) and the single
 * sign-on routes (server): the two used to carry separate copies with
 * different rules. Dependency-free so the client bundle can import it.
 *
 * Refuses anything that is not a single-leading-slash path, backslashes
 * (the WHATWG URL parser treats "\" as "/", so "/\evil.com" would navigate
 * off-site), control characters, API routes, the login page itself, and
 * absurdly long values.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\") || /[\r\n]/.test(raw)) return "/";
  if (raw.startsWith("/api/") || raw === "/login" || raw.startsWith("/login?")) {
    return "/";
  }
  if (raw.length > 2048) return "/";
  return raw;
}
