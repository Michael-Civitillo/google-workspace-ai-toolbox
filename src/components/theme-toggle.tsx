"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
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
        "h-9 w-9 inline-flex items-center justify-center rounded-full",
        "border border-border bg-card shadow-sm",
        "text-muted-foreground hover:text-foreground hover:bg-muted",
        "transition-colors"
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
