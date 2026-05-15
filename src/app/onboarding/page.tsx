"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
  ExternalLink,
  Loader2,
  PartyPopper,
  Rocket,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
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

type StepId =
  | "welcome"
  | "install"
  | "service-account"
  | "tenant"
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
  { id: "verify", title: "Verify & finish", short: "Verify", icon: PartyPopper },
];

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  bin?: string;
  error?: string;
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

const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.user.security",
  "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  "https://www.googleapis.com/auth/admin.datatransfer",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive",
];

const REQUIRED_APIS = [
  "Gmail API",
  "Google Calendar API",
  "Admin SDK API",
  "Admin Data Transfer API",
  "Google Drive API",
];

export default function OnboardingPage() {
  const router = useRouter();
  const [activeStep, setActiveStep] = useState<StepId>("welcome");
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [tenantForm, setTenantForm] = useState<TenantForm>(defaultTenantForm());
  const [createdTenantId, setCreatedTenantId] = useState<string | null>(null);
  const [savingTenant, setSavingTenant] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    | { ok: true; version: string }
    | { ok: false; message: string }
    | null
  >(null);
  const [tenantCount, setTenantCount] = useState<number>(0);
  const [scopePreflight, setScopePreflight] = useState<PreflightState | null>(
    null
  );

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [s, t] = await Promise.all([
        fetch("/api/gws/status")
          .then((r) => r.json())
          .catch(() => ({ installed: false, authenticated: false } as GwsStatus)),
        fetch("/api/tenants")
          .then((r) => r.json())
          .then((d) => (Array.isArray(d?.tenants) ? d.tenants.length : 0))
          .catch(() => 0),
      ]);
      setStatus(s);
      setTenantCount(t);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

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

  // Step-level "can the user move on?" gate.
  const canContinue = useMemo(() => {
    if (activeStep === "tenant") return !!createdTenantId;
    return true;
  }, [activeStep, createdTenantId]);

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
      }
      await refreshStatus();
    } finally {
      setSavingTenant(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await fetch("/api/gws/status");
      const data = (await r.json()) as GwsStatus;
      setStatus(data);
      if (data.installed) {
        setVerifyResult({ ok: true, version: data.version ?? "unknown" });
      } else {
        setVerifyResult({
          ok: false,
          message:
            data.error ??
            "gws CLI didn't respond. Make sure it's installed and on your PATH.",
        });
      }
    } catch (e) {
      setVerifyResult({
        ok: false,
        message: e instanceof Error ? e.message : "Connection check failed",
      });
    } finally {
      setVerifying(false);
    }
  }

  async function handleScopeCheck() {
    if (!createdTenantId) return;
    setScopePreflight({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/admin/preflight-scopes?tenantId=${encodeURIComponent(createdTenantId)}`,
        { headers: { "x-tenant-id": createdTenantId } }
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
            "service-account": !!createdTenantId || tenantCount > 0,
            tenant: !!createdTenantId || tenantCount > 0,
            verify: !!verifyResult && verifyResult.ok,
          }}
        />

        {activeStep === "welcome" && (
          <WelcomeStep tenantCount={tenantCount} />
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
          />
        )}

        {activeStep === "verify" && (
          <VerifyStep
            status={status}
            loading={statusLoading}
            verifying={verifying}
            result={verifyResult}
            onVerify={handleVerify}
            onFinish={() => router.push("/")}
            tenantName={tenantForm.name || "your tenant"}
            tenantId={createdTenantId}
            scopePreflight={scopePreflight}
            onScopeCheck={handleScopeCheck}
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
            <Button size="sm" onClick={() => router.push("/")}>
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
    </>
  );
}

function Stepper({
  steps,
  activeStep,
  onSelect,
  completed,
}: {
  steps: StepDef[];
  activeStep: StepId;
  onSelect: (id: StepId) => void;
  completed: Record<StepId, boolean>;
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
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors min-w-0 flex-1",
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
                      ? "bg-emerald-500 text-white border-emerald-500"
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
                  <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
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
                      ? "bg-emerald-500/60"
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

function WelcomeStep({ tenantCount }: { tenantCount: number }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">Welcome to the Toolbox</CardTitle>
            <CardDescription>
              We&apos;ll get you connected to Google Workspace in about 10 minutes.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          To run admin operations, the toolbox needs three things: the{" "}
          <code className="font-mono bg-muted px-1 rounded">gws</code> CLI,
          a Google Cloud service account with domain-wide delegation, and a
          <em> tenant</em> entry that points at your service account JSON.
        </p>

        <div className="grid sm:grid-cols-3 gap-3">
          <PrereqCard
            icon={Terminal}
            title="gws CLI"
            description="Google's official Workspace CLI, installed on this machine."
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
          <Alert className="border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <AlertDescription className="text-sm text-emerald-800 dark:text-emerald-300">
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
      ? "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400"
      : tone === "violet"
      ? "bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400"
      : "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400";
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          Install the gws CLI
        </CardTitle>
        <CardDescription>
          Pick your platform and run the install command. The toolbox shells out to
          this CLI for everything that isn&apos;t a direct Google API call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
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
              If <code className="font-mono">gws --version</code> isn&apos;t recognised after install, point the toolbox at the shim explicitly:
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
                  ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600"
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
                      <span className="text-amber-600 dark:text-amber-400">
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
        <CardTitle className="text-lg flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          Set up a service account
        </CardTitle>
        <CardDescription>
          A GCP service account with domain-wide delegation lets the toolbox act
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
                    key={api}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                    {api}
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
                  {REQUIRED_SCOPES.join(",\n")}
                </pre>
                <CopyButton
                  value={REQUIRED_SCOPES.join(",")}
                  className="absolute top-2 right-2"
                  label="Copy scopes"
                />
              </div>
            </>
          }
        />

        <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-sm text-amber-800 dark:text-amber-300">
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
}: {
  form: TenantForm;
  onChange: (f: TenantForm) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  createdTenantId: string | null;
}) {
  const isCreated = !!createdTenantId;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
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
          <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-sm text-red-800 dark:text-red-300">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {isCreated && (
          <Alert className="border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <AlertDescription className="text-sm text-emerald-800 dark:text-emerald-300">
              Tenant <strong>{form.name}</strong> saved and activated. Continue to verify the connection.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="ob-name" className="text-xs">
              Display name <span className="text-red-500">*</span>
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
            Super-admin email <span className="text-red-500">*</span>
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
            Path to service account JSON <span className="text-red-500">*</span>
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
            value={form.geminiApiKey}
            onChange={(e) =>
              onChange({ ...form, geminiApiKey: e.target.value })
            }
            placeholder="AIza... — only needed for AI Command and User Audit"
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
              className="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50"
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
  verifying,
  result,
  onVerify,
  onFinish,
  tenantName,
  tenantId,
  scopePreflight,
  onScopeCheck,
}: {
  status: GwsStatus | null;
  loading: boolean;
  verifying: boolean;
  result:
    | { ok: true; version: string }
    | { ok: false; message: string }
    | null;
  onVerify: () => void;
  onFinish: () => void;
  tenantName: string;
  tenantId: string | null;
  scopePreflight: PreflightState | null;
  onScopeCheck: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <PartyPopper className="h-5 w-5" />
          Verify and finish
        </CardTitle>
        <CardDescription>
          One last sanity check that the toolbox can talk to{" "}
          <strong>{tenantName}</strong> via the gws CLI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border p-4 space-y-3">
          <StatusRow
            label="gws CLI installed"
            ok={!!status?.installed}
            loading={loading}
            detail={status?.installed ? `v${status?.version}` : "Not detected"}
          />
          <StatusRow
            label="Tenant configured"
            ok
            loading={false}
            detail={tenantName}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={onVerify} disabled={verifying} variant="outline">
            {verifying ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            {verifying ? "Running check..." : "Run connection check"}
          </Button>
          {result?.ok && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              CLI responded — gws v{result.version}
            </span>
          )}
          {result && !result.ok && (
            <span className="text-sm text-red-600 dark:text-red-400 inline-flex items-center gap-1.5">
              <XCircle className="h-4 w-4" />
              {result.message}
            </span>
          )}
        </div>

        {tenantId && (
          <div className="rounded-lg border p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">
                Verify Domain-Wide Delegation scopes
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Checks every OAuth scope this toolbox impersonates against
                Google&apos;s auth server, so missing scopes surface here
                instead of silently breaking a future operation.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={onScopeCheck}
                disabled={scopePreflight?.kind === "loading"}
              >
                {scopePreflight?.kind === "loading" ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : null}
                {scopePreflight?.kind === "loading"
                  ? "Checking scopes..."
                  : "Check DWD scopes"}
              </Button>
            </div>
            {scopePreflight && (
              <ScopePreflightPanel
                state={scopePreflight}
                onRetry={onScopeCheck}
              />
            )}
          </div>
        )}

        <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
          <p className="font-medium">You&apos;re all set</p>
          <p className="text-muted-foreground">
            Head to the dashboard to delegate mailboxes, transfer calendars, run
            audits, or just type what you need into the AI Command box.
          </p>
          <Button size="sm" onClick={onFinish} className="mt-1">
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
}: {
  label: string;
  ok: boolean;
  loading: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500" />
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
