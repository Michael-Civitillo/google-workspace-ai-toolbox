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
import { PageHeader } from "@/components/page-header";
import { SsoSettingsForm } from "@/components/sso-settings-form";
import { ConfigBackupPanel } from "@/components/config-backup-panel";
import { AlertCircle, Archive, KeyRound, UserCircle2 } from "lucide-react";

interface Me {
  sub: string | null;
  method: "password" | "sso";
}

/**
 * App-level settings: who can sign in (SSO / password) and configuration
 * backup for moving the toolbox between servers. Workspace-side setup lives
 * on /setup and /tenants; this page is about the app itself.
 */
export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ssoRescueActive, setSsoRescueActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.method) setMe(data);
      })
      .catch(() => {});
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSsoRescueActive(Boolean(data?.ssoRescueActive));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <PageHeader
        title="App Settings"
        description="Single sign-on, sign-in methods, and configuration backup for this toolbox instance."
      />

      <div className="max-w-3xl space-y-6">
        {me && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <UserCircle2 className="h-4 w-4" />
            Signed in{" "}
            {me.method === "sso" ? (
              <>
                as <span className="font-medium text-foreground">{me.sub}</span>{" "}
                <Badge variant="outline">SSO</Badge>
              </>
            ) : (
              <>
                with the toolbox password{" "}
                <Badge variant="outline">password</Badge>
              </>
            )}
          </div>
        )}

        {ssoRescueActive && (
          <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-sm text-amber-800 dark:text-amber-300">
              <code className="font-mono bg-muted px-1 rounded">SSO_RESCUE=true</code>{" "}
              is set in the server environment — password login is forced on
              regardless of the setting below. Unset it once SSO works again.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Single sign-on (OIDC)
            </CardTitle>
            <CardDescription>
              Let admins sign in through your identity provider instead of the
              shared password. Authorization-code flow with PKCE against any
              OpenID Connect provider.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SsoSettingsForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Archive className="h-5 w-5" />
              Configuration backup
            </CardTitle>
            <CardDescription>
              Save everything configured here (SSO + tenants) to a file, and
              restore it on another server.
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
