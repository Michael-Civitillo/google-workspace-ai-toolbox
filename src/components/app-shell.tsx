"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

/**
 * Wraps page content with the sidebar offset and page gutter. The login page
 * has no sidebar, so it gets a floating theme toggle instead of the one in
 * the sidebar footer.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") {
    return (
      <main className="min-h-screen flex-1">
        <div className="fixed top-4 right-4 z-40">
          <ThemeToggle variant="floating" />
        </div>
        {children}
      </main>
    );
  }
  return (
    <main className="ml-64 min-h-screen flex-1 bg-background">
      <div className="px-8 py-8 lg:px-10 lg:py-9">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </div>
    </main>
  );
}
