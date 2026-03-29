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
} from "lucide-react";

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
}

export default function Setup() {
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/gws/status")
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ installed: false, authenticated: false }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <PageHeader
        title="Setup"
        description="Configure the Google Workspace CLI to connect this app to your Google Workspace."
      />

      <div className="max-w-3xl space-y-6">
        {/* Status Check */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
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
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        Google Workspace CLI
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {status?.installed
                          ? `Version ${status.version}`
                          : "Not detected on this machine"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status?.installed
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-red-50 text-red-700 border-red-200"
                    }
                  >
                    {status?.installed ? "Installed" : "Missing"}
                  </Badge>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    {status?.authenticated ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium">Authentication</p>
                      <p className="text-xs text-muted-foreground">
                        {status?.authenticated
                          ? "Credentials are configured"
                          : "No valid credentials found"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status?.authenticated
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-red-50 text-red-700 border-red-200"
                    }
                  >
                    {status?.authenticated ? "Connected" : "Not Connected"}
                  </Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Installation Steps */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
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
                <li>Admin SDK API (for Domain Change feature)</li>
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

            <Alert className="border-blue-200 bg-blue-50">
              <ExternalLink className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-sm">
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
