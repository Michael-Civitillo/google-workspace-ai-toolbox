"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";

/**
 * Light/dark switch. The default (ghost) style lives in the sidebar footer;
 * `variant="floating"` is the standalone pill used where there is no sidebar,
 * i.e. the login page.
 */
export function ThemeToggle({
  variant = "ghost",
  className,
}: {
  variant?: "ghost" | "floating";
  className?: string;
}) {
  const { theme, mounted, toggle } = useTheme();
  const isDark = mounted && theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      suppressHydrationWarning
      className={cn(
        "inline-flex shrink-0 items-center justify-center outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40",
        variant === "floating"
          ? "size-9 rounded-full border border-border bg-card text-muted-foreground shadow-xs hover:text-foreground hover:bg-muted"
          : "size-8 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        className
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
