import { isValidEmail } from "./validate-email";
import { isValidDomain } from "./validate";
import { validateIssuerUrl, normalizeScopes, SsoError } from "./oidc";
import {
  DEFAULT_OIDC_SCOPES,
  DEFAULT_SSO_BUTTON_LABEL,
  type OidcSettings,
} from "./app-config-types";

/**
 * Turn untrusted input (the settings form or an imported bundle) into a
 * well-formed OidcSettings — or a user-facing error. Shared by the SSO
 * settings route and configuration import so the two can't drift.
 */

const MAX_LIST_ENTRIES = 200;

export interface SsoInputResult {
  /** null means "no SSO configured at all" (valid when nothing was supplied). */
  settings: OidcSettings | null;
  error?: string;
}

function err(message: string): SsoInputResult {
  return { settings: null, error: message };
}

function optionalTrimmed(v: unknown, field: string, max: number):
  | { value: string }
  | { error: string } {
  if (v === undefined || v === null) return { value: "" };
  if (typeof v !== "string") return { error: `${field} must be a string` };
  if (v.length > max) return { error: `${field} must be under ${max} characters` };
  return { value: v.trim() };
}

export function parseOidcSettingsInput(
  input: unknown,
  { existingSecret }: { existingSecret?: string } = {}
): SsoInputResult {
  if (input === null || input === undefined) return { settings: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return err("sso must be an object");
  }
  const s = input as Record<string, unknown>;

  const issuerR = optionalTrimmed(s.issuer, "issuer", 500);
  if ("error" in issuerR) return err(issuerR.error);
  const clientIdR = optionalTrimmed(s.clientId, "clientId", 500);
  if ("error" in clientIdR) return err(clientIdR.error);
  const issuer = issuerR.value;
  const clientId = clientIdR.value;
  const enabled = s.enabled === true;

  // Nothing supplied and not enabled: the caller is clearing / has no SSO.
  if (!issuer && !clientId && !enabled) return { settings: null };

  if (!issuer) return err("issuer is required");
  if (!clientId) return err("clientId is required");
  try {
    validateIssuerUrl(issuer);
  } catch (e) {
    return err(e instanceof SsoError ? e.message : "issuer is not a valid URL");
  }

  // Client secret: an empty/omitted value keeps whatever is already stored so
  // the form never has to echo the secret back; clearClientSecret drops it.
  let clientSecret: string | undefined;
  if (s.clearClientSecret === true) {
    clientSecret = undefined;
  } else {
    const secretR = optionalTrimmed(s.clientSecret, "clientSecret", 2000);
    if ("error" in secretR) return err(secretR.error);
    clientSecret = secretR.value || existingSecret || undefined;
  }

  const scopesR = optionalTrimmed(s.scopes, "scopes", 500);
  if ("error" in scopesR) return err(scopesR.error);
  if (scopesR.value && /[\r\n]/.test(scopesR.value)) {
    return err("scopes must be a single space-separated line");
  }
  const scopes = normalizeScopes(scopesR.value || DEFAULT_OIDC_SCOPES);

  const labelR = optionalTrimmed(s.buttonLabel, "buttonLabel", 60);
  if ("error" in labelR) return err(labelR.error);
  const buttonLabel = labelR.value || DEFAULT_SSO_BUTTON_LABEL;

  const baseR = optionalTrimmed(s.baseUrl, "baseUrl", 500);
  if ("error" in baseR) return err(baseR.error);
  let baseUrl: string | undefined;
  if (baseR.value) {
    let url: URL;
    try {
      url = new URL(baseR.value);
    } catch {
      return err("baseUrl is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return err("baseUrl must be an http(s) URL");
    }
    if (url.search || url.hash) {
      return err("baseUrl must not contain a query string or fragment");
    }
    baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  }

  const rawDomains = s.allowedDomains;
  const rawEmails = s.allowedEmails;
  if (rawDomains !== undefined && !Array.isArray(rawDomains)) {
    return err("allowedDomains must be an array");
  }
  if (rawEmails !== undefined && !Array.isArray(rawEmails)) {
    return err("allowedEmails must be an array");
  }
  const allowedDomains: string[] = [];
  for (const d of (rawDomains as unknown[] | undefined) ?? []) {
    if (typeof d !== "string" || !d.trim()) continue;
    const domain = d.trim().toLowerCase();
    if (!isValidDomain(domain)) {
      return err(`"${d.trim()}" is not a valid domain`);
    }
    if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
  }
  const allowedEmails: string[] = [];
  for (const e of (rawEmails as unknown[] | undefined) ?? []) {
    if (typeof e !== "string" || !e.trim()) continue;
    const email = e.trim().toLowerCase();
    if (!isValidEmail(email)) {
      return err(`"${e.trim()}" is not a valid email address`);
    }
    if (!allowedEmails.includes(email)) allowedEmails.push(email);
  }
  if (allowedDomains.length > MAX_LIST_ENTRIES) {
    return err(`allowedDomains is capped at ${MAX_LIST_ENTRIES} entries`);
  }
  if (allowedEmails.length > MAX_LIST_ENTRIES) {
    return err(`allowedEmails is capped at ${MAX_LIST_ENTRIES} entries`);
  }

  const passwordLoginEnabled = s.passwordLoginEnabled !== false;
  if (!passwordLoginEnabled && !enabled) {
    return err("Password login can only be turned off while SSO is enabled");
  }

  return {
    settings: {
      enabled,
      issuer,
      clientId,
      clientSecret,
      scopes,
      buttonLabel,
      baseUrl,
      allowedDomains,
      allowedEmails,
      passwordLoginEnabled,
    },
  };
}
