import * as client from "openid-client";
import { isValidEmail } from "./validate-email";
import {
  isLoopbackHost,
  SSO_SCOPES,
  type IssuerCheckResult,
  type SsoConfig,
} from "./sso-types";

/**
 * OpenID Connect relying-party logic for single sign-on.
 *
 * Built on openid-client, which implements discovery, PKCE, the authorization
 * code grant and ID token validation (issuer, audience, expiry, nonce and —
 * with non-repudiation checks enabled — the JWS signature against the
 * provider's published keys). This module adds what is specific to
 * Open Admin: which provider to talk to, how to remember the in-flight
 * handshake, which claim counts as the user's email, and who is allowed in.
 *
 * Server-only: never import from a client component.
 */

export type OidcErrorCode =
  | "discovery_failed"
  | "idp_denied"
  | "idp_error"
  | "exchange_failed"
  | "no_email"
  | "email_unverified"
  | "not_allowed";

/**
 * A sign-in failure with a stable code the login page can map to a message.
 * `message` is safe to show end users; `detail` is for the server log and the
 * admin-only test popup, because it can echo provider error descriptions.
 */
export class OidcFlowError extends Error {
  constructor(
    public readonly code: OidcErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "OidcFlowError";
  }
}

const REQUEST_TIMEOUT_SECONDS = 15;
const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;
const CONFIG_CACHE_MAX = 8;

const configCache = new Map<
  string,
  { config: client.Configuration; expiresAt: number }
>();

function errorDetail(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Plain http is only ever acceptable against a loopback provider. */
function insecureAllowed(issuer: URL): boolean {
  return issuer.protocol === "http:" && isLoopbackHost(issuer.hostname);
}

/**
 * Fetch and sanity-check the provider's metadata document. Throws a plain
 * Error with an operator-readable message when the document is unreachable
 * or missing something the code flow needs.
 */
async function discoverServer(issuer: URL): Promise<client.ServerMetadata> {
  let probe: client.Configuration;
  try {
    probe = await client.discovery(issuer, "discovery", undefined, client.None(), {
      execute: insecureAllowed(issuer) ? [client.allowInsecureRequests] : [],
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
  } catch (e) {
    throw new Error(
      `Could not load ${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration: ${errorDetail(e)}`
    );
  }
  const server = probe.serverMetadata();
  const missing = (
    ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const
  ).filter((k) => typeof server[k] !== "string" || !server[k]);
  if (missing.length > 0) {
    throw new Error(
      `The provider's discovery document is missing ${missing.join(", ")}, which the authorization code flow requires`
    );
  }
  if (
    Array.isArray(server.response_types_supported) &&
    !server.response_types_supported.includes("code")
  ) {
    throw new Error(
      "The provider does not advertise the authorization code flow (response_type=code)"
    );
  }
  return server;
}

/**
 * Most providers accept the client secret in the POST body; a few only
 * accept HTTP Basic. Follow what the provider advertises, defaulting to POST.
 */
function pickClientAuth(
  server: client.ServerMetadata,
  clientSecret: string
): client.ClientAuth {
  const methods = server.token_endpoint_auth_methods_supported;
  if (
    Array.isArray(methods) &&
    !methods.includes("client_secret_post") &&
    methods.includes("client_secret_basic")
  ) {
    return client.ClientSecretBasic(clientSecret);
  }
  return client.ClientSecretPost(clientSecret);
}

/**
 * Discover the provider and build a configured client, cached briefly so a
 * login doesn't cost a discovery round-trip every time. The cache key includes
 * the config's updatedAt, so re-saving the SSO settings invalidates it.
 */
export async function loadOidcClient(
  cfg: Pick<SsoConfig, "issuer" | "clientId" | "clientSecret" | "updatedAt">
): Promise<client.Configuration> {
  const key = [cfg.issuer, cfg.clientId, cfg.updatedAt].join("\u0000");
  const now = Date.now();
  const hit = configCache.get(key);
  if (hit && hit.expiresAt > now) return hit.config;

  const issuer = new URL(cfg.issuer);
  const server = await discoverServer(issuer);
  const config = new client.Configuration(
    server,
    cfg.clientId,
    cfg.clientSecret,
    pickClientAuth(server, cfg.clientSecret)
  );
  config.timeout = REQUEST_TIMEOUT_SECONDS;
  // Verify ID token signatures against jwks_uri rather than relying on TLS to
  // the token endpoint alone.
  client.enableNonRepudiationChecks(config);
  if (insecureAllowed(issuer)) client.allowInsecureRequests(config);

  configCache.set(key, { config, expiresAt: now + CONFIG_CACHE_TTL_MS });
  while (configCache.size > CONFIG_CACHE_MAX) {
    const oldest = configCache.keys().next().value;
    if (oldest === undefined) break;
    configCache.delete(oldest);
  }
  return config;
}

// ---------------------------------------------------------------------------
// Issuer check (wizard "Check issuer" button)
// ---------------------------------------------------------------------------

/**
 * Fetch discovery for an issuer the admin typed and report what the code
 * flow will rely on, plus soft warnings about anything that commonly bites.
 */
export async function checkIssuer(issuerRaw: string): Promise<IssuerCheckResult> {
  const issuer = new URL(issuerRaw);
  const server = await discoverServer(issuer);
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const warnings: string[] = [];
  const pkce = server.code_challenge_methods_supported;
  let pkceAdvertised: boolean | null = null;
  if (Array.isArray(pkce)) {
    pkceAdvertised = pkce.includes("S256");
    if (!pkceAdvertised) {
      warnings.push(
        "The provider doesn't advertise PKCE (S256). Sign-in still sends a code challenge; the test step will show whether it is accepted."
      );
    }
  }
  const scopes = strings(server.scopes_supported);
  if (scopes.length > 0 && !scopes.includes("email")) {
    warnings.push(
      "The provider doesn't list the \"email\" scope. Sign-in falls back to the preferred_username or upn claims when no email claim is issued."
    );
  }
  const claims = strings(server.claims_supported);
  if (claims.length > 0 && !claims.includes("email")) {
    warnings.push(
      "The provider doesn't list an \"email\" claim. Make sure ID tokens include one (or preferred_username / upn holding an email address)."
    );
  }
  const algs = strings(server.id_token_signing_alg_values_supported);
  if (algs.length > 0 && algs.every((a) => a.startsWith("HS"))) {
    warnings.push(
      "Only symmetric ID token signing (HS*) is advertised. Open Admin verifies signatures against the provider's published keys and needs RS256 / ES256 / PS256."
    );
  }

  return {
    issuer: server.issuer,
    authorizationEndpoint: server.authorization_endpoint as string,
    tokenEndpoint: server.token_endpoint as string,
    jwksUri: server.jwks_uri as string,
    userinfoEndpoint:
      typeof server.userinfo_endpoint === "string" ? server.userinfo_endpoint : null,
    pkceAdvertised,
    scopesSupported: scopes,
    claimsSupported: claims,
    signingAlgorithms: algs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Authorization request / response
// ---------------------------------------------------------------------------

export type OidcMode = "login" | "test";

/** Everything the callback needs to finish what /start began. */
export interface OidcHandshake {
  v: 1;
  state: string;
  nonce: string;
  verifier: string;
  mode: OidcMode;
  /** Validated internal path to land on after a login-mode success. */
  next: string;
  /**
   * Test mode only: who started the test, for the audit entry. Captured at
   * /start, which the browser reaches by a same-origin navigation that carries
   * the Strict session cookie; the callback arrives from the provider's
   * cross-site redirect, where that cookie is withheld.
   */
  actor?: string;
}

export async function beginOidcAuthorization(
  cfg: SsoConfig,
  mode: OidcMode,
  next: string,
  actor?: string
): Promise<{ url: URL; handshake: OidcHandshake }> {
  const config = await loadOidcClient(cfg);
  const verifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const params: Record<string, string> = {
    redirect_uri: cfg.redirectUri,
    scope: SSO_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };
  // When testing, let the admin choose the account explicitly instead of the
  // provider silently reusing whatever session the browser already has.
  if (mode === "test") params.prompt = "select_account";
  // Google honours `hd` as a hint to preselect the Workspace domain; the
  // allowlist is still enforced server-side on the returned claims.
  if (cfg.provider === "google" && cfg.allowedDomains.length === 1) {
    params.hd = cfg.allowedDomains[0];
  }

  const url = client.buildAuthorizationUrl(config, params);
  const handshake: OidcHandshake = { v: 1, state, nonce, verifier, mode, next };
  if (mode === "test" && actor) handshake.actor = actor;
  return { url, handshake };
}

export interface OidcIdentity {
  sub: string;
  /** Lower-cased email the allowlist is evaluated against. */
  email: string;
  emailSource: "email" | "preferred_username" | "upn";
  /** null when the provider didn't say (or the address came from a fallback claim). */
  emailVerified: boolean | null;
  name: string | null;
}

function describeOAuthError(error: string, description?: string): string {
  return description ? `${error}: ${description}` : error;
}

function mapExchangeError(e: unknown): OidcFlowError {
  if (e instanceof client.AuthorizationResponseError) {
    const denied = [
      "access_denied",
      "login_required",
      "interaction_required",
      "consent_required",
      "account_selection_required",
    ].includes(e.error);
    return new OidcFlowError(
      denied ? "idp_denied" : "idp_error",
      denied
        ? "Sign-in was cancelled or denied at the identity provider"
        : "The identity provider returned an error",
      describeOAuthError(e.error, e.error_description)
    );
  }
  if (e instanceof client.ResponseBodyError) {
    return new OidcFlowError(
      "exchange_failed",
      "The identity provider rejected the token exchange",
      `${describeOAuthError(e.error, e.error_description)} (HTTP ${e.status})`
    );
  }
  if (e instanceof client.ClientError) {
    return new OidcFlowError(
      "exchange_failed",
      "The sign-in response failed validation",
      `${e.code ?? "client_error"}: ${errorDetail(e)}`
    );
  }
  return new OidcFlowError(
    "exchange_failed",
    "Could not complete the sign-in handshake",
    errorDetail(e)
  );
}

function parseVerified(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function pickName(claims: client.IDToken): string | null {
  if (typeof claims.name === "string" && claims.name.trim()) {
    return claims.name.trim();
  }
  const given = typeof claims.given_name === "string" ? claims.given_name.trim() : "";
  const family =
    typeof claims.family_name === "string" ? claims.family_name.trim() : "";
  const joined = `${given} ${family}`.trim();
  return joined || null;
}

/**
 * Pull the identity out of validated ID token claims. `email` is preferred;
 * Entra ID commonly omits it unless the optional claim is configured, so
 * `preferred_username` and `upn` are accepted when they hold an address.
 */
export function extractIdentity(claims: client.IDToken): OidcIdentity {
  const candidates: Array<[OidcIdentity["emailSource"], unknown]> = [
    ["email", claims.email],
    ["preferred_username", claims.preferred_username],
    ["upn", claims.upn],
  ];
  let email: string | null = null;
  let emailSource: OidcIdentity["emailSource"] = "email";
  for (const [source, value] of candidates) {
    if (typeof value === "string" && isValidEmail(value.trim())) {
      email = value.trim().toLowerCase();
      emailSource = source;
      break;
    }
  }
  if (!email) {
    throw new OidcFlowError(
      "no_email",
      "The identity provider did not include a usable email address in the ID token",
      `claims present: ${Object.keys(claims).join(", ")}`
    );
  }

  const emailVerified =
    emailSource === "email" ? parseVerified(claims.email_verified) : null;
  if (emailVerified === false) {
    throw new OidcFlowError(
      "email_unverified",
      "The identity provider reports this email address as unverified",
      email
    );
  }

  return {
    sub: String(claims.sub),
    email,
    emailSource,
    emailVerified,
    name: pickName(claims),
  };
}

/**
 * Finish the code flow: validate the authorization response against the
 * handshake, exchange the code, validate the ID token and extract who it is.
 */
export async function completeOidcAuthorization(
  cfg: SsoConfig,
  callbackSearch: string,
  handshake: OidcHandshake
): Promise<{ identity: OidcIdentity; claimNames: string[] }> {
  let config: client.Configuration;
  try {
    config = await loadOidcClient(cfg);
  } catch (e) {
    throw new OidcFlowError(
      "discovery_failed",
      "Could not reach the identity provider",
      errorDetail(e)
    );
  }

  // Reconstruct the URL the provider redirected to from the registered
  // redirect URI plus the incoming query, rather than trusting the request's
  // own view of its host — a reverse proxy would otherwise make redirect_uri
  // at the token endpoint disagree with the one used in the authorization
  // request.
  const currentUrl = new URL(cfg.redirectUri);
  currentUrl.search = callbackSearch;

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: handshake.state,
      expectedNonce: handshake.nonce,
      pkceCodeVerifier: handshake.verifier,
      idTokenExpected: true,
    });
  } catch (e) {
    throw mapExchangeError(e);
  }

  const claims = tokens.claims();
  if (!claims) {
    throw new OidcFlowError(
      "exchange_failed",
      "The identity provider did not return an ID token"
    );
  }
  return { identity: extractIdentity(claims), claimNames: Object.keys(claims) };
}

// ---------------------------------------------------------------------------
// Access policy
// ---------------------------------------------------------------------------

export interface SsoAccessDecision {
  allowed: boolean;
  /** Plain-language explanation shown in the test popup and the audit log. */
  reason: string;
}

export function evaluateSsoAccess(
  cfg: Pick<SsoConfig, "allowedDomains" | "allowedEmails" | "allowAnyIdpUser">,
  email: string
): SsoAccessDecision {
  const normalized = email.toLowerCase();
  const domain = normalized.slice(normalized.indexOf("@") + 1);
  if (cfg.allowedEmails.includes(normalized)) {
    return { allowed: true, reason: `${normalized} is on the allowed email list` };
  }
  if (cfg.allowedDomains.includes(domain)) {
    return { allowed: true, reason: `the domain ${domain} is allowed` };
  }
  if (cfg.allowAnyIdpUser) {
    return {
      allowed: true,
      reason: "any account the identity provider authenticates is allowed",
    };
  }
  return {
    allowed: false,
    reason: `${normalized} is not an allowed email and ${domain} is not an allowed domain`,
  };
}
