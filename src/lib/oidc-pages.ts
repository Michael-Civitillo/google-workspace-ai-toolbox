import type { SsoTestResult } from "./sso-types";

/**
 * Tiny self-contained HTML pages served by the single sign-on callback.
 *
 * Why HTML instead of a plain 302: the session cookie is SameSite=Strict, and
 * browsers don't attach Strict cookies to a redirect that was initiated from
 * another site (the identity provider). Landing on a same-origin page first
 * and letting it navigate on makes the next request same-site, so the cookie
 * just set is sent and the user arrives signed in. The test popup uses the
 * same mechanism to hand its result back to the wizard via postMessage.
 *
 * Everything interpolated is escaped: claims come from the provider and must
 * be treated as untrusted text.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** JSON that is safe to embed inside a <script> element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f7fb; color: #1b1b22; }
  .card { width: min(420px, calc(100vw - 2rem)); background: #fff; border-radius: 14px; padding: 28px;
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 0 0 1px rgba(0,0,0,.06); }
  .icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    font-size: 22px; margin-bottom: 14px; }
  .ok { background: #e6f6ee; color: #137a4a; }
  .bad { background: #fdeaea; color: #b42323; }
  .wait { background: #ecebfb; color: #4f46e5; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0; font-size: 14px; line-height: 1.5; color: #55556a; }
  dl { margin: 16px 0 0; font-size: 13px; }
  dt { color: #777790; margin-top: 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  dd { margin: 2px 0 0; word-break: break-all; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .foot { margin-top: 18px; font-size: 12px; color: #8a8aa0; }
  a { color: #4f46e5; }
  @media (prefers-color-scheme: dark) {
    body { background: #131318; color: #ececf2; }
    .card { background: #1c1c24; box-shadow: 0 0 0 1px rgba(255,255,255,.08); }
    p { color: #a9a9be; } dd { color: #ececf2; } .foot { color: #7a7a90; }
    .ok { background: #123324; color: #5fd39a; } .bad { background: #3a1616; color: #f08a8a; }
    .wait { background: #23214a; color: #a5a0ff; }
  }
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">${body}</main>
<script>${script}</script>
</body>
</html>`;
}

/**
 * Login-mode success: the session cookie rides on this response, and the page
 * immediately navigates to `next` (an already-validated internal path).
 */
export function renderRedirectPage(next: string): string {
  const href = escapeHtml(next);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Signing you in…</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <div class="icon wait">→</div>
  <h1>Signing you in…</h1>
  <p>Taking you to Open Admin. <a href="${href}">Continue</a> if nothing happens.</p>
</main>
<script>window.location.replace(${jsonForScript(next)});</script>
</body>
</html>`;
}

/**
 * Test-mode result: shows the outcome in the popup and posts it to the
 * window that opened us (the setup wizard), then closes itself.
 */
export function renderTestResultPage(result: SsoTestResult): string {
  const rows: Array<[string, string]> = [];
  if (result.ok) {
    if (result.email) rows.push(["Email", result.email]);
    if (result.name) rows.push(["Name", result.name]);
    if (result.sub) rows.push(["Subject", result.sub]);
    if (result.issuer) rows.push(["Issuer", result.issuer]);
    if (result.accessReason) rows.push(["Access", result.accessReason]);
  } else {
    if (result.message) rows.push(["Problem", result.message]);
    if (result.detail) rows.push(["Details", result.detail]);
    if (result.email) rows.push(["Email", result.email]);
    if (result.accessReason) rows.push(["Access", result.accessReason]);
  }
  const dl = rows.length
    ? `<dl>${rows
        .map(
          ([k, v]) =>
            `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(v)}</code></dd>`
        )
        .join("")}</dl>`
    : "";

  const body = `
  <div class="icon ${result.ok ? "ok" : "bad"}">${result.ok ? "✓" : "✕"}</div>
  <h1>${result.ok ? "Sign-in test passed" : "Sign-in test failed"}</h1>
  <p>${
    result.ok
      ? "The identity provider authenticated you and Open Admin accepted the result. No session was created."
      : "Fix the problem below and run the test again from the wizard."
  }</p>
  ${dl}
  <p class="foot">Sending the result back to the setup wizard… you can close this window.</p>`;

  const script = `(function(){
  var result = ${jsonForScript(result)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(result, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 2500);
})();`;

  return page(result.ok ? "Sign-in test passed" : "Sign-in test failed", body, script);
}
