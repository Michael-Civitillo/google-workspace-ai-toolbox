"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

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

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// Hydration-safe "has the client mounted?" flag. Returns false during SSR and
// the first hydration render (matching the server), then true afterwards —
// without a setState-in-effect.
const noopSubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Read the real theme lazily on the client. On the server this returns
  // "light" to match the initial SSR markup; the inline script in
  // app/layout.tsx applies the correct class to <html> before paint, and
  // consumers gate theme-dependent UI on `mounted`, so there's no flash or
  // hydration mismatch.
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const mounted = useMounted();

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
