"use client";

import { useEffect, useState, Suspense, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, KeyRound, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { SSO_ERROR_MESSAGES, type SsoLoginStatus } from "@/lib/sso-types";
import { safeNextPath } from "@/lib/safe-next";

const logoGlow = {
  "--rgb-glow-spread": "4px",
  "--rgb-glow-blur": "14px",
  "--rgb-speed": "10s",
} as CSSProperties;

const PASSWORD_ONLY: SsoLoginStatus = {
  ssoEnabled: false,
  ssoDisplayName: null,
  passwordLoginEnabled: true,
};

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  // Same rules as the single sign-on routes: a `next` that would bounce into
  // an API route or back to this page is dropped to "/".
  const next = safeNextPath(params.get("next"));
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

  const subtitle =
    showSso && showPassword
      ? "Use your organization account, or the Open Admin password."
      : showSso
        ? "Use your organization account to continue."
        : "Enter the Open Admin password to continue.";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 45% at 50% 0%, color-mix(in oklab, var(--primary) 12%, transparent), transparent 70%)",
        }}
      />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="rgb-glow rounded-xl" style={logoGlow}>
            <Image
              src="/logo.svg"
              alt="Open Admin"
              width={48}
              height={48}
              className="relative block rounded-xl"
              priority
            />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            Sign in to Open Admin
          </h1>
          <p className="mt-1 max-w-xs text-sm text-pretty text-muted-foreground">
            {subtitle}
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="space-y-4">
              {bannerText && (
                <Alert variant="destructive">
                  <XCircle />
                  <AlertDescription>{bannerText}</AlertDescription>
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
                        size="lg"
                        className="w-full"
                        disabled={!password || submitting}
                      >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
                      </Button>
                      {!showSso && (
                        <p className="text-xs text-muted-foreground text-center">
                          Set <code className="rounded bg-muted px-1 font-mono">APP_PASSWORD</code> on the server to enable login.
                        </p>
                      )}
                    </form>
                  )}

                  {showSso && !showPassword && (
                    <p className="text-xs text-muted-foreground text-center">
                      Password sign-in is turned off. Set{" "}
                      <code className="rounded bg-muted px-1 font-mono">APP_SSO_DISABLED=true</code>{" "}
                      on the server to restore it.
                    </p>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Google Workspace Open Admin
        </p>
      </div>
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
