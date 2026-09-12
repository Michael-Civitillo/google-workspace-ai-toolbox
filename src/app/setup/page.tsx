"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import {
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
  Terminal,
  ExternalLink,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  bin?: string;
  error?: string;
  /** True in the packaged desktop build, where the gws CLI is optional. */
  packaged?: boolean;
}

export default function Setup() {
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [tenantCount, setTenantCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // In the packaged desktop build the gws CLI is optional: every Workspace
  // operation runs through the googleapis SDK with the tenant's service
  // account. Missing CLI is then a neutral fact, not a broken install.
  const cliOptional = !!status?.packaged;

  useEffect(() => {
    Promise.all([
      fetch("/api/gws/status")
        .then((res) => res.json())
        .catch(() => ({ installed: false, authenticated: false })),
      fetch("/api/tenants")
        .then((res) => res.json())
        .then((d) => (Array.isArray(d?.tenants) ? d.tenants.length : 0))
        .catch(() => 0),
    ])
      .then(([s, count]) => {
        setStatus(s);
        setTenantCount(count);
      })
      .finally(() => setLoading(false));
  }, []);


  return (
    <>
      <PageHeader
        title="Setup"
        description="Configure the Google Workspace CLI to connect this app to your Google Workspace."
      />

      <div className="max-w-3xl space-y-6">
        {/* Guided onboarding banner */}
        <Link
          href="/onboarding"
          className="rgb-ring rgb-ring-hover group flex items-center gap-4 rounded-xl border border-primary/25 bg-primary/5 p-4 outline-none transition-colors hover:bg-primary/8 focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-tight">
              Prefer a guided walkthrough?
            </span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              The 5-step onboarding wizard handles install, service account
              setup, and your first tenant in one flow.
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            Open
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>

        {/* Status Check */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Connection Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking CLI status...
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    {status?.installed ? (
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    ) : (
                      <XCircle
                        className={`h-5 w-5 ${
                          cliOptional ? "text-muted-foreground" : "text-danger"
                        }`}
                      />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        Google Workspace CLI
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {status?.installed
                          ? `Version ${status.version}`
                          : cliOptional
                          ? "Not installed — this build doesn't need it"
                          : "Not detected on this machine"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status?.installed
                        ? "border-success/25 bg-success/10 text-success-fg"
                        : cliOptional
                        ? "text-muted-foreground"
                        : "border-danger/25 bg-danger/10 text-danger-fg"
                    }
                  >
                    {status?.installed
                      ? "Installed"
                      : cliOptional
                      ? "Optional"
                      : "Missing"}
                  </Badge>
                </div>

                {!status?.installed && !cliOptional && (status?.bin || status?.error) && (
                  <div className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs space-y-1">
                    <p className="font-semibold text-warning-fg">
                      Diagnostic info
                    </p>
                    {status.bin && (
                      <p className="text-warning-fg">
                        Tried to run:{" "}
                        <code className="font-mono">{status.bin}</code>
                        {status.bin !== "gws" &&
                          status.bin !== "gws.cmd" &&
                          " (from $GWS_BIN)"}
                      </p>
                    )}
                    {status.error && (
                      <p className="text-warning-fg break-all">
                        Error:{" "}
                        <code className="font-mono">{status.error}</code>
                      </p>
                    )}
                    <p className="text-warning-fg pt-1">
                      Make sure <code className="font-mono">gws --version</code>{" "}
                      works in the same terminal you started{" "}
                      <code className="font-mono">npm run dev</code> from. On
                      Windows, you may need to set{" "}
                      <code className="font-mono">$env:GWS_BIN</code> to the
                      full path of <code className="font-mono">gws.cmd</code> or{" "}
                      <code className="font-mono">gws.exe</code>.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    {status?.authenticated ? (
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    ) : (
                      <XCircle
                        className={`h-5 w-5 ${
                          cliOptional ? "text-muted-foreground" : "text-danger"
                        }`}
                      />
                    )}
                    <div>
                      <p className="text-sm font-medium">CLI authentication</p>
                      <p className="text-xs text-muted-foreground">
                        {status?.authenticated
                          ? "gws CLI has its own credentials configured"
                          : cliOptional
                          ? "Not applicable — operations use the tenant's service account"
                          : "gws CLI has no credentials — run gws auth login or set up a service account"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status?.authenticated
                        ? "border-success/25 bg-success/10 text-success-fg"
                        : cliOptional
                        ? "text-muted-foreground"
                        : "border-danger/25 bg-danger/10 text-danger-fg"
                    }
                  >
                    {status?.authenticated
                      ? "Connected"
                      : cliOptional
                      ? "Optional"
                      : "Not Connected"}
                  </Badge>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    {(tenantCount ?? 0) > 0 ? (
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    ) : (
                      <XCircle className="h-5 w-5 text-danger" />
                    )}
                    <div>
                      <p className="text-sm font-medium">Open Admin tenants</p>
                      <p className="text-xs text-muted-foreground">
                        {tenantCount === null
                          ? "Checking..."
                          : tenantCount === 0
                          ? "No tenants configured — add one to start running operations"
                          : `${tenantCount} tenant${
                              tenantCount === 1 ? "" : "s"
                            } configured`}
                      </p>
                    </div>
                  </div>
                  {(tenantCount ?? 0) === 0 ? (
                    <a
                      href="/tenants"
                      className="text-xs font-medium underline text-primary"
                    >
                      Add a tenant →
                    </a>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-success/25 bg-success/10 text-success-fg"
                    >
                      Ready
                    </Badge>
                  )}
                </div>

                {cliOptional && (
                  <p className="text-xs text-muted-foreground pt-1">
                    This is the packaged desktop build. It bundles its own
                    runtime and runs every Workspace operation through Google&apos;s
                    APIs with your tenant&apos;s service account, so the{" "}
                    <code className="font-mono">gws</code> CLI is optional —
                    install it only if you want to use it from a terminal.
                  </p>
                )}

                <p className="text-xs text-muted-foreground pt-1">
                  <strong>CLI authentication</strong> means the{" "}
                  <code className="font-mono">gws</code> CLI itself has
                  credentials. <strong>Open Admin tenants</strong> are what this
                  app uses to run operations against your Workspace — each
                  tenant points at a service account JSON and an admin email.
                  You need at least one tenant before any feature works.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Installation Steps */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              Installation Guide
            </CardTitle>
            <CardDescription>
              Follow these steps to install and configure the gws CLI.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Step 1 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                  1
                </div>
                <h3 className="text-sm font-semibold">Install the CLI</h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Choose your preferred installation method:
              </p>
              <div className="ml-8 space-y-2">
                <code className="block p-3 rounded-lg bg-muted text-sm font-mono">
                  npm install -g @googleworkspace/cli
                </code>
                <p className="text-xs text-muted-foreground">
                  Or via Homebrew:{" "}
                  <code className="bg-muted px-1 rounded">
                    brew install googleworkspace-cli
                  </code>
                </p>
              </div>
            </div>

            <Separator />

            {/* Step 2 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                  2
                </div>
                <h3 className="text-sm font-semibold">
                  Set Up Authentication
                </h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Run the setup wizard to create a GCP project and authenticate:
              </p>
              <code className="block ml-8 p-3 rounded-lg bg-muted text-sm font-mono">
                gws auth setup
              </code>
              <p className="text-xs text-muted-foreground ml-8">
                This requires the <code className="bg-muted px-1 rounded">gcloud</code> CLI.
                Alternatively, log in manually:
              </p>
              <code className="block ml-8 p-3 rounded-lg bg-muted text-sm font-mono">
                gws auth login -s gmail,calendar
              </code>
            </div>

            <Separator />

            {/* Step 3 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                  3
                </div>
                <h3 className="text-sm font-semibold">
                  Enable Required APIs
                </h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Ensure the following APIs are enabled in your GCP project:
              </p>
              <ul className="ml-8 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                <li>Gmail API</li>
                <li>Google Calendar API</li>
                <li>Admin SDK API (Domain Change, Offboarding)</li>
                <li>Admin Data Transfer API (Offboarding — Drive ownership transfer)</li>
                <li>Google Drive API (Sharing Audit)</li>
              </ul>
              <p className="text-sm text-muted-foreground ml-8 mt-2">
                And authorise these scopes for the service account in the Admin
                Console under <em>Domain-wide Delegation</em>:
              </p>
              <ul className="ml-8 space-y-1 text-xs text-muted-foreground list-disc list-inside font-mono">
                <li>https://www.googleapis.com/auth/gmail.settings.sharing</li>
                <li>https://www.googleapis.com/auth/gmail.settings.basic</li>
                <li>https://www.googleapis.com/auth/gmail.readonly</li>
                <li>https://www.googleapis.com/auth/gmail.insert</li>
                <li>https://www.googleapis.com/auth/gmail.labels</li>
                <li>https://www.googleapis.com/auth/calendar</li>
                <li>https://www.googleapis.com/auth/admin.directory.user</li>
                <li>https://www.googleapis.com/auth/admin.directory.user.security</li>
                <li>https://www.googleapis.com/auth/admin.directory.domain.readonly</li>
                <li>https://www.googleapis.com/auth/admin.datatransfer</li>
                <li>https://www.googleapis.com/auth/drive.metadata.readonly</li>
                <li>https://www.googleapis.com/auth/drive</li>
              </ul>
            </div>

            <Separator />

            {/* Step 4 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                  4
                </div>
                <h3 className="text-sm font-semibold">
                  Set Up Gemini (for AI features)
                </h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Get a free API key from{" "}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Google AI Studio
                </a>{" "}
                and set it:
              </p>
              <code className="block ml-8 p-3 rounded-lg bg-muted text-sm font-mono">
                export GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
              </code>
              <p className="text-xs text-muted-foreground ml-8">
                Powers the AI Command, Bulk Operations, and User Audit features.
              </p>
            </div>

            <Separator />

            {/* Step 5 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                  5
                </div>
                <h3 className="text-sm font-semibold">
                  Verify Connection
                </h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Test that everything works:
              </p>
              <code className="block ml-8 p-3 rounded-lg bg-muted text-sm font-mono">
                gws gmail users getProfile --userId=me
              </code>
            </div>

            <Separator />

            <Alert variant="info">
              <ExternalLink className="h-4 w-4 text-info" />
              <AlertDescription>
                For service account setup (recommended for admin use), see the{" "}
                <a
                  href="https://github.com/googleworkspace/cli#authentication"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline"
                >
                  gws CLI authentication docs
                </a>
                . Service accounts with domain-wide delegation provide access
                to all users in your domain.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
