"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
]);

const READ_ONLY_ACTIONS = new Set([
  "email_delegation_list",
  "calendar_delegation_list",
]);

export function AICommandPanel() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [command, setCommand] = useState("");
  const [parsed, setParsed] = useState<ParsedAction | null>(null);
  const [parsing, setParsing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const parseCommand = async () => {
    if (!command.trim()) return;
    setParsing(true);
    setParsed(null);
    setMessage(null);

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

  const isDestructive = !!parsed && DESTRUCTIVE_ACTIONS.has(parsed.action);
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
        setMessage({
          type: "success",
          text: `Done! ${parsed.explanation}`,
        });
        setParsed(null);
        setCommand("");
        setConfirmOpen(false);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Action failed",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to execute action" });
    } finally {
      setExecuting(false);
    }
  };

  const confidenceColor =
    parsed && parsed.confidence >= 0.8
      ? "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/50"
      : parsed && parsed.confidence >= 0.5
        ? "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/50"
        : "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50";

  return (
    <>
      {message && (
        <Alert
          className={`mb-4 ${
            message.type === "error"
              ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40"
              : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-500" />
            AI Command
            <Badge variant="outline" className="ml-1 text-xs">
              Gemini
            </Badge>
          </CardTitle>
          <CardDescription>
            Type what you want in plain English — the AI handles the rest.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder={`e.g. "Give sarah@company.com access to john@company.com's mailbox"`}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && parseCommand()}
              className="text-base"
            />
            <Button onClick={parseCommand} disabled={!command.trim() || parsing}>
              {parsing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              "Delegate jane@co.com's email to mike@co.com",
              "Share alice@co.com's calendar with bob@co.com as editor",
              "Who has access to ceo@co.com's calendar?",
            ].map((example) => (
              <button
                key={example}
                onClick={() => setCommand(example)}
                className="text-xs px-2.5 py-1.5 rounded-full border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                {example}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {parsed && (
        <Card className="mt-4 ring-primary/25">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Parsed Action</CardTitle>
              <Badge variant="outline" className={confidenceColor}>
                {Math.round(parsed.confidence * 100)}% confident
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-4 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2">
                <Badge className="bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900/50">
                  {parsed.actionDetails?.name || parsed.action}
                </Badge>
              </div>
              <p className="text-sm">{parsed.explanation}</p>

              <Separator />

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Parameters
                </p>
                {Object.entries(parsed.params).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-muted-foreground min-w-[120px]">
                      {key}:
                    </span>
                    <code className="bg-muted px-2 py-0.5 rounded text-sm">
                      {value}
                    </code>
                  </div>
                ))}
              </div>
            </div>

            {!parsed.validParams && (
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <XCircle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                  Parameters didn&apos;t pass validation: {parsed.validationError ?? "unknown error"}.
                  Refusing to execute. Rephrase your command and try again.
                </AlertDescription>
              </Alert>
            )}

            {isDestructive && (
              <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
                  This is a destructive action ({parsed.action}). Run it from
                  its dedicated page so you get the proper typed-confirmation
                  safeguards.
                </AlertDescription>
              </Alert>
            )}

            {parsed.validParams && parsed.confidence < 0.7 && !isDestructive && (
              <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
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
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
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
