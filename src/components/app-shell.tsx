"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

/**
 * Wraps page content with the standard sidebar offset/padding, except on the
 * login page where the layout is a centered card. Renders a floating theme
 * toggle in the top-right of every page so it's always one click away
 * regardless of viewport size or sidebar scroll.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") {
    return (
      <main className="flex-1 min-h-screen">
        <div className="fixed top-4 right-4 z-40">
          <ThemeToggle variant="icon" />
        </div>
        {children}
      </main>
    );
  }
  return (
    <main className="flex-1 ml-64 bg-muted/30 min-h-screen">
      <div className="fixed top-4 right-4 z-40">
        <ThemeToggle variant="icon" />
      </div>
      <div className="p-8">{children}</div>
    </main>
  );
}
