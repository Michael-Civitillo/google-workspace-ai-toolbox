"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { ConfigBackupPanel } from "@/components/config-backup-panel";
import { SSO_PROVIDER_PRESETS, type PublicSsoConfig } from "@/lib/sso-types";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  KeyRound,
  UserCircle2,
} from "lucide-react";

interface SessionInfo {
  method: "password" | "oidc";
  email: string | null;
  name: string | null;
}

/**
 * App-level settings: who is signed in, the state of single sign-on, and
 * configuration backup for moving the app between servers. Workspace-side
 * setup lives on /setup and /tenants, and single sign-on is configured on
 * /sso; this page is about the app instance itself.
 */
export default function SettingsPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sso, setSso] = useState<PublicSsoConfig | null>(null);
  const [ssoDisabledByEnv, setSsoDisabledByEnv] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || (d.method !== "password" && d.method !== "oidc")) return;
        setSession({
          method: d.method,
          email: typeof d.email === "string" ? d.email : null,
          name: typeof d.name === "string" ? d.name : null,
        });
      })
      .catch(() => {});
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSso((d.sso as PublicSsoConfig | null) ?? null);
        setSsoDisabledByEnv(d.ssoDisabledByEnv === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const preset = sso ? SSO_PROVIDER_PRESETS[sso.provider] : null;
  const ssoLive = !!sso?.enabled && !ssoDisabledByEnv;

  return (
    <>
      <PageHeader
        title="App Settings"
        description="Sign-in methods and configuration backup for this Open Admin instance."
      />

      <div className="max-w-3xl space-y-6">
        {session && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <UserCircle2 className="h-4 w-4" />
            Signed in{" "}
            {session.method === "oidc" ? (
              <>
                as{" "}
                <span className="font-medium text-foreground">
                  {session.email ?? session.name ?? "single sign-on user"}
                </span>{" "}
                <Badge variant="outline">single sign-on</Badge>
              </>
            ) : (
              <>
                with the shared password <Badge variant="outline">password</Badge>
              </>
            )}
          </div>
        )}

        {ssoDisabledByEnv && (
          <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-sm text-amber-800 dark:text-amber-300">
              <code className="font-mono bg-muted px-1 rounded">APP_SSO_DISABLED=true</code>{" "}
              is set in the server environment — single sign-on is switched off
              and password login is available regardless of the configuration.
              Unset it once the identity provider works again.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Single sign-on
            </CardTitle>
            <CardDescription>
              Let admins sign in through your identity provider instead of the
              shared password. The setup wizard lives on its own page.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              {sso ? (
                <>
                  <span className="font-medium">{preset?.label ?? sso.provider}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {ssoLive ? "enabled" : "configured, not enabled"}
                    {sso.passwordLoginEnabled ? "" : " · password sign-in off"}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Not configured — the login page only offers the password form.
                </span>
              )}
            </div>
            <Link
              href="/sso"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              {sso ? "Manage single sign-on" : "Set up single sign-on"}
              <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Archive className="h-5 w-5" />
              Configuration backup
            </CardTitle>
            <CardDescription>
              Save everything configured here (single sign-on, tenants and their
              service-account keys) to a file, and restore it on another server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConfigBackupPanel />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
