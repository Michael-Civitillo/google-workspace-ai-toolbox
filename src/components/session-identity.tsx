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

  if (!session) return null;

  const isSso = session.method === "oidc";
  const primary = isSso ? session.email ?? session.name ?? "Signed in" : "Signed in";
  const secondary = isSso
    ? session.name && session.email
      ? session.name
      : "Single sign-on"
    : "Shared password session";

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 mb-1 rounded-lg text-xs min-w-0"
      title={isSso ? `${primary} via single sign-on` : secondary}
    >
      <span className="h-7 w-7 shrink-0 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
        {isSso ? <KeyRound className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground/90">{primary}</span>
        <span className="block truncate text-muted-foreground">{secondary}</span>
      </span>
    </div>
  );
}
