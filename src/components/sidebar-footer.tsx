"use client";

import { SessionIdentity } from "./session-identity";
import { ThemeToggle } from "./theme-toggle";
import { LogoutButton } from "./logout-button";

/**
 * Bottom strip of the sidebar: who is signed in, plus the two controls that
 * should always be one click away — theme and sign out. Both are icon buttons
 * so the identity line keeps the room it needs for a long email address.
 */
export function SidebarFooter() {
  return (
    <div className="border-t border-sidebar-border p-3">
      <div className="flex items-center gap-1">
        <SessionIdentity />
        <ThemeToggle />
        <LogoutButton />
      </div>
    </div>
  );
}
