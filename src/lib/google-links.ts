/**
 * A link that came back from Google (a file's "open in Drive" address), kept
 * only when it really points at Google over HTTPS. Anything else is shown as
 * text or not at all, never as something to click: the value reaches the
 * page from an API response, and a page should not trust it blindly.
 */
export function googleLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    return host === "google.com" || host.endsWith(".google.com") ? u.toString() : null;
  } catch {
    return null;
  }
}
