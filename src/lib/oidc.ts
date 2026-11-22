import * as client from "openid-client";
import { isValidEmail } from "./validate-email";
import {
  hostResolvesPrivate,
  isPlainlyPrivateHost,
  isPrivateIssuerHost,
  privateIssuerAllowed,
  PRIVATE_ISSUER_REFUSED,
} from "./sso-server";
import {
  isLoopbackHost,
  issuerFamily,
  SSO_SCOPES,
  type IssuerCheckResult,
  type IssuerFamily,
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
  public readonly detail?: string;
  constructor(
    public readonly code: OidcErrorCode,
    message: string,
    detail?: string
  ) {
    super(message);
    this.name = "OidcFlowError";
    // Details can carry text the caller chose (an error_description on the
    // callback URL) and end up in the audit log and the server log.
    this.detail =
      detail === undefined ? undefined : detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
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
 * A request that never got an answer (refused, DNS, TLS, timeout) surfaces as
 * a TypeError or an abort; anything else means the host did answer, just not
 * with metadata this app can use. Callers only ever learn which of the two.
 */
function unreachable(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  // openid-client turns its own timeout into a ClientError with a code.
  const code = (e as { code?: unknown } | null)?.code;
  return code === "OAUTH_TIMEOUT" || code === "OAUTH_ABORT";
}

/**
 * When a destination is being judged: "setup" is an issuer being checked in
 * the wizard, where the admin sees the refusal and can act on it; "sign-in"
 * is a saved configuration being used.
 */
type CheckMode = "setup" | "sign-in";

/**
 * Refuse a URL the server would fetch if it points into the server's own
 * network. Applied to the issuer before discovery and to every endpoint the
 * discovery document then names, which the server also fetches (the token
 * exchange carries the client secret).
 *
 * At setup the check is the full one: by the URL's text (private literals,
 * single-label and internal names) and by what the name resolves to now. At
 * sign-in the saved issuer is held to the long-standing text rule only, and
 * so are endpoints on the issuer's own host: a provider on the install's own
 * network that worked before must keep working. An endpoint on some other
 * host still gets the full text rule, so a discovery document can't simply
 * name an internal address.
 *
 * A name can still change what it resolves to between this check and the
 * fetch; this closes the plain cases, it is not a full egress firewall.
 */
async function assertPublicDestination(
  raw: string,
  what: string,
  mode: CheckMode,
  issuerHost?: string
): Promise<void> {
  if (privateIssuerAllowed()) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcFlowError("discovery_failed", `The provider's ${what} is not a valid URL`);
  }
  const host = url.hostname;
  const refused =
    mode === "setup"
      ? isPrivateIssuerHost(host) || (await hostResolvesPrivate(host))
      : what === "issuer" || host === issuerHost
        ? isPlainlyPrivateHost(host)
        : isPrivateIssuerHost(host);
  if (refused) {
    const message =
      what === "issuer"
        ? `The ${PRIVATE_ISSUER_REFUSED}`
        : `The provider's ${what} points at a private or internal address, which the server won't contact. Set APP_SSO_ALLOW_PRIVATE_ISSUER=true on the server to use an identity provider on your own network.`;
    // Said in the log as well: at sign-in the person sees only that single
    // sign-on failed, and whoever runs the server needs the reason.
    console.error(`[sso] refused ${what} ${url.origin}: ${message}`);
    throw new OidcFlowError("discovery_failed", message);
  }
}

/**
 * Fetch and sanity-check the provider's metadata document. Throws an
 * OidcFlowError whose `message` is safe to show: the raw failure text would
 * otherwise tell the caller which ports answer on the server's own network,
 * so it goes to the service log instead.
 */
async function discoverServer(
  issuer: URL,
  mode: CheckMode
): Promise<client.ServerMetadata> {
  // Belt and braces: validateIssuer already refuses these, but a hand-edited
  // sso.json would otherwise have the server dial its own network.
  await assertPublicDestination(issuer.href, "issuer", mode);
  let probe: client.Configuration;
  try {
    probe = await client.discovery(issuer, "discovery", undefined, client.None(), {
      execute: insecureAllowed(issuer) ? [client.allowInsecureRequests] : [],
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
  } catch (e) {
    console.error(
      `[sso] discovery failed for ${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration: ${errorDetail(e)}`
    );
    throw new OidcFlowError(
      "discovery_failed",
      unreachable(e)
        ? "The issuer could not be reached — see the server log for the reason"
        : "The issuer did not return valid OpenID metadata — see the server log for the reason"
    );
  }
  const server = probe.serverMetadata();
  const missing = (
    ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const
  ).filter((k) => typeof server[k] !== "string" || !server[k]);
  if (missing.length > 0) {
    throw new OidcFlowError(
      "discovery_failed",
      `The provider's discovery document is missing ${missing.join(", ")}, which the authorization code flow requires`
    );
  }
  if (
    Array.isArray(server.response_types_supported) &&
    !server.response_types_supported.includes("code")
  ) {
    throw new OidcFlowError(
      "discovery_failed",
      "The provider does not advertise the authorization code flow (response_type=code)"
    );
  }
  // Entra's multi-tenant endpoints publish a template issuer that no sign-in
  // can match once the client is built from saved metadata, so every sign-in
  // would fail with a generic error after a green issuer check.
  if (typeof server.issuer === "string" && server.issuer.includes("{tenantid}")) {
    throw new OidcFlowError(
      "discovery_failed",
      "This is Entra ID's shared multi-tenant endpoint. Use your own tenant's issuer instead: https://login.microsoftonline.com/<your tenant ID>/v2.0"
    );
  }
  // The server fetches these itself.
  const host = issuer.hostname;
  await assertPublicDestination(server.token_endpoint as string, "token endpoint", mode, host);
  await assertPublicDestination(
    server.jwks_uri as string,
    "signing keys address (jwks_uri)",
    mode,
    host
  );
  if (typeof server.userinfo_endpoint === "string") {
    await assertPublicDestination(server.userinfo_endpoint, "userinfo endpoint", mode, host);
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
  const server = await discoverServer(issuer, "sign-in");
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
export async function checkIssuer(
  issuerRaw: string,
  opts: {
    /** This is the issuer already saved, being checked again. */
    inUse?: boolean;
  } = {}
): Promise<IssuerCheckResult> {
  const issuer = new URL(issuerRaw);
  const server = await discoverServer(issuer, opts.inUse ? "sign-in" : "setup");
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
  // allowlist (and the hd claim) are still enforced server-side.
  if (issuerFamily(cfg.issuer) === "google" && cfg.allowedDomains.length === 1) {
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
  /**
   * Google's `hd` claim: the Google Workspace (or Cloud Identity) domain the
   * account belongs to. Absent for a personal Google account, including one
   * created on a company address.
   */
  hostedDomain: string | null;
}

function describeOAuthError(error: string, description?: string): string {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
  return description ? `${clip(error, 60)}: ${clip(description, 240)}` : clip(error, 60);
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
 * Whether an address the provider has not marked verified may sign in.
 *
 * Off by default: a session here is full tenant admin, and against a provider
 * where users manage their own email (Keycloak with verification disabled, an
 * Auth0 database connection) an unverified claim means a user can present an
 * allowlisted address they do not own. Named in the refusal so an operator who
 * knows their provider — one that simply omits the claim for admin-managed
 * accounts — can restore the old behaviour instead of being locked out.
 */
function unverifiedEmailAllowed(): boolean {
  return process.env.APP_SSO_TRUST_UNVERIFIED_EMAIL === "true";
}

/**
 * Pull the identity out of validated ID token claims.
 *
 * The address is the `email` claim, or failing that `preferred_username`,
 * then `upn`: the order every release has used, so the address an allowlist
 * is matched against doesn't change under an existing install.
 *
 * How much it must be vouched for depends on the issuer (never on the
 * provider picked in the wizard):
 *
 *   - Entra ID workforce tenants: accepted as sent. Entra doesn't issue
 *     `email_verified`, and the address comes from a directory only its own
 *     administrators write to. Only a single tenant's issuer can be
 *     configured (the shared multi-tenant endpoints are refused at
 *     discovery), which is what makes that directory the trusted one.
 *   - Everyone else: `email` must come with `email_verified: true`;
 *     `preferred_username` and `upn` only when the operator set
 *     APP_SSO_TRUST_UNVERIFIED_EMAIL=true.
 *
 * An address the provider marks unverified is refused whoever it is.
 */
export function extractIdentity(
  claims: client.IDToken,
  family: IssuerFamily = "other"
): OidcIdentity {
  const entra = family === "entra";
  // The same order for every provider, and the same one every release has
  // used: the address checked against the allowlist must not change under
  // an install whose list names mail addresses.
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
  // An address must be vouched for by the provider: an absent claim, or an
  // address taken from preferred_username or upn, is refused unless the
  // operator says otherwise. Entra ID is the exception, as it always was: it
  // doesn't issue email_verified, and names people from its own directory.
  // What decides "this is Entra" is the issuer the token was checked against,
  // not the provider picked in the menu.
  if (emailVerified !== true && !entra && !unverifiedEmailAllowed()) {
    throw new OidcFlowError(
      "email_unverified",
      emailSource === "email"
        ? "The identity provider did not confirm this email address is verified (no email_verified claim). Add the claim, or set APP_SSO_TRUST_UNVERIFIED_EMAIL=true on the server to accept it as-is."
        : `The identity provider supplied the address through ${emailSource} rather than a verified email claim. Configure the email claim, or set APP_SSO_TRUST_UNVERIFIED_EMAIL=true on the server to accept it as-is.`,
      email
    );
  }

  const hd = (claims as Record<string, unknown>).hd;
  return {
    sub: String(claims.sub),
    email,
    emailSource,
    emailVerified,
    name: pickName(claims),
    hostedDomain: typeof hd === "string" && hd.trim() ? hd.trim().toLowerCase() : null,
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
    // discoverServer already produced a shareable verdict (and logged the
    // detail); only other failures need wrapping.
    if (e instanceof OidcFlowError) throw e;
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
  return {
    identity: extractIdentity(claims, issuerFamily(cfg.issuer)),
    claimNames: Object.keys(claims),
  };
}

// ---------------------------------------------------------------------------
// Access policy
// ---------------------------------------------------------------------------

export interface SsoAccessDecision {
  allowed: boolean;
  /** Plain-language explanation shown in the test popup and the audit log. */
  reason: string;
}

/**
 * Who may sign in.
 *
 * An address on the explicit list always may. A domain match is enough for
 * most providers, but not for Google: anyone can create a personal Google
 * account on a company address (a group's address, an alias, a shared
 * mailbox), and Google will vouch for that email. Such an account carries no
 * `hd` claim; an account in a Google Workspace or Cloud Identity organisation
 * does. Since a domain can belong to only one such organisation, "has an hd
 * claim and an allowed email domain" means "is in the organisation that owns
 * the domain". Google's own guidance is to check hd for exactly this.
 */
export function evaluateSsoAccess(
  cfg: Pick<SsoConfig, "issuer" | "allowedDomains" | "allowedEmails" | "allowAnyIdpUser">,
  identity: Pick<OidcIdentity, "email" | "hostedDomain">
): SsoAccessDecision {
  const normalized = identity.email.toLowerCase();
  const domain = normalized.slice(normalized.indexOf("@") + 1);
  const google = issuerFamily(cfg.issuer) === "google";
  if (cfg.allowedEmails.includes(normalized)) {
    return { allowed: true, reason: `${normalized} is on the allowed email list` };
  }
  if (cfg.allowedDomains.includes(domain)) {
    if (google && !identity.hostedDomain) {
      return {
        allowed: false,
        reason: `${normalized} is a personal Google account, not one in your Google Workspace. Only accounts in the organisation that owns ${domain} may sign in by domain; add the address to the allowed email list to let this one in.`,
      };
    }
    return { allowed: true, reason: `the domain ${domain} is allowed` };
  }
  if (cfg.allowAnyIdpUser && !google) {
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
