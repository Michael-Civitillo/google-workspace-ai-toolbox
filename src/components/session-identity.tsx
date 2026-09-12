"use client";

import { useEffect, useState } from "react";
import { KeyRound, UserRound } from "lucide-react";

interface SessionInfo {
  method: "password" | "oidc";
  email: string | null;
  name: string | null;
}

/**
 * Sidebar footer line showing who is signed in. Single sign-on sessions carry
 * the provider's email; password sessions are shared and anonymous.
 */
export function SessionIdentity() {
  const [session, setSession] = useState<SessionInfo | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, []);

  const isSso = session?.method === "oidc";
  const primary = isSso
    ? session?.email ?? session?.name ?? "Signed in"
    : "Signed in";
  const secondary = !session
    ? "Open Admin"
    : isSso
      ? session.name && session.email
        ? session.name
        : "Single sign-on"
      : "Password session";

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs"
      title={isSso ? `${primary} via single sign-on` : secondary}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {isSso ? (
          <KeyRound className="size-3.5" />
        ) : (
          <UserRound className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-medium text-foreground/90">
          {primary}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {secondary}
        </span>
      </span>
    </div>
  );
}
