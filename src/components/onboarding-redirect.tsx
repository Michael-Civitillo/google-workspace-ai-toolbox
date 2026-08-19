"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * First-launch experience: when a signed-in user lands on the dashboard of a
 * fresh install (wizard never completed, no tenants, no SSO), take them
 * straight to the onboarding wizard.
 *
 * Deliberately unpushy: only fires on the dashboard route, only once per
 * browser tab (so "Back" out of the wizard sticks), and never again once the
 * wizard has been completed or skipped — both record completion server-side.
 */
const SESSION_FLAG = "gws_onboarding_prompted";

export function OnboardingRedirect() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname !== "/") return;
    try {
      if (sessionStorage.getItem(SESSION_FLAG)) return;
    } catch {
      // Storage unavailable (rare, e.g. blocked cookies) — still offer the
      // wizard; worst case the redirect repeats in this tab.
    }
    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const freshInstall =
          !data.onboardingCompletedAt &&
          data.tenantCount === 0 &&
          !data.sso;
        if (freshInstall) {
          try {
            sessionStorage.setItem(SESSION_FLAG, "1");
          } catch {}
          router.replace("/onboarding");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
