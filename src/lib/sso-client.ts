"use client";

import type {
  IssuerCheckResult,
  PublicSsoConfig,
  SsoTestResult,
} from "./sso-types";

/**
 * Browser-side helpers for the single sign-on settings page and wizard.
 */

export interface SsoConfigResponse {
  config: PublicSsoConfig | null;
  envDisabled: boolean;
  configPath: string;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function errorFrom(data: Record<string, unknown>, fallback: string): Error {
  return new Error(typeof data.error === "string" ? data.error : fallback);
}

export async function loadSsoConfig(): Promise<SsoConfigResponse> {
  const res = await fetch("/api/auth/sso/config");
  const data = await readJson(res);
  if (!res.ok) throw errorFrom(data, `HTTP ${res.status}`);
  return {
    config: (data.config as PublicSsoConfig | null) ?? null,
    envDisabled: data.envDisabled === true,
    configPath: typeof data.configPath === "string" ? data.configPath : "",
  };
}

export async function saveSsoConfig(
  body: Record<string, unknown>
): Promise<PublicSsoConfig> {
  const res = await fetch("/api/auth/sso/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw errorFrom(data, "Failed to save the configuration");
  return data.config as PublicSsoConfig;
}

export async function removeSsoConfig(): Promise<void> {
  const res = await fetch("/api/auth/sso/config", { method: "DELETE" });
  const data = await readJson(res);
  if (!res.ok) throw errorFrom(data, "Failed to remove the configuration");
}

export async function discoverIssuer(issuer: string): Promise<IssuerCheckResult> {
  const res = await fetch("/api/auth/sso/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issuer }),
  });
  const data = await readJson(res);
  if (!res.ok || data.ok !== true) {
    throw errorFrom(data, "Could not load the provider's discovery document");
  }
  return data as unknown as IssuerCheckResult;
}

/**
 * Open the test sign-in popup and hand its result to `onResult`. The popup
 * posts a message back when the provider round-trip finishes; closing it
 * early or having it blocked is reported as a failure. Returns a function
 * that abandons the test (used on unmount).
 */
export function runSsoTest(onResult: (result: SsoTestResult) => void): () => void {
  const width = 520;
  const height = 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  const popup = window.open(
    "/api/auth/oidc/start?mode=test",
    "gws-sso-test",
    `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`
  );

  let settled = false;
  let poll: number | undefined;

  function cleanup() {
    window.removeEventListener("message", onMessage);
    if (poll !== undefined) window.clearInterval(poll);
  }

  function finish(result: SsoTestResult) {
    if (settled) return;
    settled = true;
    cleanup();
    onResult(result);
  }

  function onMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;
    const data = event.data as Partial<SsoTestResult> | null;
    if (!data || data.type !== "gws-sso-test") return;
    finish(data as SsoTestResult);
  }

  if (!popup) {
    finish({
      type: "gws-sso-test",
      ok: false,
      code: "popup_blocked",
      message:
        "The browser blocked the test window. Allow pop-ups for this site and try again.",
    });
    return () => {};
  }

  window.addEventListener("message", onMessage);
  poll = window.setInterval(() => {
    if (!popup.closed) return;
    window.clearInterval(poll);
    poll = undefined;
    // Give a result message that raced the close a moment to land.
    window.setTimeout(() => {
      finish({
        type: "gws-sso-test",
        ok: false,
        code: "popup_closed",
        message: "The test window was closed before sign-in finished.",
      });
    }, 400);
  }, 500);

  return () => {
    settled = true;
    cleanup();
    try {
      popup.close();
    } catch {}
  };
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
