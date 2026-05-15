"use client";

import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PreflightResult } from "@/lib/preflight";

export type PreflightState =
  | { kind: "loading" }
  | { kind: "ok"; data: PreflightResult }
  | { kind: "error"; message: string };

export function ScopePreflightPanel({
  state,
  onRetry,
}: {
  state: PreflightState;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Asking Google to issue a token for each required scope…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mt-2 rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs">
        <p className="font-medium text-red-800 dark:text-red-300 flex items-center gap-1.5">
          <XCircle className="h-3.5 w-3.5" />
          Preflight could not run
        </p>
        <p className="text-red-700 dark:text-red-400 mt-1 break-words">
          {state.message}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-7 text-xs mt-1"
        >
          Try again
        </Button>
      </div>
    );
  }

  const { data } = state;
  const failing = data.results.filter((r) => !r.authorized);
  const passing = data.results.filter((r) => r.authorized);

  return (
    <div
      className={cn(
        "mt-2 rounded-md border px-3 py-2 text-xs",
        failing.length === 0
          ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
          : "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40"
      )}
    >
      <p
        className={cn(
          "font-medium flex items-center gap-1.5",
          failing.length === 0
            ? "text-emerald-800 dark:text-emerald-300"
            : "text-red-800 dark:text-red-300"
        )}
      >
        {failing.length === 0 ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            All {passing.length} required scopes authorized
          </>
        ) : (
          <>
            <XCircle className="h-3.5 w-3.5" />
            {failing.length} of {data.results.length} scopes not authorized
          </>
        )}
      </p>
      <p className="mt-1 text-muted-foreground">
        Impersonating <code className="font-mono">{data.adminEmail}</code>
        {data.serviceAccountClientId && (
          <>
            {" "}via service account client ID{" "}
            <code className="font-mono">{data.serviceAccountClientId}</code>
          </>
        )}
      </p>

      {failing.length > 0 && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-red-700 dark:text-red-400">
            Fix this in <strong>admin.google.com → Security → Access and
            data control → API controls → Manage Domain Wide Delegation</strong>.
            Find the row matching the client ID above, click <strong>Edit</strong>,
            and add the missing scope(s) below to the OAuth scopes list.
          </p>
          <ul className="space-y-1.5">
            {failing.map((r) => (
              <li
                key={r.scope}
                className="rounded border border-red-200 dark:border-red-900/50 bg-white dark:bg-red-950/20 px-2 py-1.5"
              >
                <div className="flex items-start gap-1.5">
                  <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-red-900 dark:text-red-300">
                      {r.label}
                    </p>
                    <code className="font-mono text-[10px] text-red-700 dark:text-red-400 break-all block">
                      {r.scope}
                    </code>
                    <p className="text-muted-foreground mt-0.5">{r.feature}</p>
                    {r.error && (
                      <p className="text-red-700 dark:text-red-400 mt-1 break-words">
                        <span className="font-medium">Google said:</span>{" "}
                        {r.error}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {passing.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ChevronDown className="h-3 w-3" />
            {passing.length} authorized scope
            {passing.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1.5 space-y-1 pl-4">
            {passing.map((r) => (
              <li key={r.scope} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                <span className="font-mono text-[10px] break-all">
                  {r.scope}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={onRetry}
        className="h-7 text-xs mt-2"
      >
        Re-check
      </Button>
    </div>
  );
}
