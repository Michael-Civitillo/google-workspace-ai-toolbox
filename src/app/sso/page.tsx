"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/copy-button";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { SsoSetupWizard } from "@/components/sso-setup-wizard";
import { SsoTestResultPanel } from "@/components/sso-test-result";
import {
  loadSsoConfig,
  removeSsoConfig,
  runSsoTest,
  saveSsoConfig,
  formatTimestamp,
  type SsoConfigResponse,
} from "@/lib/sso-client";
import {
  SSO_PROVIDER_PRESETS,
  type PublicSsoConfig,
  type SsoTestResult,
} from "@/lib/sso-types";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Power,
  PowerOff,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SsoTestResult };

export default function SsoPage() {
  const [data, setData] = useState<SsoConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busy, setBusy] = useState<"enable" | "disable" | "remove" | null>(null);
  const [confirm, setConfirm] = useState<"enable" | "remove" | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const cancelTestRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadSsoConfig());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => cancelTestRef.current();
  }, [load]);

  const config = data?.config ?? null;
  const envDisabled = data?.envDisabled ?? false;

  function applySaved(cfg: PublicSsoConfig) {
    setData((d) => (d ? { ...d, config: cfg } : { config: cfg, envDisabled: false, configPath: "" }));
  }

  async function setEnabled(enabled: boolean) {
    setBusy(enabled ? "enable" : "disable");
    setError(null);
    try {
      applySaved(await saveSsoConfig({ enabled }));
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await removeSsoConfig();
      setConfirm(null);
      setTest({ kind: "idle" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(null);
    }
  }

  function startTest() {
    cancelTestRef.current();
    setTest({ kind: "running" });
    cancelTestRef.current = runSsoTest((result) => {
      setTest({ kind: "done", result });
      // The callback records the outcome on the config — refresh "last test".
      void load();
    });
  }

  const preset = config ? SSO_PROVIDER_PRESETS[config.provider] : null;
  const live = !!config?.enabled && !envDisabled;
  // Turning the password form off is the one lockout-capable switch: demand a
  // passing test first, and a typed confirmation on top.
  const enableNeedsTest = !!config && !config.passwordLoginEnabled && !config.lastTest?.ok;

  return (
    <>
      <PageHeader
        title="Single Sign-On"
        description="Let admins sign in with your identity provider through OpenID Connect, instead of (or alongside) the shared password."
      />

      <div className="max-w-3xl space-y-6">
        {error && (
          <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {envDisabled && (
          <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
              <code className="font-mono">APP_SSO_DISABLED=true</code> is set on the
              server, so single sign-on is switched off and password login is
              available regardless of the configuration below.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <KeyRound className="h-5 w-5" />
                  Identity provider
                </CardTitle>
                <CardDescription className="mt-1">
                  {config
                    ? "The OpenID Connect client the login page uses."
                    : "Not configured — the login page only offers the password form."}
                </CardDescription>
              </div>
              {config && (
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0",
                    live
                      ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50"
                      : "bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800"
                  )}
                  data-testid="sso-status-badge"
                >
                  {live ? "Enabled" : envDisabled ? "Disabled by server" : "Disabled"}
                </Badge>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {loading && !data ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            ) : !config ? (
              <div className="py-8 text-center">
                <KeyRound className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  No identity provider connected yet.
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  The setup wizard walks through registering the toolbox with
                  Google, Microsoft Entra ID, Okta or any other OpenID Connect
                  provider, tests a real sign-in, and only then enables it.
                </p>
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => setWizardOpen(true)}
                  data-testid="sso-setup"
                >
                  <KeyRound className="h-4 w-4 mr-1.5" />
                  Set up single sign-on
                </Button>
              </div>
            ) : (
              <>
                <dl className="divide-y rounded-lg border text-sm">
                  <Row label="Provider" value={preset?.label ?? config.provider} />
                  <Row label="Login button" value={`Continue with ${config.displayName}`} />
                  <Row label="Issuer" value={config.issuer} mono />
                  <Row label="Client ID" value={config.clientId} mono />
                  <Row
                    label="Client secret"
                    value={config.hasClientSecret ? "stored" : "missing"}
                  />
                  <Row
                    label="Redirect URI"
                    value={config.redirectUri}
                    mono
                    action={<CopyButton value={config.redirectUri} />}
                  />
                  <Row
                    label="Allowed domains"
                    value={
                      config.allowedDomains.length
                        ? config.allowedDomains.join(", ")
                        : "none"
                    }
                    mono={config.allowedDomains.length > 0}
                  />
                  <Row
                    label="Allowed addresses"
                    value={
                      config.allowedEmails.length
                        ? config.allowedEmails.join(", ")
                        : "none"
                    }
                    mono={config.allowedEmails.length > 0}
                  />
                  {config.allowAnyIdpUser && (
                    <Row label="Any provider account" value="allowed" />
                  )}
                  <Row
                    label="Password fallback"
                    value={config.passwordLoginEnabled ? "on" : "off (single sign-on only)"}
                  />
                  <Row
                    label="Last test"
                    value={
                      config.lastTest
                        ? `${config.lastTest.ok ? "passed" : "failed"} · ${formatTimestamp(
                            config.lastTest.at
                          )}${config.lastTest.email ? ` · ${config.lastTest.email}` : ""}${
                            !config.lastTest.ok && config.lastTest.error
                              ? ` · ${config.lastTest.error}`
                              : ""
                          }`
                        : "never"
                    }
                    icon={
                      config.lastTest ? (
                        config.lastTest.ok ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )
                      ) : undefined
                    }
                  />
                </dl>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setWizardOpen(true)}
                    disabled={busy !== null}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={startTest}
                    disabled={test.kind === "running" || busy !== null}
                    data-testid="sso-page-test"
                  >
                    {test.kind === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {test.kind === "running" ? "Waiting for the pop-up…" : "Test sign-in"}
                  </Button>
                  {config.enabled ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void setEnabled(false)}
                      disabled={busy !== null}
                      data-testid="sso-disable"
                    >
                      {busy === "disable" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <PowerOff className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Disable
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() =>
                        config.passwordLoginEnabled
                          ? void setEnabled(true)
                          : setConfirm("enable")
                      }
                      disabled={busy !== null || enableNeedsTest}
                      title={
                        enableNeedsTest
                          ? "Password sign-in is off in this configuration — run a passing test sign-in first"
                          : undefined
                      }
                      data-testid="sso-page-enable"
                    >
                      {busy === "enable" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Power className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Enable
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirm("remove")}
                    disabled={busy !== null}
                    className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 ml-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    Remove
                  </Button>
                </div>

                {enableNeedsTest && (
                  <p className="text-xs text-muted-foreground">
                    This configuration turns password sign-in off, so a passing
                    test sign-in is required before it can be enabled.
                  </p>
                )}

                {test.kind === "done" && <SsoTestResultPanel result={test.result} />}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">How single sign-on works here</p>
              <ul className="space-y-1.5 list-disc list-inside">
                <li>
                  The login page sends the browser to your provider (authorization
                  code flow with PKCE); the provider sends it back with a signed ID
                  token that the server verifies against the provider&apos;s
                  published keys.
                </li>
                <li>
                  The email in that token is checked against the allowed domains
                  and addresses. Anyone who passes gets the same 12-hour session
                  as a password login, and audit-log entries record their email.
                </li>
                <li>
                  Signing out of the toolbox does not sign out of the provider.
                </li>
                <li>
                  The configuration (including the client secret) lives in{" "}
                  <code className="font-mono text-xs">{data?.configPath || "sso.json"}</code>{" "}
                  with owner-only permissions. Point{" "}
                  <code className="font-mono text-xs">SSO_CONFIG_PATH</code> elsewhere
                  to relocate it.
                </li>
                <li>
                  Locked out? Set <code className="font-mono text-xs">APP_SSO_DISABLED=true</code>{" "}
                  on the server (or delete the file) to switch single sign-on off and
                  bring the password form back.
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <SsoSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        existing={config}
        onSaved={(cfg) => {
          applySaved(cfg);
          void load();
        }}
      />

      <ConfirmActionDialog
        open={confirm === "enable"}
        onOpenChange={(o) => busy === null && !o && setConfirm(null)}
        title="Enable single sign-on"
        summary="This configuration turns the password form off: from now on only accounts your identity provider vouches for (and the allowlist accepts) can sign in."
        tenant={null}
        severity="high"
        confirmPhrase="ENABLE SSO"
        confirmLabel="Enable single sign-on"
        busy={busy === "enable"}
        changes={[
          { label: "Login page", before: "password form", after: `Continue with ${config?.displayName ?? "…"}`, emphasis: true },
          { label: "Password sign-in", before: "on", after: "off" },
          {
            label: "Last test",
            after: config?.lastTest?.ok
              ? `passed as ${config.lastTest.email ?? "unknown"}`
              : "not passed",
          },
          { label: "Recovery", after: "APP_SSO_DISABLED=true on the server" },
        ]}
        onConfirm={() => void setEnabled(true)}
      />

      <ConfirmActionDialog
        open={confirm === "remove"}
        onOpenChange={(o) => busy === null && !o && setConfirm(null)}
        title="Remove single sign-on"
        summary="Deletes the identity provider configuration from this server. Nothing changes at the provider; password login stays available."
        tenant={null}
        severity="medium"
        confirmLabel="Remove configuration"
        busy={busy === "remove"}
        changes={[
          { label: "Provider", after: preset?.label ?? "" },
          { label: "Issuer", after: config?.issuer ?? "" },
          { label: "Login page", before: config?.enabled ? "single sign-on offered" : "password only", after: "password only" },
        ]}
        onConfirm={() => void remove()}
      />
    </>
  );
}

function Row({
  label,
  value,
  mono,
  action,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <dt className="text-xs text-muted-foreground w-32 shrink-0 pt-0.5">{label}</dt>
      <dd className="flex items-start justify-end gap-2 min-w-0 flex-1 text-right">
        {icon && <span className="shrink-0 pt-0.5">{icon}</span>}
        <span className={cn("break-all", mono && "font-mono text-xs pt-0.5")}>{value}</span>
        {action && <span className="shrink-0">{action}</span>}
      </dd>
    </div>
  );
}
