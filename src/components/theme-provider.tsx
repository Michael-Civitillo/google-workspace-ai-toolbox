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
  // Reading storage throws when the browser blocks it (some privacy
  // settings, some embedded views). That must cost the remembered theme,
  // not every page.
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem("theme");
  } catch {
    stored = null;
  }
  if (stored === "light" || stored === "dark") return stored;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
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
    // Keep the side effects out of the state updater: React may invoke
    // updaters more than once (Strict Mode double-invokes them in
    // development), and an updater is meant to be pure.
    const next: Theme = theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Not remembered across visits, but still switched now.
    }
    document.documentElement.classList.toggle("dark", next === "dark");
    setTheme(next);
  }

  return (
    <ThemeContext.Provider value={{ theme, mounted, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
