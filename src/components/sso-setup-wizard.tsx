"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { CopyButton } from "@/components/copy-button";
import { SsoTestResultPanel } from "@/components/sso-test-result";
import { cn } from "@/lib/utils";
import {
  SSO_CALLBACK_PATH,
  SSO_PROVIDERS,
  SSO_PROVIDER_PRESETS,
  isLoopbackHost,
  type IssuerCheckResult,
  type PublicSsoConfig,
  type SsoProvider,
  type SsoTestResult,
} from "@/lib/sso-types";
import { discoverIssuer, runSsoTest, saveSsoConfig } from "@/lib/sso-client";
import {
  AlertTriangle,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  PartyPopper,
  ShieldCheck,
  XCircle,
} from "lucide-react";

/**
 * Pop-up wizard that walks an admin through connecting an OpenID Connect
 * identity provider: pick a provider, register the app with it, paste the
 * credentials (with a live discovery check), decide who may sign in, then
 * save, run a real test sign-in, and enable.
 *
 * Nothing goes live until the final step: saving stores the config disabled,
 * and enabling is a separate, deliberate click that — when the password
 * fallback is being turned off — is only offered after a passing test.
 */

type StepId = "provider" | "register" | "credentials" | "access" | "finish";

interface StepDef {
  id: StepId;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  { id: "provider", title: "Provider", icon: Building2 },
  { id: "register", title: "Register app", icon: AppWindow },
  { id: "credentials", title: "Credentials", icon: KeyRound },
  { id: "access", title: "Who can sign in", icon: ShieldCheck },
  { id: "finish", title: "Test & enable", icon: PartyPopper },
];

interface WizardForm {
  provider: SsoProvider;
  displayName: string;
  baseUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string;
  allowedEmails: string;
  allowAnyIdpUser: boolean;
  passwordLoginEnabled: boolean;
}

type DiscoveryState =
  | { kind: "idle" }
  | { kind: "loading"; issuer: string }
  | { kind: "ok"; issuer: string; result: IssuerCheckResult }
  | { kind: "error"; issuer: string; message: string };

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SsoTestResult };

function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

function formFromExisting(
  existing: PublicSsoConfig | null,
  origin: string
): WizardForm {
  if (!existing) {
    return {
      provider: "google",
      displayName: SSO_PROVIDER_PRESETS.google.label,
      baseUrl: origin,
      issuer: SSO_PROVIDER_PRESETS.google.fixedIssuer ?? "",
      clientId: "",
      clientSecret: "",
      allowedDomains: "",
      allowedEmails: "",
      allowAnyIdpUser: false,
      passwordLoginEnabled: true,
    };
  }
  const baseUrl = existing.redirectUri.endsWith(SSO_CALLBACK_PATH)
    ? existing.redirectUri.slice(0, -SSO_CALLBACK_PATH.length)
    : origin;
  return {
    provider: existing.provider,
    displayName: existing.displayName,
    baseUrl,
    issuer: existing.issuer,
    clientId: existing.clientId,
    // Never sent to the browser; blank means "keep the stored secret".
    clientSecret: "",
    allowedDomains: existing.allowedDomains.join(", "),
    allowedEmails: existing.allowedEmails.join(", "),
    allowAnyIdpUser: existing.allowAnyIdpUser,
    passwordLoginEnabled: existing.passwordLoginEnabled,
  };
}

function deriveRedirectUri(baseUrl: string): { uri: string | null; insecure: boolean } {
  const raw = baseUrl.trim();
  if (!raw) return { uri: null, insecure: false };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { uri: null, insecure: false };
    }
    return {
      uri: `${url.origin}${SSO_CALLBACK_PATH}`,
      insecure: url.protocol === "http:" && !isLoopbackHost(url.hostname),
    };
  } catch {
    return { uri: null, insecure: false };
  }
}

function splitEntries(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface SsoSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing configuration to edit, or null to set up from scratch. */
  existing: PublicSsoConfig | null;
  /** Called after every successful save or enable with the stored config. */
  onSaved: (config: PublicSsoConfig) => void;
}

export function SsoSetupWizard({
  open,
  onOpenChange,
  existing,
  onSaved,
}: SsoSetupWizardProps) {
  const [step, setStep] = useState<StepId>("provider");
  const [form, setForm] = useState<WizardForm>(() => formFromExisting(existing, ""));
  const [discovery, setDiscovery] = useState<DiscoveryState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PublicSsoConfig | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  // Snapshot create-vs-edit when the dialog opens: `existing` refreshes after
  // the first save, and the title must not flip mid-run.
  const [editing, setEditing] = useState(!!existing);
  const cancelTestRef = useRef<() => void>(() => {});

  // Reset everything whenever the dialog opens (React's "adjust state on prop
  // change" pattern), so a re-opened wizard never shows a previous run.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setEditing(!!existing);
      setStep("provider");
      setForm(formFromExisting(existing, currentOrigin()));
      setDiscovery({ kind: "idle" });
      setSaving(false);
      setSaveError(null);
      setSaved(null);
      setTest({ kind: "idle" });
      setEnabling(false);
      setEnableError(null);
    }
  }

  useEffect(() => {
    return () => cancelTestRef.current();
  }, []);

  const preset = SSO_PROVIDER_PRESETS[form.provider];
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;
  const redirect = useMemo(() => deriveRedirectUri(form.baseUrl), [form.baseUrl]);
  const issuerTrimmed = form.issuer.trim();
  const discoveryOk =
    discovery.kind === "ok" && discovery.issuer === issuerTrimmed;
  const hasSecret = form.clientSecret.trim() !== "" || !!existing?.hasClientSecret;
  const domains = splitEntries(form.allowedDomains);
  const emails = splitEntries(form.allowedEmails);
  const accessOk =
    (form.allowAnyIdpUser && form.provider !== "google") ||
    domains.length + emails.length > 0;

  const canContinue: Record<StepId, boolean> = {
    provider: form.displayName.trim().length > 0,
    register: redirect.uri !== null,
    credentials:
      issuerTrimmed.length > 0 &&
      form.clientId.trim().length > 0 &&
      hasSecret &&
      discoveryOk,
    access: accessOk,
    finish: true,
  };

  const completed: Record<StepId, boolean> = {
    provider: canContinue.provider,
    register: canContinue.register,
    credentials: canContinue.credentials,
    access: canContinue.access,
    finish: !!saved,
  };

  function update<K extends keyof WizardForm>(key: K, value: WizardForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function selectProvider(p: SsoProvider) {
    setForm((f) => {
      const prev = SSO_PROVIDER_PRESETS[f.provider];
      const next = SSO_PROVIDER_PRESETS[p];
      const displayName =
        !f.displayName.trim() || f.displayName === prev.label
          ? next.label
          : f.displayName;
      let issuer = f.issuer;
      if (next.fixedIssuer) issuer = next.fixedIssuer;
      else if (prev.fixedIssuer && f.issuer === prev.fixedIssuer) issuer = "";
      return {
        ...f,
        provider: p,
        displayName,
        issuer,
        allowAnyIdpUser: p === "google" ? false : f.allowAnyIdpUser,
      };
    });
    setDiscovery({ kind: "idle" });
  }

  function go(id: StepId) {
    setStep(id);
  }

  function next() {
    if (!isLast && canContinue[step]) go(STEPS[stepIndex + 1].id);
  }

  function back() {
    if (!isFirst) go(STEPS[stepIndex - 1].id);
  }

  async function checkIssuer() {
    const issuer = issuerTrimmed;
    if (!issuer) return;
    setDiscovery({ kind: "loading", issuer });
    try {
      const result = await discoverIssuer(issuer);
      setDiscovery({ kind: "ok", issuer, result });
    } catch (e) {
      setDiscovery({
        kind: "error",
        issuer,
        message: e instanceof Error ? e.message : "Discovery failed",
      });
    }
  }

  // Turning the password fallback off on a LIVE configuration is the one
  // lockout-capable edit, and the server refuses it without a passing test of
  // the saved configuration. So a save keeps the fallback on for now, and the
  // finish step offers the flip as its own action once the test has passed.
  const deferFallbackOff =
    !!existing?.enabled &&
    existing.passwordLoginEnabled &&
    !form.passwordLoginEnabled;

  async function save() {
    if (!redirect.uri) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cfg = await saveSsoConfig({
        provider: form.provider,
        displayName: form.displayName.trim(),
        issuer: issuerTrimmed,
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim() || undefined,
        redirectUri: redirect.uri,
        allowedDomains: domains,
        allowedEmails: emails,
        allowAnyIdpUser: form.allowAnyIdpUser,
        passwordLoginEnabled: deferFallbackOff ? true : form.passwordLoginEnabled,
        // A fresh setup stays off until the admin enables it deliberately;
        // editing a live config keeps it live.
        enabled: existing?.enabled ?? false,
      });
      setSaved(cfg);
      setTest({ kind: "idle" });
      onSaved(cfg);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function startTest() {
    cancelTestRef.current();
    setTest({ kind: "running" });
    cancelTestRef.current = runSsoTest((result) => {
      setTest({ kind: "done", result });
    });
  }

  async function applySwitch(
    patch: { enabled: true } | { passwordLoginEnabled: false },
    failure: string
  ) {
    setEnabling(true);
    setEnableError(null);
    try {
      const cfg = await saveSsoConfig(patch);
      setSaved(cfg);
      onSaved(cfg);
    } catch (e) {
      setEnableError(e instanceof Error ? e.message : failure);
    } finally {
      setEnabling(false);
    }
  }

  const enable = () => applySwitch({ enabled: true }, "Failed to enable");
  const turnOffFallback = () =>
    applySwitch(
      { passwordLoginEnabled: false },
      "Failed to turn off password sign-in"
    );

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && (saving || enabling)) return;
    if (!nextOpen) cancelTestRef.current();
    onOpenChange(nextOpen);
  }

  const needsTestBeforeEnable = saved
    ? !saved.passwordLoginEnabled
    : !form.passwordLoginEnabled;
  const testPassed = test.kind === "done" && test.result.ok;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl" data-testid="sso-wizard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            {editing ? "Edit single sign-on" : "Set up single sign-on"}
          </DialogTitle>
          <DialogDescription>
            Connect an OpenID Connect identity provider so admins can sign in
            with their organization account.
          </DialogDescription>
        </DialogHeader>

        <Stepper steps={STEPS} activeStep={step} completed={completed} onSelect={go} />

        <div className="max-h-[55vh] overflow-y-auto pr-1 -mr-1">
          {step === "provider" && (
            <ProviderStep form={form} onSelect={selectProvider} onChange={update} />
          )}
          {step === "register" && (
            <RegisterStep
              form={form}
              redirectUri={redirect.uri}
              insecure={redirect.insecure}
              onChange={update}
            />
          )}
          {step === "credentials" && (
            <CredentialsStep
              form={form}
              existing={existing}
              discovery={discovery}
              discoveryOk={discoveryOk}
              onChange={(key, value) => {
                update(key, value);
                if (key === "issuer") setDiscovery({ kind: "idle" });
              }}
              onCheck={checkIssuer}
            />
          )}
          {step === "access" && (
            <AccessStep form={form} domains={domains} emails={emails} onChange={update} />
          )}
          {step === "finish" && (
            <FinishStep
              form={form}
              existing={existing}
              redirectUri={redirect.uri}
              domains={domains}
              emails={emails}
              saving={saving}
              saveError={saveError}
              saved={saved}
              onSave={save}
              test={test}
              onTest={startTest}
              enabling={enabling}
              enableError={enableError}
              onEnable={enable}
              deferFallbackOff={deferFallbackOff}
              onTurnOffFallback={turnOffFallback}
              needsTestBeforeEnable={needsTestBeforeEnable}
              testPassed={testPassed}
            />
          )}
        </div>

        <DialogFooter className="sm:justify-between sm:items-center">
          <Button variant="ghost" size="sm" onClick={back} disabled={isFirst || saving || enabling}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Step {stepIndex + 1} of {STEPS.length}
            {preset && step !== "provider" ? ` · ${preset.label}` : ""}
          </p>
          {isLast ? (
            <Button size="sm" onClick={() => handleOpenChange(false)} disabled={saving || enabling}>
              {saved ? "Done" : "Close"}
            </Button>
          ) : (
            <Button size="sm" onClick={next} disabled={!canContinue[step]} data-testid="sso-wizard-next">
              Continue
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stepper({
  steps,
  activeStep,
  completed,
  onSelect,
}: {
  steps: StepDef[];
  activeStep: StepId;
  completed: Record<StepId, boolean>;
  onSelect: (id: StepId) => void;
}) {
  const activeIdx = steps.findIndex((s) => s.id === activeStep);
  return (
    <nav aria-label="Setup progress" className="rounded-lg border bg-muted/30 p-2">
      <ol className="flex items-center gap-1">
        {steps.map((s, idx) => {
          const isActive = s.id === activeStep;
          const isDone = completed[s.id] && !isActive;
          // Only already-reached steps are clickable, so the gating on
          // Continue can't be skipped by jumping ahead.
          const reachable = idx <= activeIdx;
          const Icon = s.icon;
          return (
            <li key={s.id} className="flex items-center gap-1 flex-1 min-w-0">
              <button
                type="button"
                onClick={() => reachable && onSelect(s.id)}
                disabled={!reachable}
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 px-1.5 py-1 rounded-md min-w-0 flex-1 text-left transition-colors",
                  isActive
                    ? "bg-primary/10 text-foreground"
                    : reachable
                    ? "hover:bg-muted text-muted-foreground"
                    : "text-muted-foreground/60 cursor-default"
                )}
              >
                <span
                  className={cn(
                    "h-6 w-6 shrink-0 rounded-full flex items-center justify-center border text-[11px] font-semibold",
                    isActive
                      ? "bg-primary text-primary-foreground border-primary"
                      : isDone
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "bg-background border-border"
                  )}
                >
                  {isDone ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                </span>
                <span className="hidden sm:block text-[11px] font-medium truncate">
                  {s.title}
                </span>
              </button>
              {idx < steps.length - 1 && (
                <span
                  className={cn(
                    "h-px w-3 shrink-0",
                    idx < activeIdx ? "bg-emerald-500/60" : "bg-border"
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

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
      <AlertTriangle className="h-4 w-4 text-amber-600" />
      <AlertDescription className="text-amber-800 dark:text-amber-300 text-xs">
        {children}
      </AlertDescription>
    </Alert>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
      <XCircle className="h-4 w-4 text-red-600" />
      <AlertDescription className="text-red-800 dark:text-red-300 text-xs break-words">
        {children}
      </AlertDescription>
    </Alert>
  );
}

function ProviderStep({
  form,
  onSelect,
  onChange,
}: {
  form: WizardForm;
  onSelect: (p: SsoProvider) => void;
  onChange: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Which identity provider do you use?</p>
        <Hint>
          Any provider that speaks OpenID Connect works. Presets fill in the
          issuer and show provider-specific instructions.
        </Hint>
      </div>
      <div className="grid sm:grid-cols-2 gap-2.5">
        {SSO_PROVIDERS.map((p) => {
          const preset = SSO_PROVIDER_PRESETS[p];
          const selected = form.provider === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onSelect(p)}
              aria-pressed={selected}
              data-testid={`sso-provider-${p}`}
              className={cn(
                "text-left rounded-lg border p-3 transition-colors",
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                  : "hover:bg-muted/60"
              )}
            >
              <p className="text-sm font-semibold flex items-center justify-between gap-2">
                {preset.label}
                {selected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{preset.blurb}</p>
            </button>
          );
        })}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sso-display-name" className="text-xs">
          Login button label
        </Label>
        <Input
          id="sso-display-name"
          value={form.displayName}
          onChange={(e) => onChange("displayName", e.target.value)}
          maxLength={40}
          className="h-8 text-sm"
        />
        <Hint>
          Shown on the login page as &ldquo;Continue with{" "}
          {form.displayName.trim() || "…"}&rdquo;.
        </Hint>
      </div>
    </div>
  );
}

function RegisterStep({
  form,
  redirectUri,
  insecure,
  onChange,
}: {
  form: WizardForm;
  redirectUri: string | null;
  insecure: boolean;
  onChange: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
}) {
  const preset = SSO_PROVIDER_PRESETS[form.provider];
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Register Open Admin with {preset.label}</p>
        <Hint>
          Create a web application at the provider and give it the redirect URI
          below. Keep that tab open — the next step needs its client ID and
          secret.
        </Hint>
      </div>

      <ol className="space-y-2">
        {preset.steps.map((text, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="h-5 w-5 shrink-0 rounded-full bg-primary/10 text-primary text-[11px] font-semibold flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <span className="text-muted-foreground">{text}</span>
          </li>
        ))}
      </ol>

      {preset.consoleUrl && (
        <a
          href={preset.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary underline underline-offset-2"
        >
          {preset.consoleLabel}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="sso-base-url" className="text-xs">
          Open Admin base URL
        </Label>
        <Input
          id="sso-base-url"
          value={form.baseUrl}
          onChange={(e) => onChange("baseUrl", e.target.value)}
          placeholder="https://admin.example.com"
          className="h-8 text-sm font-mono"
        />
        <Hint>
          The address people use to reach Open Admin. Behind a reverse proxy, use the
          public URL — the provider sends the browser back here.
        </Hint>
      </div>

      <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Redirect URI to register
        </p>
        <div className="flex items-center gap-2">
          <code
            className={cn(
              "text-xs font-mono break-all flex-1",
              !redirectUri && "text-muted-foreground"
            )}
            data-testid="sso-redirect-uri"
          >
            {redirectUri ?? "Enter a valid base URL above"}
          </code>
          {redirectUri && <CopyButton value={redirectUri} />}
        </div>
      </div>

      {insecure && (
        <Warning>
          That base URL is plain http. Most providers only accept https redirect
          URIs (localhost is the usual exception), and sessions over http are
          exposed on the network.
        </Warning>
      )}

      {preset.notes.map((note, i) => (
        <Hint key={i}>{note}</Hint>
      ))}
    </div>
  );
}

function CredentialsStep({
  form,
  existing,
  discovery,
  discoveryOk,
  onChange,
  onCheck,
}: {
  form: WizardForm;
  existing: PublicSsoConfig | null;
  discovery: DiscoveryState;
  discoveryOk: boolean;
  onChange: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  onCheck: () => void;
}) {
  const preset = SSO_PROVIDER_PRESETS[form.provider];
  const loading = discovery.kind === "loading";
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Paste the provider&apos;s details</p>
        <Hint>
          The issuer check fetches the provider&apos;s discovery document from the
          server, so you know the endpoints are reachable before saving.
        </Hint>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sso-issuer" className="text-xs">
          Issuer URL <span className="text-red-500">*</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="sso-issuer"
            value={form.issuer}
            onChange={(e) => onChange("issuer", e.target.value)}
            placeholder={preset.issuerPlaceholder}
            disabled={!!preset.fixedIssuer}
            className="h-8 text-sm font-mono"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCheck}
            disabled={!form.issuer.trim() || loading}
            className="h-8 shrink-0"
            data-testid="sso-check-issuer"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
            )}
            Check issuer
          </Button>
        </div>
        <Hint>{preset.issuerHint}</Hint>
      </div>

      {discovery.kind === "error" && <Problem>{discovery.message}</Problem>}
      {discovery.kind === "ok" && (
        <DiscoveryPanel result={discovery.result} stale={!discoveryOk} />
      )}
      {discovery.kind === "idle" && (
        <Hint>Run the issuer check to continue.</Hint>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="sso-client-id" className="text-xs">
          Client ID <span className="text-red-500">*</span>
        </Label>
        <Input
          id="sso-client-id"
          value={form.clientId}
          onChange={(e) => onChange("clientId", e.target.value)}
          className="h-8 text-sm font-mono"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sso-client-secret" className="text-xs">
          Client secret{" "}
          {existing?.hasClientSecret ? (
            <span className="text-muted-foreground">(stored)</span>
          ) : (
            <span className="text-red-500">*</span>
          )}
        </Label>
        <Input
          id="sso-client-secret"
          type="password"
          value={form.clientSecret}
          onChange={(e) => onChange("clientSecret", e.target.value)}
          placeholder={
            existing?.hasClientSecret ? "Leave blank to keep the current secret" : ""
          }
          className="h-8 text-sm font-mono"
          autoComplete="new-password"
        />
        <Hint>
          Stored on the server in the SSO config file (permissions 0600) and never
          shown again.
        </Hint>
      </div>
    </div>
  );
}

function DiscoveryPanel({
  result,
  stale,
}: {
  result: IssuerCheckResult;
  stale: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs space-y-2",
        stale
          ? "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40"
          : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
      )}
      data-testid="sso-discovery"
    >
      <p
        className={cn(
          "font-semibold flex items-center gap-1.5",
          stale
            ? "text-amber-900 dark:text-amber-200"
            : "text-emerald-900 dark:text-emerald-200"
        )}
      >
        {stale ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5" />
        )}
        {stale
          ? "Issuer changed since the last check — run it again"
          : "Discovery document loaded"}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>Issuer</dt>
        <dd className="font-mono break-all text-foreground/80">{result.issuer}</dd>
        <dt>Authorize</dt>
        <dd className="font-mono break-all text-foreground/80">{result.authorizationEndpoint}</dd>
        <dt>Token</dt>
        <dd className="font-mono break-all text-foreground/80">{result.tokenEndpoint}</dd>
        <dt>Keys</dt>
        <dd className="font-mono break-all text-foreground/80">{result.jwksUri}</dd>
        <dt>PKCE</dt>
        <dd className="text-foreground/80">
          {result.pkceAdvertised === null
            ? "not advertised"
            : result.pkceAdvertised
            ? "S256 supported"
            : "S256 not listed"}
        </dd>
      </dl>
      {result.warnings.length > 0 && (
        <ul className="space-y-1 pt-1">
          {result.warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccessStep({
  form,
  domains,
  emails,
  onChange,
}: {
  form: WizardForm;
  domains: string[];
  emails: string[];
  onChange: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
}) {
  const isGoogle = form.provider === "google";
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Who can sign in?</p>
        <Hint>
          The provider proves who someone is; this list decides whether they get
          into Open Admin. Every account that gets in has full admin access.
        </Hint>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sso-domains" className="text-xs">
          Allowed email domains
        </Label>
        <Textarea
          id="sso-domains"
          rows={2}
          value={form.allowedDomains}
          onChange={(e) => onChange("allowedDomains", e.target.value)}
          placeholder="example.com, example.org"
          className="text-sm font-mono min-h-0"
          spellCheck={false}
        />
        <Hint>
          Anyone whose verified sign-in email ends with one of these domains.
          Separate entries with commas or new lines.
          {domains.length > 0 && ` ${domains.length} domain${domains.length === 1 ? "" : "s"} listed.`}
        </Hint>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sso-emails" className="text-xs">
          Allowed email addresses
        </Label>
        <Textarea
          id="sso-emails"
          rows={2}
          value={form.allowedEmails}
          onChange={(e) => onChange("allowedEmails", e.target.value)}
          placeholder="alice@example.com"
          className="text-sm font-mono min-h-0"
          spellCheck={false}
        />
        <Hint>
          Individual accounts, for people outside the domains above.
          {emails.length > 0 && ` ${emails.length} address${emails.length === 1 ? "" : "es"} listed.`}
        </Hint>
      </div>

      {isGoogle ? (
        <Hint>
          Google accounts are public, so at least one domain or address is
          required for this provider.
        </Hint>
      ) : (
        <label className="flex items-start gap-2.5 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={form.allowAnyIdpUser}
            onChange={(e) => onChange("allowAnyIdpUser", e.target.checked)}
          />
          <span>
            Allow any account this provider authenticates
            <span className="block text-xs text-muted-foreground">
              Only safe when the provider itself restricts who is assigned to the
              application. The lists above still apply in addition.
            </span>
          </span>
        </label>
      )}

      {!isGoogle && !form.allowAnyIdpUser && domains.length + emails.length === 0 && (
        <Hint>Add at least one domain or address, or allow any provider account.</Hint>
      )}

      <Separator />

      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={form.passwordLoginEnabled}
          onChange={(e) => onChange("passwordLoginEnabled", e.target.checked)}
          data-testid="sso-password-fallback"
        />
        <span>
          Keep password sign-in as a fallback
          <span className="block text-xs text-muted-foreground">
            Recommended. The APP_PASSWORD form stays on the login page next to the
            single sign-on button.
          </span>
        </span>
      </label>

      {!form.passwordLoginEnabled && (
        <Warning>
          Password sign-in will be turned off for everyone as soon as single
          sign-on is enabled. The wizard will require a passing test sign-in
          before enabling, and you can recover a locked-out server by setting{" "}
          <code className="font-mono">APP_SSO_DISABLED=true</code>.
        </Warning>
      )}
    </div>
  );
}

function FinishStep({
  form,
  existing,
  redirectUri,
  domains,
  emails,
  saving,
  saveError,
  saved,
  onSave,
  test,
  onTest,
  enabling,
  enableError,
  onEnable,
  deferFallbackOff,
  onTurnOffFallback,
  needsTestBeforeEnable,
  testPassed,
}: {
  form: WizardForm;
  existing: PublicSsoConfig | null;
  redirectUri: string | null;
  domains: string[];
  emails: string[];
  saving: boolean;
  saveError: string | null;
  saved: PublicSsoConfig | null;
  onSave: () => void;
  test: TestState;
  onTest: () => void;
  enabling: boolean;
  enableError: string | null;
  onEnable: () => void;
  /** Editing a live config and turning its password fallback off. */
  deferFallbackOff: boolean;
  onTurnOffFallback: () => void;
  needsTestBeforeEnable: boolean;
  testPassed: boolean;
}) {
  const preset = SSO_PROVIDER_PRESETS[form.provider];
  const rows: Array<[string, string]> = [
    ["Provider", preset.label],
    ["Button label", form.displayName.trim()],
    ["Issuer", form.issuer.trim()],
    ["Client ID", form.clientId.trim()],
    [
      "Client secret",
      form.clientSecret.trim()
        ? "•••••••• (new)"
        : existing?.hasClientSecret
        ? "•••••••• (unchanged)"
        : "missing",
    ],
    ["Redirect URI", redirectUri ?? "invalid"],
    ["Allowed domains", domains.length ? domains.join(", ") : "none"],
    ["Allowed addresses", emails.length ? emails.join(", ") : "none"],
    ["Any provider account", form.allowAnyIdpUser ? "yes" : "no"],
    [
      "Password fallback",
      deferFallbackOff
        ? "on until a test passes, then off"
        : form.passwordLoginEnabled
        ? "on"
        : "off",
    ],
  ];
  const enableBlocked = needsTestBeforeEnable && !testPassed;
  // Live config whose fallback is being turned off: the flip is offered here,
  // after a passing test, instead of riding along with the save.
  const fallbackFlipPending =
    deferFallbackOff && !!saved?.enabled && saved.passwordLoginEnabled;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Review, test, enable</p>
        <Hint>
          Saving stores the configuration{existing?.enabled ? "" : " without turning it on"}.
          The test signs in through the provider for real and reports what
          came back, without creating a session.
        </Hint>
      </div>

      <dl className="rounded-lg border divide-y text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[130px_1fr] gap-3 px-3 py-1.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono break-all">{v}</dd>
          </div>
        ))}
      </dl>

      {saveError && <Problem>{saveError}</Problem>}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={onSave} disabled={saving || !redirectUri} data-testid="sso-save">
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5 mr-1.5" />
          )}
          {saving
            ? "Saving…"
            : saved
            ? "Save again"
            : existing
            ? "Save changes"
            : "Save configuration"}
        </Button>
        {saved && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved{saved.enabled ? " — single sign-on is live" : " — not enabled yet"}
          </span>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-semibold">Test sign-in</p>
        <Hint>
          Opens a pop-up that signs in with {form.displayName.trim() || preset.label}{" "}
          and shows the email, name and access decision that came back.
          {!saved && " Save first."}
        </Hint>
        <Button
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={!saved || test.kind === "running"}
          data-testid="sso-test"
        >
          {test.kind === "running" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <KeyRound className="h-3.5 w-3.5 mr-1.5" />
          )}
          {test.kind === "running" ? "Waiting for the pop-up…" : "Test sign-in"}
        </Button>
        {test.kind === "done" && <SsoTestResultPanel result={test.result} />}
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-semibold">Enable</p>
        {fallbackFlipPending ? (
          <>
            <Hint>
              {testPassed
                ? "The test passed with the saved configuration — password sign-in can now be turned off."
                : "Single sign-on is live with the password form still on. Run the test sign-in above; once it passes, password sign-in can be turned off."}
            </Hint>
            {enableError && <Problem>{enableError}</Problem>}
            <Button
              size="sm"
              onClick={onTurnOffFallback}
              disabled={enabling || !testPassed}
              data-testid="sso-fallback-off"
            >
              {enabling ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
              )}
              Turn off password sign-in
            </Button>
          </>
        ) : saved?.enabled ? (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40 p-3 text-xs text-emerald-800 dark:text-emerald-300">
            Single sign-on is enabled. The login page now offers &ldquo;Continue
            with {saved.displayName}&rdquo;
            {saved.passwordLoginEnabled
              ? " alongside the password form."
              : " and password sign-in is turned off."}
          </div>
        ) : (
          <>
            <Hint>
              {enableBlocked
                ? "Password sign-in is being turned off, so a passing test sign-in is required before enabling."
                : "Enable now, or run the test first (recommended)."}
            </Hint>
            {enableError && <Problem>{enableError}</Problem>}
            <Button
              size="sm"
              onClick={onEnable}
              disabled={!saved || enabling || enableBlocked}
              data-testid="sso-enable"
            >
              {enabling ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
              )}
              Enable single sign-on
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
