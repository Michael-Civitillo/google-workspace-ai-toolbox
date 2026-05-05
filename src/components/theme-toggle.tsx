"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  variant?: "sidebar" | "icon";
}

export function ThemeToggle({ variant = "sidebar" }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const label =
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        className={cn(
          "h-9 w-9 inline-flex items-center justify-center rounded-full",
          "border border-border bg-card shadow-sm",
          "text-muted-foreground hover:text-foreground hover:bg-muted",
          "transition-colors"
        )}
      >
        {theme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      title={label}
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors",
        "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}
