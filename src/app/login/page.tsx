"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Lock, Loader2, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { SSO_ERROR_MESSAGES, type SsoLoginStatus } from "@/lib/sso-types";

/**
 * Restrict the post-login redirect target to internal paths to prevent
 * `?next=https://evil.com` open-redirect attacks. Anything that isn't a
 * single leading-slash path is silently dropped to "/".
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  // Reject protocol-relative ("//evil.com") and absolute URLs.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Reject backslashes outright: the WHATWG URL parser treats "\" as "/",
  // so "/\evil.com" would otherwise navigate to https://evil.com.
  if (raw.includes("\\")) return "/";
  // Reject paths containing schemes (e.g. "/foo?x=javascript:bad" is fine
  // — that's just a query string, but a bare scheme like "javascript:..." in
  // the path itself is dangerous).
  if (/[\r\n]/.test(raw)) return "/";
  return raw;
}

const PASSWORD_ONLY: SsoLoginStatus = {
  ssoEnabled: false,
  ssoDisplayName: null,
  passwordLoginEnabled: true,
};

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const ssoErrorCode = params.get("sso_error");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while the sign-in options are still loading.
  const [sso, setSso] = useState<SsoLoginStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/sso/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        setSso({
          ssoEnabled: d?.ssoEnabled === true,
          ssoDisplayName:
            typeof d?.ssoDisplayName === "string" ? d.ssoDisplayName : null,
          passwordLoginEnabled: d?.passwordLoginEnabled !== false,
        });
      })
      .catch(() => {
        // The status endpoint failing must not hide the password form: it is
        // still gated by APP_PASSWORD on the server.
        if (!cancelled) setSso(PASSWORD_ONLY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      router.replace(next);
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const ssoMessage = ssoErrorCode
    ? SSO_ERROR_MESSAGES[ssoErrorCode] ?? SSO_ERROR_MESSAGES.server_error
    : null;
  const ssoHref = `/api/auth/oidc/start?next=${encodeURIComponent(next)}`;
  const showSso = sso?.ssoEnabled === true;
  const showPassword = sso?.passwordLoginEnabled !== false;
  const bannerText = error ?? (password || submitting ? null : ssoMessage);

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
            <Lock className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            {showSso && showPassword
              ? "Use your organization account, or the Open Admin password."
              : showSso
              ? "Use your organization account to continue."
              : "Enter the Open Admin password to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {bannerText && (
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                  {bannerText}
                </AlertDescription>
              </Alert>
            )}

            {sso === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sign-in options…
              </div>
            ) : (
              <>
                {showSso && (
                  <a
                    href={ssoHref}
                    className={cn(buttonVariants({ size: "lg" }), "w-full")}
                    data-testid="sso-login"
                  >
                    <KeyRound className="h-4 w-4" />
                    Continue with {sso.ssoDisplayName ?? "single sign-on"}
                  </a>
                )}

                {showSso && showPassword && (
                  <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    or
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}

                {showPassword && (
                  <form onSubmit={submit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoFocus={!showSso}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={!password || submitting}
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
                    </Button>
                    {!showSso && (
                      <p className="text-xs text-muted-foreground text-center">
                        Set <code className="bg-muted px-1 rounded">APP_PASSWORD</code> on the server to enable login.
                      </p>
                    )}
                  </form>
                )}

                {showSso && !showPassword && (
                  <p className="text-xs text-muted-foreground text-center">
                    Password sign-in is turned off. Set{" "}
                    <code className="bg-muted px-1 rounded">APP_SSO_DISABLED=true</code>{" "}
                    on the server to restore it.
                  </p>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
