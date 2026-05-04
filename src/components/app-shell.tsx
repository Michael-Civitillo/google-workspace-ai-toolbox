"use client";

import { usePathname } from "next/navigation";

/**
 * Wraps page content with the standard sidebar offset/padding, except on the
 * login page where the layout is a centered card.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") {
    return <main className="flex-1 min-h-screen">{children}</main>;
  }
  return (
    <main className="flex-1 ml-64 bg-muted/30 min-h-screen">
      <div className="p-8">{children}</div>
    </main>
  );
}
