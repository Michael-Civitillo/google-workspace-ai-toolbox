"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  mounted: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  mounted: false,
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start with a stable value that matches SSR. The inline script in
  // app/layout.tsx applies the correct class to <html> before paint, so
  // there's no flash even though React hasn't hydrated the real value yet.
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("theme") as Theme | null;
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    const initial: Theme =
      stored === "light" || stored === "dark"
        ? stored
        : prefersDark
        ? "dark"
        : "light";
    setTheme(initial);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme, mounted]);

  function toggle() {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("theme", next);
      document.documentElement.classList.toggle("dark", next === "dark");
      return next;
    });
  }

  return (
    <ThemeContext.Provider value={{ theme, mounted, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
