"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline "copy to clipboard" button. Used inside command snippets in the
 * onboarding wizard so users can grab a one-liner without selecting it.
 */
export function CopyButton({
  value,
  className,
  label = "Copy",
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copied = state === "copied";

  function show(next: "copied" | "failed") {
    setState(next);
    setTimeout(() => setState("idle"), next === "copied" ? 1500 : 3000);
  }

  async function onClick() {
    try {
      await navigator.clipboard.writeText(value);
      show("copied");
    } catch {
      // Older browsers / insecure contexts: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        // execCommand reports failure by returning false, not by throwing.
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      show(ok ? "copied" : "failed");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : state === "failed" ? "Couldn't copy: select the text and copy it" : label}
      className={cn(
        "inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border bg-background/70 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        className
      )}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-success" />
          Copied
        </>
      ) : state === "failed" ? (
        <>
          <Copy className="h-3.5 w-3.5 text-danger" />
          Couldn&apos;t copy
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {label}
        </>
      )}
    </button>
  );
}
