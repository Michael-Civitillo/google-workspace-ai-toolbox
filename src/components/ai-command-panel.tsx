"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sparkles,
  Loader2,
  ArrowRight,
  AlertTriangle,
  Play,
  XCircle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { FeedbackAlert } from "@/components/feedback-alert";

interface ParsedAction {
  action: string;
  params: Record<string, string>;
  confidence: number;
  explanation: string;
  validParams: boolean;
  validationError: string | null;
  actionDetails: {
    name: string;
    endpoint: string;
    method: string;
  } | null;
}

const DESTRUCTIVE_ACTIONS = new Set([
  "domain_change",
  "calendar_transfer",
  "email_transfer",
  "email_delegation_remove",
  "calendar_delegation_remove",
  "group_member_remove",
]);

const READ_ONLY_ACTIONS = new Set([
  "email_delegation_list",
  "calendar_delegation_list",
  "group_members_list",
]);

export function AICommandPanel() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [command, setCommand] = useState("");
  const [parsed, setParsed] = useState<ParsedAction | null>(null);
  const [parsing, setParsing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Result payload from a read-only "list" action, rendered below the panel so
  // the answer isn't silently discarded (e.g. "Who has access to …").
  const [readResult, setReadResult] = useState<unknown>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // A parsed action is tenant-scoped context: it was parsed and reviewed
  // while one tenant was selected, and executing it after a sidebar switch
  // would silently fire against a different tenant (the read-only path runs
  // with no dialog and shows no tenant at all). Invalidate it on switch.
  useEffect(() => {
    setParsed(null);
    setConfirmOpen(false);
    setReadResult(null);
  }, [tenantId]);

  const parseCommand = async () => {
    if (!command.trim()) return;
    setParsing(true);
    setParsed(null);
    setMessage(null);
    setReadResult(null);

    try {
      const res = await tfetch("/api/ai/parse-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const result = await res.json();

      if (result.success) {
        setParsed(result.data);
      } else {
        setMessage({ type: "error", text: result.error || "Failed to parse" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setParsing(false);
    }
  };

  const isDestructive =
    !!parsed &&
    (DESTRUCTIVE_ACTIONS.has(parsed.action) ||
      // Owner-level calendar delegation is the same grant a calendar transfer
      // performs — full control, re-sharing, deletion. The dedicated page's
      // high-severity typed confirmation must not be bypassable simply by
      // phrasing the command as a delegation instead of a transfer.
      (parsed.action === "calendar_delegation_add" &&
        parsed.params?.role === "owner"));
  const canRun =
    !!parsed && parsed.validParams && !!parsed.actionDetails && !isDestructive;

  const executeAction = async () => {
    if (!parsed?.actionDetails || !parsed.validParams) return;
    if (isDestructive) return;
    setExecuting(true);
    setMessage(null);

    try {
      const { endpoint, method } = parsed.actionDetails;
      const fetchOptions: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      let url = endpoint;
      if (method === "GET") {
        const params = new URLSearchParams(parsed.params);
        url = `${endpoint}?${params.toString()}`;
      } else {
        fetchOptions.body = JSON.stringify(parsed.params);
      }

      const res = await tfetch(url, fetchOptions, tenantId);
      const result = await res.json();

      if (result.success) {
        const isRead = READ_ONLY_ACTIONS.has(parsed.action);
        if (isRead) {
          // Surface the actual answer (delegates / ACL list) instead of just a
          // "Done!" toast with the data thrown away.
          setReadResult(result.data ?? null);
          setMessage({ type: "success", text: parsed.explanation });
        } else {
          setMessage({ type: "success", text: `Done! ${parsed.explanation}` });
          setReadResult(null);
        }
        setParsed(null);
        setCommand("");
        setConfirmOpen(false);
      } else {
        // Close the dialog so the error banner isn't hidden behind the
        // modal overlay.
        setConfirmOpen(false);
        setMessage({
          type: "error",
          text: result.error || "Action failed",
        });
      }
    } catch {
      setConfirmOpen(false);
      setMessage({ type: "error", text: "Failed to execute action" });
    } finally {
      setExecuting(false);
    }
  };

  const confidenceVariant: "success" | "warning" | "destructive" =
    parsed && parsed.confidence >= 0.8
      ? "success"
      : parsed && parsed.confidence >= 0.5
        ? "warning"
        : "destructive";

  return (
    <>
      <FeedbackAlert message={message} className="mb-4" />

      {readResult !== null && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs break-words whitespace-pre-wrap">
              {JSON.stringify(readResult, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Prompt bar: the one place the RGB ring is always allowed to shine. */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold tracking-tight">AI Command</h2>
          <Badge variant="outline">Gemini</Badge>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
            Plain English in, a reviewed action out.
          </span>
        </div>

        <div className="rgb-ring rgb-ring-focus rounded-xl border border-border bg-card shadow-xs transition-colors focus-within:border-transparent">
          <div className="flex items-center gap-2 p-2 pl-4">
            <input
              aria-label="AI command"
              placeholder={`Type what you need — e.g. "Give sarah@company.com access to john@company.com's mailbox"`}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !parsing && parseCommand()}
              className="h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/60"
            />
            <Button
              onClick={parseCommand}
              disabled={!command.trim() || parsing}
              className="shrink-0"
            >
              {parsing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  <span className="hidden sm:inline">Run</span>
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {[
            "Delegate jane@co.com's email to mike@co.com",
            "Share alice@co.com's calendar with bob@co.com as editor",
            "Who has access to ceo@co.com's calendar?",
          ].map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setCommand(example)}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {parsed && (
        <Card className="mt-4 border-primary/30">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Parsed action</CardTitle>
              <Badge variant={confidenceVariant}>
                {Math.round(parsed.confidence * 100)}% confident
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex items-center gap-2">
                <Badge variant="accent">
                  {parsed.actionDetails?.name || parsed.action}
                </Badge>
              </div>
              <p className="text-sm">{parsed.explanation}</p>

              <Separator />

              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  Parameters
                </p>
                {Object.entries(parsed.params).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 text-sm">
                    <span className="min-w-[120px] font-medium text-muted-foreground">
                      {key}
                    </span>
                    <code className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[13px]">
                      {value}
                    </code>
                  </div>
                ))}
              </div>
            </div>

            {!parsed.validParams && (
              <Alert variant="destructive">
                <XCircle />
                <AlertDescription>
                  Parameters didn&apos;t pass validation: {parsed.validationError ?? "unknown error"}.
                  Refusing to execute. Rephrase your command and try again.
                </AlertDescription>
              </Alert>
            )}

            {isDestructive && (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>
                  This is a destructive action ({parsed.action}). Run it from
                  its dedicated page so you get the proper typed-confirmation
                  safeguards.
                </AlertDescription>
              </Alert>
            )}

            {parsed.validParams && parsed.confidence < 0.7 && !isDestructive && (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>
                  The AI isn&apos;t very confident about this interpretation.
                  Double-check the parameters before running.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex gap-3">
              <Button
                className="flex-1"
                size="lg"
                onClick={() => {
                  if (parsed && READ_ONLY_ACTIONS.has(parsed.action)) {
                    void executeAction();
                  } else {
                    setConfirmOpen(true);
                  }
                }}
                disabled={executing || !canRun}
              >
                {executing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {parsed && READ_ONLY_ACTIONS.has(parsed.action)
                  ? "Run It"
                  : "Review & Run"}
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => setParsed(null)}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {parsed && parsed.actionDetails && parsed.validParams && !isDestructive && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => !executing && setConfirmOpen(o)}
          title={`Run: ${parsed.actionDetails.name}`}
          summary={parsed.explanation}
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity={parsed.confidence < 0.7 ? "high" : "medium"}
          confirmPhrase={parsed.confidence < 0.7 ? "RUN" : undefined}
          confirmLabel="Run action"
          busy={executing}
          changes={[
            { label: "Action", after: parsed.actionDetails.name },
            ...Object.entries(parsed.params).map(([k, v]) => ({
              label: k,
              after: String(v),
            })),
            {
              label: "AI confidence",
              after: `${Math.round(parsed.confidence * 100)}%`,
              emphasis: parsed.confidence < 0.7,
            },
          ]}
          warnings={
            parsed.confidence < 0.7 ? (
              <>
                The AI&apos;s confidence is low. Re-read every parameter before
                confirming — a misparsed value could grant access to the wrong
                user.
              </>
            ) : null
          }
          onConfirm={executeAction}
        />
      )}
    </>
  );
}
