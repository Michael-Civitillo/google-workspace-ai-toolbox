/**
 * Client-safe single sign-on (OpenID Connect) types and provider presets.
 *
 * Kept separate from the server module (`sso-server.ts`) because that module
 * imports `node:fs`, which the Next.js client bundle cannot resolve. The
 * setup wizard and login page import from here only.
 */

export const SSO_PROVIDERS = ["google", "entra", "okta", "generic"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/** Path of the only callback handler; every redirect URI must end here. */
export const SSO_CALLBACK_PATH = "/api/auth/oidc/callback";

/** Scopes requested on every sign-in. Fixed: the app only needs identity. */
export const SSO_SCOPES = "openid email profile";

export interface SsoTestRecord {
  at: string;
  ok: boolean;
  email?: string;
  error?: string;
}

/**
 * The full configuration as stored in sso.json. `clientSecret` is
 * server-only — use PublicSsoConfig for anything that crosses to the browser.
 */
export interface SsoConfig {
  version: 1;
  /** Whether "Sign in with …" is offered on the login page. */
  enabled: boolean;
  provider: SsoProvider;
  /** Label for the login button: "Continue with {displayName}". */
  displayName: string;
  /** OpenID Connect issuer identifier, e.g. https://accounts.google.com */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Absolute URL of this app's callback, as registered with the provider. */
  redirectUri: string;
  /** Lower-cased email domains allowed to sign in. */
  allowedDomains: string[];
  /** Lower-cased individual emails allowed to sign in. */
  allowedEmails: string[];
  /**
   * Accept any account the provider authenticates, relying on the provider's
   * own app assignment. Never allowed for Google, whose accounts are public.
   */
  allowAnyIdpUser: boolean;
  /** Keep the APP_PASSWORD form on the login page as a fallback. */
  passwordLoginEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Outcome of the most recent "Test sign-in" run from the wizard. */
  lastTest?: SsoTestRecord;
}

/** Shape safe to send to the browser: secret stripped, presence flagged. */
export type PublicSsoConfig = Omit<SsoConfig, "clientSecret"> & {
  hasClientSecret: boolean;
};

/** Minimal public view for the login page. */
export interface SsoLoginStatus {
  ssoEnabled: boolean;
  ssoDisplayName: string | null;
  passwordLoginEnabled: boolean;
}

/** Result posted from the test-sign-in popup back to the opener window. */
export interface SsoTestResult {
  type: "gws-sso-test";
  ok: boolean;
  email?: string;
  name?: string;
  sub?: string;
  issuer?: string;
  /** Machine-readable failure code (see OidcErrorCode in oidc.ts). */
  code?: string;
  /** Human-readable summary. */
  message?: string;
  /** Extra diagnostic text (provider error descriptions, claim names…). */
  detail?: string;
  /** Why access was granted or refused by the allowlist. */
  accessReason?: string;
}

/** What the wizard's "Check issuer" step reports back. */
export interface IssuerCheckResult {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  /** true/false when advertised, null when the provider doesn't say. */
  pkceAdvertised: boolean | null;
  scopesSupported: string[];
  claimsSupported: string[];
  signingAlgorithms: string[];
  warnings: string[];
}

/** True for hosts where plain http is acceptable (local development). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".localhost")
  );
}

export interface SsoProviderPreset {
  label: string;
  /** Short blurb shown on the provider card. */
  blurb: string;
  /** Fixed issuer (Google) or null when the admin must supply it. */
  fixedIssuer: string | null;
  issuerPlaceholder: string;
  issuerHint: string;
  consoleUrl: string;
  consoleLabel: string;
  /** Numbered instructions for registering the app with the provider. */
  steps: string[];
  /** Provider-specific caveats surfaced in the wizard. */
  notes: string[];
}

export const SSO_PROVIDER_PRESETS: Record<SsoProvider, SsoProviderPreset> = {
  google: {
    label: "Google Workspace",
    blurb: "Sign in with the same Google accounts you administer.",
    fixedIssuer: "https://accounts.google.com",
    issuerPlaceholder: "https://accounts.google.com",
    issuerHint: "Google's issuer is fixed.",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    consoleLabel: "Open Google Cloud Console → Credentials",
    steps: [
      "In Google Cloud Console open APIs & Services → Credentials, then Create credentials → OAuth client ID.",
      "Pick Web application and add the redirect URI shown below under Authorized redirect URIs.",
      "Copy the Client ID and Client secret — you'll paste them in the next step.",
      "Under Google Auth Platform → Audience keep the user type Internal, so only accounts in your Workspace organization can complete sign-in.",
    ],
    notes: [
      "Google accounts are public, so the allowlist step is mandatory for this provider: at least one domain or email must be listed.",
    ],
  },
  entra: {
    label: "Microsoft Entra ID",
    blurb: "Azure AD / Microsoft 365 accounts via an app registration.",
    fixedIssuer: null,
    issuerPlaceholder: "https://login.microsoftonline.com/<tenant-id>/v2.0",
    issuerHint:
      "Use your Directory (tenant) ID from the app's Overview page — not \"common\" or \"organizations\".",
    consoleUrl:
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    consoleLabel: "Open Microsoft Entra admin center → App registrations",
    steps: [
      "In the Microsoft Entra admin center open App registrations → New registration and choose \"Accounts in this organizational directory only\".",
      "Under Redirect URI select Web and paste the redirect URI shown below.",
      "Open Certificates & secrets → New client secret and copy the secret Value (not the Secret ID).",
      "The Client ID is the Application (client) ID on the Overview page. The issuer is https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0.",
      "Under Token configuration add the optional claim \"email\" for ID tokens so sign-in can read each user's address.",
    ],
    notes: [
      "If the email claim is missing the app falls back to preferred_username, which is normally the user principal name.",
    ],
  },
  okta: {
    label: "Okta",
    blurb: "Okta Workforce Identity org or a custom authorization server.",
    fixedIssuer: null,
    issuerPlaceholder: "https://your-org.okta.com",
    issuerHint:
      "Your Okta org URL, or a custom authorization server such as https://your-org.okta.com/oauth2/default.",
    consoleUrl: "https://login.okta.com/",
    consoleLabel: "Open the Okta Admin Console",
    steps: [
      "In the Okta Admin Console open Applications → Create App Integration → OIDC - OpenID Connect → Web Application.",
      "Paste the redirect URI shown below as the Sign-in redirect URI. Leave sign-out redirects empty.",
      "Under Assignments choose which users or groups may use the app, then copy the Client ID and Client secret.",
      "Use the org URL (or the custom authorization server's issuer URI) as the issuer in the next step.",
    ],
    notes: [
      "Okta only issues tokens for assigned users, so \"allow any account from this provider\" is reasonable when assignment is managed in Okta.",
    ],
  },
  generic: {
    label: "Other OpenID Connect provider",
    blurb: "Auth0, Keycloak, JumpCloud, OneLogin, Authentik and similar.",
    fixedIssuer: null,
    issuerPlaceholder: "https://idp.example.com",
    issuerHint:
      "The app fetches <issuer>/.well-known/openid-configuration to find the provider's endpoints.",
    consoleUrl: "",
    consoleLabel: "",
    steps: [
      "Create a confidential web application that uses the authorization code flow.",
      "Register the redirect URI shown below.",
      "Note the issuer URL, the Client ID and the Client secret for the next step.",
      "Make sure ID tokens include an email claim — the app requests the openid, email and profile scopes.",
    ],
    notes: [
      "ID tokens must be signed with an asymmetric algorithm (RS256, ES256, …) published at the provider's jwks_uri.",
    ],
  },
};

/** Human-readable messages for the `sso_error` codes the callback can emit. */
export const SSO_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Single sign-on isn't configured on this server.",
  disabled: "Single sign-on is currently turned off. Sign in with the password instead.",
  session_expired:
    "The sign-in attempt took too long or the browser lost track of it. Please try again.",
  idp_denied: "Sign-in was cancelled or denied by your identity provider.",
  idp_error: "Your identity provider returned an error. Please try again.",
  exchange_failed:
    "The identity provider accepted your sign-in but Open Admin couldn't complete the handshake. Check the server log.",
  discovery_failed:
    "Open Admin couldn't reach your identity provider. Check the server log.",
  no_email: "Your identity provider didn't share an email address, so access can't be checked.",
  email_unverified: "Your identity provider reports this email address as unverified.",
  not_allowed:
    "This account isn't allowed to use Open Admin. Ask an administrator to add your email or domain.",
  server_error: "Something went wrong on the server while signing you in.",
};
