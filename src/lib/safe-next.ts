/**
 * Restrict a post-login destination to an internal page path, so `?next=`
 * can never become an open redirect.
 *
 * One implementation shared by the login page (client) and the single
 * sign-on routes (server): the two used to carry separate copies with
 * different rules. Dependency-free so the client bundle can import it.
 *
 * The value is canonicalised through the URL parser against a fixed base and
 * only kept when it stays on that base. That is what actually decides where a
 * browser goes; string checks alone miss cases like a tab between two
 * slashes, which the parser strips before parsing, turning the "path" into an
 * external origin. Control characters are refused outright for the same
 * reason, as are backslashes (treated as "/"), API routes, the login page
 * itself, and absurdly long values.
 */
const BASE = "http://next.invalid";
// C0 controls and DEL. Written as a range so the source stays free of
// literal control characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (raw.length > 2048) return "/";
  if (CONTROL_CHARS.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";

  const canonical = `${url.pathname}${url.search}${url.hash}`;
  if (!canonical.startsWith("/") || canonical.startsWith("//")) return "/";
  if (
    canonical.startsWith("/api/") ||
    canonical === "/login" ||
    canonical.startsWith("/login?")
  ) {
    return "/";
  }
  if (canonical.length > 2048) return "/";
  return canonical;
}
