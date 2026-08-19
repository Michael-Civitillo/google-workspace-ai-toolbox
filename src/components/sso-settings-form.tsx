"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PlugZap,
  Save,
} from "lucide-react";
import {
  DEFAULT_OIDC_SCOPES,
  DEFAULT_SSO_BUTTON_LABEL,
  OIDC_CALLBACK_PATH,
  type PublicOidcSettings,
} from "@/lib/app-config-types";

/**
 * Full OIDC single sign-on settings form. Self-contained: loads the current
 * config on mount, tests discovery against the issuer, and saves via
 * PUT /api/config/sso. Used by both the onboarding wizard and App Settings so
 * the two can never drift.
 */

interface FormState {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string; // always starts blank; blank = keep saved secret
  hasSavedSecret: boolean;
  scopes: string;
  buttonLabel: string;
  baseUrl: string;
  allowedDomains: string; // comma-separated in the form
  allowedEmails: string;
  passwordLoginEnabled: boolean;
}

const emptyForm = (): FormState => ({
  enabled: false,
  issuer: "",
  clientId: "",
  clientSecret: "",
  hasSavedSecret: false,
  scopes: DEFAULT_OIDC_SCOPES,
  buttonLabel: DEFAULT_SSO_BUTTON_LABEL,
  baseUrl: "",
  allowedDomains: "",
  allowedEmails: "",
  passwordLoginEnabled: true,
});

function fromPublic(sso: PublicOidcSettings | null): FormState {
  if (!sso) return emptyForm();
  return {
    enabled: sso.enabled,
    issuer: sso.issuer,
    clientId: sso.clientId,
    clientSecret: "",
    hasSavedSecret: sso.hasClientSecret,
    scopes: sso.scopes || DEFAULT_OIDC_SCOPES,
    buttonLabel: sso.buttonLabel || DEFAULT_SSO_BUTTON_LABEL,
    baseUrl: sso.baseUrl ?? "",
    allowedDomains: sso.allowedDomains.join(", "),
    allowedEmails: sso.allowedEmails.join(", "),
    passwordLoginEnabled: sso.passwordLoginEnabled,
  };
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type TestResult =
  | { kind: "ok"; authorizationEndpoint: string | null; tokenEndpoint: string | null }
  | { kind: "error"; message: string };

export function SsoSettingsForm({
  onSaved,
}: {
  onSaved?: (sso: PublicOidcSettings | null) => void;
}) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setForm(fromPublic(data?.sso ?? null));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedAt(null);
  }

  const redirectUri = `${(form.baseUrl.trim() || origin).replace(/\/+$/, "")}${OIDC_CALLBACK_PATH}`;

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/config/sso/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuer: form.issuer.trim(),
          clientId: form.clientId.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          kind: "ok",
          authorizationEndpoint: data.authorizationEndpoint ?? null,
          tokenEndpoint: data.tokenEndpoint ?? null,
        });
      } else {
        setTestResult({
          kind: "error",
          message: data.error ?? "Discovery failed",
        });
      }
    } catch {
      setTestResult({ kind: "error", message: "Network error while testing" });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config/sso", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          issuer: form.issuer.trim(),
          clientId: form.clientId.trim(),
          // Blank keeps the stored secret — the server never echoes it back.
          clientSecret: form.clientSecret.trim() || undefined,
          scopes: form.scopes.trim(),
          buttonLabel: form.buttonLabel.trim(),
          baseUrl: form.baseUrl.trim() || undefined,
          allowedDomains: splitList(form.allowedDomains),
          allowedEmails: splitList(form.allowedEmails),
          passwordLoginEnabled: form.passwordLoginEnabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Failed to save SSO settings");
        return;
      }
      setForm(fromPublic(data.sso ?? null));
      setSavedAt(Date.now());
      onSaved?.(data.sso ?? null);
    } catch {
      setError("Network error — settings not saved");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading SSO settings...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
          <AlertCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-sm text-red-800 dark:text-red-300">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {savedAt && (
        <Alert className="border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <AlertDescription className="text-sm text-emerald-800 dark:text-emerald-300">
            SSO settings saved.{" "}
            {form.enabled &&
              "Open a private/incognito window and test the SSO button before signing out here."}
          </AlertDescription>
        </Alert>
      )}

      <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span>
          <span className="text-sm font-medium block">Enable SSO (OIDC)</span>
          <span className="text-xs text-muted-foreground block mt-0.5">
            Adds a single sign-on button to the login page. Works with any
            OpenID Connect provider — Google, Microsoft Entra ID, Okta,
            Keycloak, Authentik, and friends.
          </span>
        </span>
      </label>

      <div className="space-y-1.5">
        <Label htmlFor="sso-issuer" className="text-xs">
          Issuer URL <span className="text-red-500">*</span>
        </Label>
        <Input
          id="sso-issuer"
          value={form.issuer}
          onChange={(e) => set("issuer", e.target.value)}
          placeholder="https://accounts.google.com"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          The provider&apos;s issuer identifier. Discovery metadata is loaded from{" "}
          <code className="font-mono bg-muted px-1 rounded">
            &lt;issuer&gt;/.well-known/openid-configuration
          </code>
          . Examples:{" "}
          <code className="font-mono bg-muted px-1 rounded">https://accounts.google.com</code>,{" "}
          <code className="font-mono bg-muted px-1 rounded">
            https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0
          </code>
          ,{" "}
          <code className="font-mono bg-muted px-1 rounded">
            https://&lt;org&gt;.okta.com
          </code>
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={testConnection}
          disabled={testing || !form.issuer.trim()}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <PlugZap className="h-3.5 w-3.5 mr-1.5" />
          )}
          {testing ? "Testing..." : "Test connection"}
        </Button>
        {testResult?.kind === "ok" && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1.5 min-w-0">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Discovery OK — endpoints found at{" "}
              {testResult.authorizationEndpoint ?? "provider"}
            </span>
          </span>
        )}
        {testResult?.kind === "error" && (
          <span className="text-xs text-red-600 dark:text-red-400 inline-flex items-center gap-1.5 min-w-0">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{testResult.message}</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="sso-client-id" className="text-xs">
            Client ID <span className="text-red-500">*</span>
          </Label>
          <Input
            id="sso-client-id"
            value={form.clientId}
            onChange={(e) => set("clientId", e.target.value)}
            placeholder="toolbox"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sso-client-secret" className="text-xs">
            Client secret{" "}
            {form.hasSavedSecret ? (
              <Badge
                variant="outline"
                className="ml-1 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50"
              >
                saved
              </Badge>
            ) : (
              <span className="text-muted-foreground">(blank for PKCE-only public clients)</span>
            )}
          </Label>
          <Input
            id="sso-client-secret"
            type="password"
            value={form.clientSecret}
            onChange={(e) => set("clientSecret", e.target.value)}
            placeholder={
              form.hasSavedSecret ? "•••••• (leave blank to keep)" : ""
            }
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Redirect URI (register this at your provider)</Label>
        <div className="relative">
          <pre className="text-xs font-mono bg-muted rounded-lg p-3 pr-20 overflow-x-auto">
            {redirectUri}
          </pre>
          <CopyButton value={redirectUri} className="absolute top-1.5 right-1.5" />
        </div>
        <p className="text-xs text-muted-foreground">
          Add this as an allowed redirect / callback URL in the provider&apos;s app
          registration.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sso-base-url" className="text-xs">
          Public base URL <span className="text-muted-foreground">(recommended behind a reverse proxy)</span>
        </Label>
        <Input
          id="sso-base-url"
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={origin || "https://toolbox.yourdomain.com"}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          The URL users reach this app on. Leave blank to use each request&apos;s
          own origin — fine for direct access, unreliable behind proxies.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="sso-domains" className="text-xs">
            Allowed email domains
          </Label>
          <Input
            id="sso-domains"
            value={form.allowedDomains}
            onChange={(e) => set("allowedDomains", e.target.value)}
            placeholder="yourdomain.com, sub.yourdomain.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sso-emails" className="text-xs">
            Allowed emails
          </Label>
          <Input
            id="sso-emails"
            value={form.allowedEmails}
            onChange={(e) => set("allowedEmails", e.target.value)}
            placeholder="admin@yourdomain.com, ops@yourdomain.com"
          />
        </div>
      </div>
      <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
        <AlertCircle className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-xs text-amber-800 dark:text-amber-300">
          With both lists empty, <strong>anyone your IdP authenticates</strong>{" "}
          can administer this toolbox. Restrict it to your admin domain or to
          specific emails unless the IdP app itself is locked down.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="sso-scopes" className="text-xs">
            Scopes
          </Label>
          <Input
            id="sso-scopes"
            value={form.scopes}
            onChange={(e) => set("scopes", e.target.value)}
            placeholder={DEFAULT_OIDC_SCOPES}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Space-separated. <code className="font-mono bg-muted px-1 rounded">openid</code> is always included.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sso-label" className="text-xs">
            Login button label
          </Label>
          <Input
            id="sso-label"
            value={form.buttonLabel}
            onChange={(e) => set("buttonLabel", e.target.value)}
            placeholder={DEFAULT_SSO_BUTTON_LABEL}
          />
        </div>
      </div>

      <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
        <input
          type="checkbox"
          checked={form.passwordLoginEnabled}
          onChange={(e) => set("passwordLoginEnabled", e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span>
          <span className="text-sm font-medium block">
            Keep password login available
          </span>
          <span className="text-xs text-muted-foreground block mt-0.5">
            Leave this on until SSO is proven working. If you turn it off and
            SSO breaks, set{" "}
            <code className="font-mono bg-muted px-1 rounded">SSO_RESCUE=true</code>{" "}
            in the server environment to restore the password form.
          </span>
        </span>
      </label>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1.5" />
          )}
          {saving ? "Saving..." : "Save SSO settings"}
        </Button>
      </div>
    </div>
  );
}
