"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Lock, Loader2, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

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

/** Friendly copy for the ssoError codes the SSO routes redirect back with. */
const SSO_ERROR_MESSAGES: Record<string, string> = {
  disabled: "SSO is not enabled on this server.",
  config:
    "SSO is misconfigured on this server — the identity provider could not be reached. Check the issuer settings.",
  state:
    "Your sign-in attempt expired or was already used. Please try again.",
  denied: "The identity provider reported that sign-in was cancelled or refused.",
  exchange:
    "Sign-in could not be completed with the identity provider. Please try again — if it persists, check the server logs.",
  email_missing:
    "The identity provider did not return an email address. Make sure the email scope is granted for this app.",
  email_unverified:
    "Your email address is unverified with the identity provider.",
  not_allowed: "Your account is not authorised to use this toolbox.",
};

interface AuthMethods {
  configured: boolean;
  passwordGateSet: boolean;
  password: boolean;
  sso: { buttonLabel: string } | null;
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const ssoErrorCode = params.get("ssoError");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    ssoErrorCode
      ? SSO_ERROR_MESSAGES[ssoErrorCode] ?? "SSO sign-in failed. Please try again."
      : null
  );
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/methods")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setMethods(data);
      })
      .catch(() => {
        // Endpoint unreachable — keep the classic password form usable.
        if (!cancelled) {
          setMethods({
            configured: true,
            passwordGateSet: true,
            password: true,
            sso: null,
          });
        }
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

  const showSso = !!methods?.sso;
  const showPassword = methods ? methods.password : true;
  const nothingAvailable = methods && !showSso && !showPassword;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
            <Lock className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            {showSso && !showPassword
              ? "Use your organisation's single sign-on to continue."
              : "Enter the toolbox password to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {error && (
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                  {error}
                </AlertDescription>
              </Alert>
            )}

            {!methods ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <>
                {showSso && (
                  // A real navigation, not a fetch: the route 302s to the IdP.
                  <a
                    href={`/api/auth/sso/login?next=${encodeURIComponent(next)}`}
                    className={cn(
                      buttonVariants({
                        variant: showPassword ? "outline" : "default",
                      }),
                      "w-full"
                    )}
                  >
                    <KeyRound className="h-4 w-4 mr-2" />
                    {methods.sso?.buttonLabel || "Continue with SSO"}
                  </a>
                )}

                {showSso && showPassword && (
                  <div className="flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      or
                    </span>
                    <Separator className="flex-1" />
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
                      {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Sign in"
                      )}
                    </Button>
                  </form>
                )}

                {nothingAvailable && (
                  <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
                    <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
                      No sign-in method is available. Set{" "}
                      <code className="bg-muted px-1 rounded">APP_PASSWORD</code>{" "}
                      on the server, or set{" "}
                      <code className="bg-muted px-1 rounded">SSO_RESCUE=true</code>{" "}
                      to re-enable password login if SSO is broken.
                    </AlertDescription>
                  </Alert>
                )}

                {!methods.configured && (
                  <p className="text-xs text-muted-foreground text-center">
                    Set{" "}
                    <code className="bg-muted px-1 rounded">APP_PASSWORD</code>{" "}
                    on the server to enable login.
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
