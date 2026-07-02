"use client";

import { ReactNode, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DiffRow {
  /** Short label for what is changing (e.g. "Primary email"). */
  label: string;
  /** Current state ("before"). Optional for purely additive actions. */
  before?: string | null;
  /** Resulting state ("after"). */
  after: string;
  /**
   * If set, this row is highlighted as the most important / scariest change in
   * the dialog (e.g. an irreversible primary email swap, owner grant, etc.).
   */
  emphasis?: boolean;
}

export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short verb-led title, e.g. "Change primary email". */
  title: string;
  /** One-sentence summary of the action. */
  summary: string;
  /** Tenant the action will run against — surfaced prominently. */
  tenant: { name: string; adminEmail: string } | null;
  /** Concrete list of changes the server will make. */
  changes: DiffRow[];
  /** Free-form warnings rendered as a callout. */
  warnings?: ReactNode;
  /**
   * Severity. "high" forces a typed-confirmation phrase before the confirm
   * button is enabled. "medium" requires a single click of "Yes, do it".
   */
  severity: "medium" | "high";
  /**
   * For severity="high": the exact phrase the user must type. The dialog will
   * surface this as a code block and disable confirm until it matches exactly.
   * Pick something that's easy to read and doesn't look like a generic OK,
   * e.g. the user's email or "DELETE alice@co.com".
   */
  confirmPhrase?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Centralised confirmation dialog for any destructive Workspace action.
 *
 * Three jobs:
 *   1. Show, in plain language, the tenant + the exact before/after state of
 *      every field this action will mutate. No surprises.
 *   2. Make accidental clicks impossible. High-severity actions require typing
 *      a specific phrase that matches the entity being acted on, so a
 *      pre-filled cancel-button-keyboard-shortcut user can't blow through it.
 *   3. Block the user out of the dialog while the request is in-flight, so
 *      they can't fire the same destructive action twice while waiting.
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  summary,
  tenant,
  changes,
  warnings,
  severity,
  confirmPhrase,
  confirmLabel,
  busy,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  // Reset the typed phrase whenever the dialog transitions to open. handleOpenChange
  // only fires on user-initiated closes (Cancel/Esc/backdrop); a parent that closes
  // the dialog programmatically after success just flips the `open` prop, so without
  // this the phrase persists and the NEXT destructive action (e.g. a bulk revoke
  // whose phrase is the constant "REVOKE") would open already-armed and be
  // confirmable in a single click. Done during render — React's "adjust state on
  // prop change" pattern — rather than in an effect.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) setTyped("");
    onOpenChange(next);
  }

  const phraseRequired = severity === "high" && !!confirmPhrase;
  const phraseOk =
    !phraseRequired || typed.trim() === (confirmPhrase ?? "");
  const canConfirm = phraseOk && !busy;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {severity === "high" ? (
              <ShieldAlert className="h-4 w-4 text-red-600 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {tenant && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border bg-muted/50">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Running against
                </p>
                <p className="font-medium">{tenant.name}</p>
                <p className="text-xs text-muted-foreground">
                  impersonating {tenant.adminEmail}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              What will change
            </p>
            <ul className="space-y-1.5">
              {changes.map((row, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    row.emphasis
                      ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40"
                      : "bg-background"
                  )}
                >
                  <p className="font-medium text-foreground">{row.label}</p>
                  {row.before !== undefined && row.before !== null && (
                    <p className="text-muted-foreground">
                      <span className="opacity-60">from</span>{" "}
                      <code className="font-mono">{row.before}</code>
                    </p>
                  )}
                  <p className={row.emphasis ? "text-red-800 dark:text-red-300" : ""}>
                    <span className="opacity-60">to</span>{" "}
                    <code className="font-mono">{row.after}</code>
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {warnings && (
            <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-3 text-xs text-amber-800 dark:text-amber-300">
              {warnings}
            </div>
          )}

          {phraseRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-phrase" className="text-xs">
                Type{" "}
                <code className="bg-muted px-1 py-0.5 rounded font-mono">
                  {confirmPhrase}
                </code>{" "}
                to confirm
              </Label>
              <Input
                id="confirm-phrase"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={confirmPhrase}
                className="font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant={severity === "high" ? "destructive" : "default"}
            onClick={() => {
              if (!canConfirm) return;
              void onConfirm();
            }}
            disabled={!canConfirm}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            {confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
