"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { notifyTenantsChanged } from "@/lib/tenant-client";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { PageHeader } from "@/components/page-header";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Cloud,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  PartyPopper,
  Rocket,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { SsoSetupWizard } from "@/components/sso-setup-wizard";
import { loadSsoConfig } from "@/lib/sso-client";
import { SSO_PROVIDER_PRESETS, type PublicSsoConfig } from "@/lib/sso-types";
import { cn } from "@/lib/utils";
import {
  TENANT_COLORS,
  TENANT_COLOR_CLASSES,
  type TenantColor,
} from "@/lib/tenants";
import {
  ScopePreflightPanel,
  type PreflightState,
} from "@/components/scope-preflight-panel";
import type { PreflightResult } from "@/lib/preflight";
import { REQUIRED_APIS, REQUIRED_SCOPES } from "@/lib/required-scopes";

type StepId =
  | "welcome"
  | "install"
  | "service-account"
  | "tenant"
  | "sso"
  | "verify";

interface StepDef {
  id: StepId;
  title: string;
  short: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  { id: "welcome", title: "Welcome", short: "Start", icon: Rocket },
  { id: "install", title: "Install the CLI", short: "Install", icon: Terminal },
  {
    id: "service-account",
    title: "Set up a service account",
    short: "Service account",
    icon: Cloud,
  },
  { id: "tenant", title: "Add your first tenant", short: "Tenant", icon: Building2 },
  { id: "sso", title: "Sign-in & SSO", short: "SSO", icon: KeyRound },
  { id: "verify", title: "Verify & finish", short: "Verify", icon: PartyPopper },
];

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  bin?: string;
  error?: string;
  /** True in the packaged desktop build, where the gws CLI is optional. */
  packaged?: boolean;
}

interface TenantForm {
  name: string;
  color: TenantColor;
  credentialsFile: string;
  adminEmail: string;
  geminiApiKey: string;
}

const defaultTenantForm = (): TenantForm => ({
  name: "Production",
  color: "blue",
  credentialsFile: "",
  adminEmail: "",
  geminiApiKey: "",
});

const SCOPE_LIST = REQUIRED_SCOPES.map((s) => s.scope);

export default function OnboardingPage() {
  const router = useRouter();
  const [activeStep, setActiveStep] = useState<StepId>("welcome");
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [tenantForm, setTenantForm] = useState<TenantForm>(defaultTenantForm());
  const [createdTenantId, setCreatedTenantId] = useState<string | null>(null);
  const [createdTenantName, setCreatedTenantName] = useState<string | null>(null);
  // A Gemini key went in with the tenant; the field itself is blanked once
  // saved, so this is what says so.
  const [geminiSaved, setGeminiSaved] = useState(false);
  const [savingTenant, setSavingTenant] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [tenantCount, setTenantCount] = useState<number>(0);
  // The server's active tenant, for an operator re-visiting the wizard with
  // tenants already configured: the Verify step checks that one.
  const [activeTenant, setActiveTenant] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [scopePreflight, setScopePreflight] = useState<PreflightState | null>(
    null
  );
  // Single sign-on state for the optional SSO step: the stored (public)
  // configuration, and whether its setup wizard is open.
  const [ssoConfig, setSsoConfig] = useState<PublicSsoConfig | null>(null);
  const [ssoWizardOpen, setSsoWizardOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [s, t] = await Promise.all([
        // The operator just installed or signed in and clicked Re-check:
        // bypass the server's short status cache.
        fetch("/api/gws/status?fresh=1")
          .then((r) => r.json())
          .catch(() => ({ installed: false, authenticated: false } as GwsStatus)),
        fetch("/api/tenants")
          .then((r) => r.json())
          .then((d) => {
            const tenants: Array<{ id?: unknown; name?: unknown }> = Array.isArray(
              d?.tenants
            )
              ? d.tenants
              : [];
            const active = tenants.find((x) => x.id === d?.activeTenantId);
            return {
              count: tenants.length,
              active:
                active && typeof active.id === "string"
                  ? {
                      id: active.id,
                      name: typeof active.name === "string" ? active.name : active.id,
                    }
                  : null,
            };
          })
          .catch(() => ({ count: 0, active: null })),
      ]);
      setStatus(s);
      setTenantCount(t.count);
      setActiveTenant(t.active);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    // Seed the SSO step for operators re-visiting the wizard.
    let cancelled = false;
    loadSsoConfig()
      .then((d) => {
        if (!cancelled) setSsoConfig(d.config);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  /**
   * Leaving the wizard through any "done" affordance records completion, so
   * the first-launch prompt stops offering itself. Best-effort: a failed
   * write just means the wizard is offered again next launch.
   */
  const finishOnboarding = useCallback(async () => {
    setFinishing(true);
    try {
      await fetch("/api/config/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
    } catch {
      // Best-effort — see above.
    } finally {
      router.push("/");
    }
  }, [router]);

  const stepIndex = STEPS.findIndex((s) => s.id === activeStep);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  function go(id: StepId) {
    setActiveStep(id);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function next() {
    if (!isLast) go(STEPS[stepIndex + 1].id);
  }

  function back() {
    if (!isFirst) go(STEPS[stepIndex - 1].id);
  }

  // A tenant exists, made here or before: the steps after "tenant" need one.
  const hasTenant = !!createdTenantId || tenantCount > 0;
  // The tenant the Verify step checks: the one just added, else the active one.
  const verifyTenant = createdTenantId
    ? { id: createdTenantId, name: createdTenantName ?? tenantForm.name }
    : activeTenant;
  const connectionOk =
    scopePreflight?.kind === "ok" &&
    scopePreflight.data.results.every((r) => r.authorized);

  // Step-level "can the user move on?" gate.
  const canContinue = useMemo(() => {
    // A tenant added in this session OR one that already exists both satisfy
    // the step — operators re-visiting onboarding with tenants configured
    // shouldn't be forced to create a duplicate just to proceed.
    if (activeStep === "tenant") {
      return !!createdTenantId || (tenantCount ?? 0) > 0;
    }
    return true;
  }, [activeStep, createdTenantId, tenantCount]);

  async function handleAddTenant() {
    setTenantError(null);
    if (!tenantForm.name.trim()) return setTenantError("Display name is required");
    if (!tenantForm.adminEmail.trim())
      return setTenantError("Admin email is required");
    if (!tenantForm.credentialsFile.trim())
      return setTenantError("Service account JSON path is required");

    setSavingTenant(true);
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tenantForm.name.trim(),
          color: tenantForm.color,
          credentialsFile: tenantForm.credentialsFile.trim(),
          adminEmail: tenantForm.adminEmail.trim(),
          geminiApiKey: tenantForm.geminiApiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTenantError(data?.error ?? "Failed to add tenant");
        return;
      }
      const newId: string | undefined = data?.tenant?.id;
      if (newId) {
        // If this is the first tenant the server already activated it on add.
        // For safety, explicitly activate so subsequent verify uses the right one.
        await fetch(`/api/tenants/${newId}/activate`, { method: "POST" }).catch(
          () => null
        );
        setCreatedTenantId(newId);
        setCreatedTenantName(
          typeof data?.tenant?.name === "string"
            ? data.tenant.name
            : tenantForm.name.trim()
        );
        // The key is saved with the tenant: don't keep it in page state.
        setGeminiSaved(!!tenantForm.geminiApiKey.trim());
        setTenantForm((f) => ({ ...f, geminiApiKey: "" }));
        // A check of another tenant says nothing about this one.
        setScopePreflight(null);
        // Tell the persistent sidebar switcher to refetch so it shows the new
        // tenant instead of the "Add a tenant" placeholder until a full reload.
        notifyTenantsChanged();
      }
      await refreshStatus();
    } catch {
      setTenantError("Network error — tenant not saved");
    } finally {
      setSavingTenant(false);
    }
  }

  // `fresh` skips the server's short per-tenant cache: a re-check means the
  // operator just fixed something in Admin Console and needs the real answer.
  async function handleScopeCheck(fresh = false) {
    const target = verifyTenant;
    if (!target) return;
    setScopePreflight({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/admin/preflight-scopes?tenantId=${encodeURIComponent(
          target.id
        )}${fresh ? "&fresh=1" : ""}`,
        { headers: { "x-tenant-id": target.id } }
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setScopePreflight({
          kind: "error",
          message: json.error ?? "Preflight failed",
        });
        return;
      }
      setScopePreflight({
        kind: "ok",
        data: json.data as PreflightResult,
      });
    } catch (e) {
      setScopePreflight({
        kind: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  }

  /**
   * "Can Open Admin talk to the tenant?" is answered by asking Google for a
   * token for every scope the tenant's service account is meant to have —
   * the same check as the Tenants page. Whether the gws CLI answers is a
   * separate, optional fact, refreshed alongside.
   */
  async function handleConnectionCheck() {
    if (!verifyTenant) return;
    setVerifying(true);
    try {
      await Promise.all([
        handleScopeCheck(true),
        status?.packaged
          ? Promise.resolve()
          : fetch("/api/gws/status?fresh=1")
              .then((r) => r.json())
              .then((d: GwsStatus) => setStatus(d))
              .catch(() => {}),
      ]);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Get started"
        description="A guided walkthrough that gets you from zero to running your first Workspace command."
        badge="Onboarding"
      />

      <div className="max-w-4xl space-y-6">
        <Stepper
          steps={STEPS}
          activeStep={activeStep}
          onSelect={(id) => go(id)}
          completed={{
            welcome: true,
            install: !!status?.installed,
            "service-account": hasTenant,
            tenant: hasTenant,
            sso: !!ssoConfig?.enabled,
            verify: connectionOk,
          }}
          // Like Continue, the stepper doesn't go past "tenant" without one:
          // there is nothing to sign in to or verify yet.
          locked={
            hasTenant
              ? {}
              : {
                  sso: "Add a tenant first",
                  verify: "Add a tenant first",
                }
          }
        />

        {activeStep === "welcome" && (
          <WelcomeStep
            tenantCount={tenantCount}
            onSkip={finishOnboarding}
            packaged={!!status?.packaged}
          />
        )}

        {activeStep === "install" && (
          <InstallStep
            status={status}
            loading={statusLoading}
            onRefresh={refreshStatus}
          />
        )}

        {activeStep === "service-account" && <ServiceAccountStep />}

        {activeStep === "tenant" && (
          <TenantStep
            form={tenantForm}
            onChange={setTenantForm}
            onSave={handleAddTenant}
            saving={savingTenant}
            error={tenantError}
            createdTenantId={createdTenantId}
            geminiSaved={geminiSaved}
          />
        )}

        {activeStep === "sso" && (
          <SsoStep config={ssoConfig} onOpen={() => setSsoWizardOpen(true)} />
        )}

        {activeStep === "verify" && (
          <VerifyStep
            status={status}
            loading={statusLoading}
            tenant={verifyTenant}
            checking={verifying}
            onCheck={handleConnectionCheck}
            onAddTenant={() => go("tenant")}
            onFinish={finishOnboarding}
            finishing={finishing}
            scopePreflight={scopePreflight}
            onScopeRetry={() => void handleScopeCheck(true)}
          />
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={back}
            disabled={isFirst}
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back
          </Button>
          <p className="text-xs text-muted-foreground">
            Step {stepIndex + 1} of {STEPS.length}
          </p>
          {isLast ? (
            <Button size="sm" onClick={finishOnboarding} disabled={finishing}>
              {finishing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : null}
              Go to dashboard
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          ) : (
            <Button size="sm" onClick={next} disabled={!canContinue}>
              Continue
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          )}
        </div>
      </div>

      <SsoSetupWizard
        open={ssoWizardOpen}
        onOpenChange={setSsoWizardOpen}
        existing={ssoConfig}
        onSaved={setSsoConfig}
      />
    </>
  );
}

function Stepper({
  steps,
  activeStep,
  onSelect,
  completed,
  locked,
}: {
  steps: StepDef[];
  activeStep: StepId;
  onSelect: (id: StepId) => void;
  completed: Record<StepId, boolean>;
  /** Steps that can't be opened yet, with the reason. */
  locked: Partial<Record<StepId, string>>;
}) {
  const activeIdx = steps.findIndex((s) => s.id === activeStep);
  return (
    <nav aria-label="Onboarding progress" className="rounded-xl border bg-card p-3 sm:p-4">
      <ol className="flex items-center gap-1 sm:gap-2">
        {steps.map((step, idx) => {
          const isActive = step.id === activeStep;
          const isDone = completed[step.id] && !isActive;
          const Icon = step.icon;
          return (
            <li
              key={step.id}
              className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0"
            >
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                disabled={!!locked[step.id] && !isActive}
                title={locked[step.id]}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors min-w-0 flex-1 disabled:opacity-50 disabled:pointer-events-none",
                  isActive
                    ? "bg-primary/10 text-foreground"
                    : "hover:bg-muted text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground border-primary"
                      : isDone
                      ? "border-success bg-success text-white"
                      : "bg-background border-border"
                  )}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="hidden sm:flex flex-col items-start min-w-0">
                  <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap opacity-70">
                    Step {idx + 1}
                  </span>
                  <span className="text-xs font-medium truncate max-w-[110px]">
                    {step.short}
                  </span>
                </span>
              </button>
              {idx < steps.length - 1 && (
                <span
                  className={cn(
                    "h-px flex-1 transition-colors",
                    idx < activeIdx || completed[step.id]
                      ? "bg-success/60"
                      : "bg-border"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function WelcomeStep({
  tenantCount,
  onSkip,
  packaged,
}: {
  tenantCount: number;
  onSkip: () => void;
  packaged: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>Welcome to Open Admin</CardTitle>
            <CardDescription>
              We&apos;ll get you connected to Google Workspace in about 10 minutes.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          {packaged ? (
            <>
              To run admin operations, Open Admin needs two things: a Google
              Cloud service account with domain-wide delegation, and a
              <em> tenant</em> entry that points at your service account JSON.
              This build bundles everything else.
            </>
          ) : (
            <>
              To run admin operations, Open Admin needs three things: the{" "}
              <code className="font-mono bg-muted px-1 rounded">gws</code> CLI,
              a Google Cloud service account with domain-wide delegation, and a
              <em> tenant</em> entry that points at your service account JSON.
            </>
          )}
        </p>

        <div className="grid sm:grid-cols-3 gap-3">
          <PrereqCard
            icon={Terminal}
            title="gws CLI"
            description={
              packaged
                ? "Optional in this build — install it only for terminal use."
                : "Google's official Workspace CLI, installed on this machine."
            }
            tone="blue"
          />
          <PrereqCard
            icon={Cloud}
            title="Service account"
            description="A GCP service account with domain-wide delegation enabled."
            tone="violet"
          />
          <PrereqCard
            icon={Building2}
            title="Tenant config"
            description="A name, an admin email, and the path to your JSON key."
            tone="emerald"
          />
        </div>

        {tenantCount > 0 && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <AlertDescription>
              You already have {tenantCount} tenant{tenantCount === 1 ? "" : "s"} configured.
              Feel free to skip ahead to{" "}
              <Link href="/" className="underline font-medium">
                the dashboard
              </Link>
              , or use this walkthrough to add another.
            </AlertDescription>
          </Alert>
        )}

        <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-1">What you&apos;ll need open</p>
          <ul className="list-disc list-inside space-y-1">
            <li>A terminal (Terminal on macOS/Linux, PowerShell on Windows)</li>
            <li>
              Access to{" "}
              <a
                href="https://console.cloud.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                Google Cloud Console <ExternalLink className="h-3 w-3" />
              </a>{" "}
              and the{" "}
              <a
                href="https://admin.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                Workspace Admin Console <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>A super-admin Workspace account (for impersonation)</li>
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          Already set up, or prefer doing it by hand?{" "}
          <button
            type="button"
            onClick={onSkip}
            className="underline font-medium hover:text-foreground"
          >
            Skip the wizard
          </button>{" "}
          — it stays available under <em>Get Started</em> in the sidebar.
        </p>
      </CardContent>
    </Card>
  );
}

function SsoStep({
  config,
  onOpen,
}: {
  config: PublicSsoConfig | null;
  onOpen: () => void;
}) {
  const preset = config ? SSO_PROVIDER_PRESETS[config.provider] : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Sign-in &amp; SSO
        </CardTitle>
        <CardDescription>
          Optional: let admins sign in through your identity provider (OpenID
          Connect) instead of sharing the Open Admin password. Skip this step
          and set it up later under <strong>Single Sign-On</strong> in the
          sidebar if you prefer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "h-9 w-9 rounded-md flex items-center justify-center shrink-0",
                config?.enabled
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {config?.enabled ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium">
                {config
                  ? `${preset?.label ?? config.provider} — ${
                      config.enabled ? "enabled" : "saved, not enabled yet"
                    }`
                  : "Not configured"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {config
                  ? `Login button: "Continue with ${config.displayName}"${
                      config.passwordLoginEnabled
                        ? ", password form kept as a fallback"
                        : ", password sign-in off"
                    }.`
                  : "The login page only offers the password form."}
              </p>
            </div>
          </div>
          <Button size="sm" onClick={onOpen} data-testid="onboarding-sso-open">
            <KeyRound className="h-4 w-4 mr-1.5" />
            {config ? "Edit single sign-on" : "Set up single sign-on"}
          </Button>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground space-y-1.5">
          <p className="font-medium text-foreground">What the wizard walks through</p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>
              Pick the provider — Google Workspace, Microsoft Entra ID, Okta, or
              any other OpenID Connect provider — and register Open Admin with
              it using the redirect URI it shows you.
            </li>
            <li>
              Paste the issuer URL, client ID and client secret; the issuer is
              checked live before anything is saved.
            </li>
            <li>
              Decide who may sign in with domain and email allowlists — every
              account that gets in has full admin access.
            </li>
            <li>
              Run a real test sign-in in a pop-up, then enable. Turning the
              password form off requires a passing test first.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function PrereqCard({
  icon: Icon,
  title,
  description,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tone: "blue" | "violet" | "emerald";
}) {
  const toneClass =
    tone === "blue"
      ? "bg-info/10 text-info"
      : tone === "violet"
      ? "bg-primary/10 text-primary"
      : "bg-success/8 text-success";
  return (
    <div className="rounded-lg border p-4">
      <div className={cn("h-9 w-9 rounded-md flex items-center justify-center mb-3", toneClass)}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{description}</p>
    </div>
  );
}

function InstallStep({
  status,
  loading,
  onRefresh,
}: {
  status: GwsStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const installed = !!status?.installed;
  const packaged = !!status?.packaged;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          {packaged ? "Install the gws CLI (optional)" : "Install the gws CLI"}
        </CardTitle>
        <CardDescription>
          {packaged
            ? "Nothing to do here — this build runs every Workspace operation through Google's APIs. Install the CLI only if you also want it in your terminal."
            : "Pick your platform and run the install command. Open Admin shells out to this CLI for everything that isn't a direct Google API call."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {packaged && (
          <div className="rounded-lg border border-success/25 bg-success/8 p-3 text-xs text-success-fg">
            <p className="font-semibold">You can skip this step.</p>
            <p className="mt-0.5">
              The desktop build bundles its own runtime and authenticates with
              the service account you configure in the next steps. Click{" "}
              <strong>Continue</strong>.
            </p>
          </div>
        )}

        <Tabs defaultValue="mac">
          <TabsList>
            <TabsTrigger value="mac">macOS</TabsTrigger>
            <TabsTrigger value="linux">Linux</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
          </TabsList>

          <TabsContent value="mac" className="mt-4 space-y-3">
            <CommandSnippet
              label="Install via npm"
              command="npm install -g @googleworkspace/cli"
            />
            <p className="text-xs text-muted-foreground">
              Or, if you prefer Homebrew:
            </p>
            <CommandSnippet
              label="Install via Homebrew"
              command="brew install googleworkspace-cli"
            />
          </TabsContent>

          <TabsContent value="linux" className="mt-4 space-y-3">
            <CommandSnippet
              label="Install via npm"
              command="npm install -g @googleworkspace/cli"
            />
            <p className="text-xs text-muted-foreground">
              You&apos;ll need Node.js 18+ on your PATH first.
            </p>
          </TabsContent>

          <TabsContent value="windows" className="mt-4 space-y-3">
            <CommandSnippet
              label="Install via npm (PowerShell)"
              command="npm install -g @googleworkspace/cli"
            />
            <p className="text-xs text-muted-foreground">
              If <code className="font-mono">gws --version</code> isn&apos;t recognised after install, point Open Admin at the shim explicitly:
            </p>
            <CommandSnippet
              label="PowerShell — set GWS_BIN"
              command={'$env:GWS_BIN = "C:\\Users\\<you>\\AppData\\Roaming\\npm\\gws.cmd"'}
            />
          </TabsContent>
        </Tabs>

        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "h-9 w-9 rounded-md flex items-center justify-center shrink-0",
                installed
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : installed ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">CLI status</p>
              {loading ? (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Checking your machine...
                </p>
              ) : installed ? (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Detected{" "}
                  <span className="font-mono">gws {status?.version ?? ""}</span>{" "}
                  on this machine. You&apos;re ready for the next step.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Not detected yet. Run the command above, then click{" "}
                  <strong>Re-check</strong>.
                  {status?.error && (
                    <>
                      <br />
                      <span className="text-warning">
                        Diagnostic: <code className="font-mono">{status.error}</code>
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Re-check
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Want the official docs?{" "}
          <a
            href="https://github.com/googleworkspace/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-1"
          >
            googleworkspace/cli on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

function ServiceAccountStep() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          Set up a service account
        </CardTitle>
        <CardDescription>
          A GCP service account with domain-wide delegation lets Open Admin act
          on behalf of any user in your tenant — no per-user OAuth dance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <NumberedStep
          n={1}
          title="Create a service account"
          body={
            <>
              In{" "}
              <a
                href="https://console.cloud.google.com/iam-admin/serviceaccounts"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                Google Cloud Console → IAM &amp; Admin → Service Accounts
                <ExternalLink className="h-3 w-3" />
              </a>
              , create a new service account in the GCP project tied to your Workspace.
            </>
          }
        />

        <NumberedStep
          n={2}
          title="Generate a JSON key"
          body={
            <>
              On the service account&apos;s <strong>Keys</strong> tab, add a new
              JSON key. The browser will download a file like{" "}
              <code className="font-mono bg-muted px-1 rounded">
                project-id-abc123.json
              </code>
              . Save it somewhere stable (you&apos;ll paste the full path in the next step).
            </>
          }
        />

        <NumberedStep
          n={3}
          title="Enable the required APIs"
          body={
            <>
              In{" "}
              <a
                href="https://console.cloud.google.com/apis/library"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                APIs &amp; Services → Library
                <ExternalLink className="h-3 w-3" />
              </a>
              , enable each of these for the project:
              <ul className="mt-2 grid sm:grid-cols-2 gap-1.5">
                {REQUIRED_APIS.map((api) => (
                  <li
                    key={api.name}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Check className="h-3 w-3 text-success shrink-0" />
                    {api.name}
                  </li>
                ))}
              </ul>
            </>
          }
        />

        <NumberedStep
          n={4}
          title="Authorise domain-wide delegation"
          body={
            <>
              In{" "}
              <a
                href="https://admin.google.com/ac/owl/domainwidedelegation"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                Workspace Admin Console → Security → API Controls → Domain-wide Delegation
                <ExternalLink className="h-3 w-3" />
              </a>
              , add the service account&apos;s <strong>client ID</strong> (from the JSON key) and paste in this comma-separated scope list:
              <div className="relative mt-3">
                <pre className="text-xs font-mono bg-muted rounded-lg p-3 pr-12 overflow-x-auto whitespace-pre">
                  {SCOPE_LIST.join(",\n")}
                </pre>
                <CopyButton
                  value={SCOPE_LIST.join(",")}
                  className="absolute top-2 right-2"
                  label="Copy scopes"
                />
              </div>
            </>
          }
        />

        <Alert variant="warning">
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertDescription>
            Domain-wide delegation grants the service account broad access. Treat
            the JSON key like a password — store it somewhere only your admin
            machines can read.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function NumberedStep({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
        {n}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-sm font-semibold">{title}</p>
        <div className="text-sm text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}

function TenantStep({
  form,
  onChange,
  onSave,
  saving,
  error,
  createdTenantId,
  geminiSaved,
}: {
  form: TenantForm;
  onChange: (f: TenantForm) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  createdTenantId: string | null;
  geminiSaved: boolean;
}) {
  const isCreated = !!createdTenantId;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Add your first tenant
        </CardTitle>
        <CardDescription>
          A tenant ties together a service account JSON, an admin email, and a
          friendly name. Switch between tenants from the sidebar — nothing carries over between them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4 text-danger" />
            <AlertDescription>
              {error}
            </AlertDescription>
          </Alert>
        )}

        {isCreated && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <AlertDescription>
              Tenant <strong>{form.name}</strong> saved and activated. Continue to verify the connection.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="ob-name" className="text-xs">
              Display name <span className="text-danger">*</span>
            </Label>
            <Input
              id="ob-name"
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              placeholder="Production"
              disabled={isCreated}
            />
            <p className="text-xs text-muted-foreground">
              A short label like <em>Production</em> or <em>Sandbox</em>.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Color</Label>
            <div className="flex gap-2 pt-1">
              {TENANT_COLORS.map((color) => {
                const tc = TENANT_COLOR_CLASSES[color];
                const selected = form.color === color;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => onChange({ ...form, color })}
                    title={color}
                    disabled={isCreated}
                    aria-pressed={selected}
                    className={cn(
                      "h-6 w-6 rounded-full transition-transform",
                      tc.dot,
                      selected
                        ? "ring-2 ring-offset-1 ring-foreground scale-110"
                        : "hover:scale-110",
                      isCreated && "opacity-60"
                    )}
                  />
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Picked up by the sidebar pill so you always see which tenant you&apos;re acting on.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ob-admin" className="text-xs">
            Super-admin email <span className="text-danger">*</span>
          </Label>
          <Input
            id="ob-admin"
            type="email"
            value={form.adminEmail}
            onChange={(e) => onChange({ ...form, adminEmail: e.target.value })}
            placeholder="admin@yourdomain.com"
            disabled={isCreated}
          />
          <p className="text-xs text-muted-foreground">
            The Workspace user the service account will impersonate. Must be a super admin.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ob-creds" className="text-xs">
            Path to service account JSON <span className="text-danger">*</span>
          </Label>
          <Input
            id="ob-creds"
            value={form.credentialsFile}
            onChange={(e) =>
              onChange({ ...form, credentialsFile: e.target.value })
            }
            placeholder="/Users/me/secrets/sa-key.json"
            className="font-mono"
            disabled={isCreated}
          />
          <p className="text-xs text-muted-foreground">
            Absolute path on this machine. Must end in{" "}
            <code className="font-mono bg-muted px-1 rounded">.json</code>. The file
            stays on disk — only its path is stored in{" "}
            <code className="font-mono bg-muted px-1 rounded">tenants.json</code>.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ob-gemini" className="text-xs">
            Gemini API key{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="ob-gemini"
            // A secret: masked on screen, kept out of the browser's form
            // history, and blanked from the page once saved.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.geminiApiKey}
            onChange={(e) =>
              onChange({ ...form, geminiApiKey: e.target.value })
            }
            placeholder={
              isCreated
                ? geminiSaved
                  ? "Saved with the tenant"
                  : "None saved"
                : "AIza... — only needed for AI Command and User Audit"
            }
            disabled={isCreated}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to fall back to the{" "}
            <code className="font-mono bg-muted px-1 rounded">
              GOOGLE_GENERATIVE_AI_API_KEY
            </code>{" "}
            env var. Get one free at{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-1"
            >
              Google AI Studio <ExternalLink className="h-3 w-3" />
            </a>
            .
          </p>
        </div>

        <div className="flex justify-end pt-1">
          {isCreated ? (
            <Badge
              variant="outline"
              className="border-success/25 bg-success/10 text-success-fg"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Tenant saved
            </Badge>
          ) : (
            <Button onClick={onSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1.5" />
              )}
              {saving ? "Saving..." : "Save tenant"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function VerifyStep({
  status,
  loading,
  tenant,
  checking,
  onCheck,
  onAddTenant,
  onFinish,
  finishing,
  scopePreflight,
  onScopeRetry,
}: {
  status: GwsStatus | null;
  loading: boolean;
  /** The tenant to check: the one added in this wizard, else the active one. */
  tenant: { id: string; name: string } | null;
  checking: boolean;
  onCheck: () => void;
  onAddTenant: () => void;
  onFinish: () => void;
  finishing: boolean;
  scopePreflight: PreflightState | null;
  onScopeRetry: () => void;
}) {
  const packaged = !!status?.packaged;
  const missing =
    scopePreflight?.kind === "ok"
      ? scopePreflight.data.results.filter((r) => !r.authorized).length
      : 0;
  const connection =
    scopePreflight?.kind === "ok"
      ? missing === 0
        ? { ok: true, detail: "All scopes authorized" }
        : { ok: false, detail: `${missing} scope${missing === 1 ? "" : "s"} missing` }
      : scopePreflight?.kind === "error"
        ? { ok: false, detail: "Check failed" }
        : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5" />
          Verify and finish
        </CardTitle>
        <CardDescription>
          {tenant ? (
            <>
              One last sanity check that Open Admin can talk to{" "}
              <strong>{tenant.name}</strong> with the service account you
              configured.
            </>
          ) : (
            <>There is no tenant to check yet.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!tenant && !loading && (
          <Alert variant="warning">
            <AlertCircle className="h-4 w-4 text-warning" />
            <AlertDescription>
              Add a tenant first — Open Admin has nothing to connect to yet.{" "}
              <button
                type="button"
                className="underline font-medium"
                onClick={onAddTenant}
              >
                Go to the tenant step
              </button>
            </AlertDescription>
          </Alert>
        )}

        <div className="rounded-lg border p-4 space-y-3">
          <StatusRow
            label={packaged ? "gws CLI (optional)" : "gws CLI installed"}
            ok={!!status?.installed}
            optional={packaged}
            loading={loading}
            detail={
              status?.installed
                ? `v${status?.version}`
                : packaged
                ? "Not needed"
                : "Not detected"
            }
          />
          <StatusRow
            label="Tenant configured"
            ok={!!tenant}
            loading={loading}
            detail={tenant ? tenant.name : "None yet"}
          />
          <StatusRow
            label="Connection to the tenant"
            ok={!!connection?.ok}
            optional={!connection}
            loading={scopePreflight?.kind === "loading"}
            detail={connection ? connection.detail : "Not checked yet"}
          />
        </div>

        {tenant && (
          <div className="rounded-lg border p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">Run the connection check</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Asks Google for a token for every OAuth scope Open Admin uses,
                acting as {tenant.name}&apos;s admin through its service
                account. It passes only if Domain-Wide Delegation authorizes
                them all, so a missing scope shows up here instead of breaking
                a later operation.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={onCheck}
                disabled={checking || scopePreflight?.kind === "loading"}
              >
                {checking ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : null}
                {checking ? "Running check..." : "Run connection check"}
              </Button>
              {connection?.ok && (
                <span className="text-sm text-success inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4" />
                  Open Admin can reach {tenant.name}
                </span>
              )}
              {connection && !connection.ok && (
                <span className="text-sm text-danger inline-flex items-center gap-1.5">
                  <XCircle className="h-4 w-4" />
                  {connection.detail}
                </span>
              )}
            </div>
            {scopePreflight && (
              <ScopePreflightPanel state={scopePreflight} onRetry={onScopeRetry} />
            )}
          </div>
        )}

        <div className="rounded-lg border p-4 space-y-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <Download className="h-4 w-4" />
            Save a configuration backup
          </p>
          <p className="text-xs text-muted-foreground">
            To keep a copy of this setup, or move it to another server, export
            it from <strong>App Settings → Configuration backup</strong>. That
            export holds tenants, single sign-on and the service-account key
            files themselves, so the whole setup comes back from one file —
            and because it carries live secrets, it asks you to type a phrase
            first. Store it like a password.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Link
              href="/settings"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Open Configuration backup
            </Link>
            <a
              href="/api/config/export"
              download
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              Download without keys or secrets
            </a>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
          <p className="font-medium">You&apos;re all set</p>
          <p className="text-muted-foreground">
            Head to the dashboard to delegate mailboxes, transfer calendars, run
            audits, or just type what you need into the AI Command box.
          </p>
          <Button size="sm" onClick={onFinish} disabled={finishing} className="mt-1">
            {finishing ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Open the dashboard
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusRow({
  label,
  ok,
  loading,
  detail,
  optional = false,
}: {
  label: string;
  ok: boolean;
  loading: boolean;
  detail: string;
  /** Render a not-ok row as a neutral fact rather than a failure. */
  optional?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : ok ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <XCircle
            className={`h-4 w-4 ${
              optional ? "text-muted-foreground" : "text-danger"
            }`}
          />
        )}
        <span className="text-sm">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground font-mono">{detail}</span>
    </div>
  );
}

function CommandSnippet({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
        {label}
      </p>
      <div className="relative">
        <pre className="text-xs sm:text-sm font-mono bg-muted rounded-lg p-3 pr-20 overflow-x-auto">
          {command}
        </pre>
        <CopyButton value={command} className="absolute top-1.5 right-1.5" />
      </div>
    </div>
  );
}
