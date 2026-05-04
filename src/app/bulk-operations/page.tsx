"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import {
  Layers,
  Loader2,
  Sparkles,
  Play,
  CheckCircle2,
  XCircle,
  Circle,
  AlertTriangle,
} from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

interface BulkOperation {
  action: string;
  actionName?: string;
  params: Record<string, string>;
  description: string;
  endpoint?: string;
  method?: string;
  knownAction: boolean;
  validParams: boolean;
  validationError: string | null;
}

type OpStatus = "pending" | "running" | "success" | "error" | "skipped";

interface OpResult {
  status: OpStatus;
  message?: string;
}

const DESTRUCTIVE_ACTIONS = new Set([
  "domain_change",
  "calendar_transfer",
  "email_transfer",
  "email_delegation_remove",
  "calendar_delegation_remove",
]);

export default function BulkOperations() {
  const [text, setText] = useState("");
  const [operations, setOperations] = useState<BulkOperation[]>([]);
  const [summary, setSummary] = useState("");
  const [parsing, setParsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<number, OpResult>>({});
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const parseText = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setOperations([]);
    setResults({});
    setMessage(null);
    setSummary("");
    setConfirm("");

    try {
      const res = await tfetch("/api/ai/bulk-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const result = await res.json();

      if (result.success) {
        setOperations(result.data.operations);
        setSummary(result.data.summary);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to parse",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setParsing(false);
    }
  };

  const runnableOps = operations.filter(
    (op) =>
      op.knownAction &&
      op.validParams &&
      !DESTRUCTIVE_ACTIONS.has(op.action) &&
      !!op.endpoint &&
      !!op.method
  );
  const destructiveCount = operations.filter((op) =>
    DESTRUCTIVE_ACTIONS.has(op.action)
  ).length;
  const invalidCount = operations.filter(
    (op) => !op.knownAction || !op.validParams
  ).length;

  const runAll = async () => {
    if (confirm !== `RUN ${runnableOps.length}`) {
      setMessage({
        type: "error",
        text: `Type "RUN ${runnableOps.length}" exactly to confirm running these operations.`,
      });
      return;
    }
    setRunning(true);
    setMessage(null);
    const newResults: Record<number, OpResult> = {};

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op.knownAction) {
        newResults[i] = { status: "skipped", message: "Unknown action — skipped" };
        setResults({ ...newResults });
        continue;
      }
      if (!op.validParams) {
        newResults[i] = {
          status: "skipped",
          message: `Invalid params — skipped (${op.validationError ?? "validation failed"})`,
        };
        setResults({ ...newResults });
        continue;
      }
      if (DESTRUCTIVE_ACTIONS.has(op.action)) {
        newResults[i] = {
          status: "skipped",
          message:
            "Destructive action — skipped. Run it from the dedicated page where typed confirmation is required.",
        };
        setResults({ ...newResults });
        continue;
      }
      if (!op.endpoint || !op.method) {
        newResults[i] = { status: "error", message: "Unknown endpoint" };
        setResults({ ...newResults });
        continue;
      }

      newResults[i] = { status: "running" };
      setResults({ ...newResults });

      try {
        const fetchOptions: RequestInit = {
          method: op.method,
          headers: { "Content-Type": "application/json" },
        };
        let url = op.endpoint;
        if (op.method === "GET") {
          const params = new URLSearchParams(op.params);
          url = `${op.endpoint}?${params.toString()}`;
        } else {
          fetchOptions.body = JSON.stringify(op.params);
        }
        const res = await tfetch(url, fetchOptions);
        const result = await res.json();
        newResults[i] = {
          status: result.success ? "success" : "error",
          message: result.success
            ? "Completed"
            : result.error || "Failed",
        };
      } catch {
        newResults[i] = { status: "error", message: "Request failed" };
      }
      setResults({ ...newResults });
    }

    const successCount = Object.values(newResults).filter(
      (r) => r.status === "success"
    ).length;
    const errorCount = Object.values(newResults).filter(
      (r) => r.status === "error"
    ).length;
    const skipped = Object.values(newResults).filter(
      (r) => r.status === "skipped"
    ).length;

    setMessage({
      type: errorCount === 0 ? "success" : "error",
      text: `Finished: ${successCount} succeeded, ${errorCount} failed, ${skipped} skipped out of ${operations.length} operations.`,
    });
    setRunning(false);
    setConfirm("");
  };

  const statusIcon = (status: OpStatus) => {
    switch (status) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "running":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      case "skipped":
        return <AlertTriangle className="h-4 w-4 text-amber-500" />;
      default:
        return <Circle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <>
      <PageHeader
        title="Bulk Operations"
        description="Paste a list of tasks in plain text. The AI breaks it down and runs the safe ones. Destructive operations are skipped — run those from their own pages."
        badge="Gemini"
      />

      {message && (
        <Alert
          className={`mb-6 ${
            message.type === "error"
              ? "border-red-200 bg-red-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800" : "text-emerald-800"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Paste Your Tasks
            </CardTitle>
            <CardDescription>
              Write out everything you need done. One task per line, or however
              you want — the AI will figure it out.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              placeholder={`Example:\nDelegate alex@company.com's email to manager@company.com\nDelegate jordan@company.com's email to manager@company.com\nShare alex@company.com's calendar with manager@company.com as editor`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              className="font-mono text-sm"
            />
            <Button
              className="w-full"
              onClick={parseText}
              disabled={!text.trim() || parsing}
            >
              {parsing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Parse Operations
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-lg">
                  Operations{" "}
                  {operations.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {operations.length}
                    </Badge>
                  )}
                </CardTitle>
                {summary && (
                  <CardDescription className="mt-1">{summary}</CardDescription>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {operations.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                Paste your tasks on the left and hit &quot;Parse
                Operations&quot; to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {(invalidCount > 0 || destructiveCount > 0) && (
                  <Alert className="border-amber-200 bg-amber-50">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription className="text-amber-800 text-xs">
                      {invalidCount > 0 && (
                        <p>
                          {invalidCount} operation{invalidCount === 1 ? "" : "s"} failed
                          validation and will be skipped.
                        </p>
                      )}
                      {destructiveCount > 0 && (
                        <p>
                          {destructiveCount} destructive operation
                          {destructiveCount === 1 ? "" : "s"} (transfers, domain
                          change, removes) will be skipped — run them from their
                          dedicated pages.
                        </p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  {operations.map((op, i) => {
                    const isDestructive = DESTRUCTIVE_ACTIONS.has(op.action);
                    const status: OpStatus =
                      results[i]?.status ??
                      (!op.knownAction || !op.validParams || isDestructive
                        ? "skipped"
                        : "pending");
                    return (
                      <div key={i}>
                        <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
                          <div className="mt-0.5">{statusIcon(status)}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <Badge
                                variant="outline"
                                className="text-xs shrink-0"
                              >
                                {op.actionName || op.action}
                              </Badge>
                              {isDestructive && (
                                <Badge
                                  variant="outline"
                                  className="text-xs bg-amber-50 text-amber-700 border-amber-200"
                                >
                                  destructive — skipped
                                </Badge>
                              )}
                              {!op.validParams && (
                                <Badge
                                  variant="outline"
                                  className="text-xs bg-red-50 text-red-700 border-red-200"
                                >
                                  invalid params
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm">{op.description}</p>
                            {op.validationError && (
                              <p className="text-xs mt-1 text-red-600">
                                {op.validationError}
                              </p>
                            )}
                            {results[i]?.message && (
                              <p
                                className={`text-xs mt-1 ${
                                  results[i].status === "error"
                                    ? "text-red-600"
                                    : results[i].status === "skipped"
                                      ? "text-amber-700"
                                      : "text-emerald-600"
                                }`}
                              >
                                {results[i].message}
                              </p>
                            )}
                          </div>
                        </div>
                        {i < operations.length - 1 && (
                          <Separator className="my-1 opacity-0" />
                        )}
                      </div>
                    );
                  })}
                </div>

                {runnableOps.length > 0 && !running && (
                  <div className="space-y-2 pt-2 border-t">
                    <p className="text-xs text-muted-foreground">
                      Type <code className="bg-muted px-1 rounded">RUN {runnableOps.length}</code> to confirm running {runnableOps.length} operation{runnableOps.length === 1 ? "" : "s"}.
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder={`RUN ${runnableOps.length}`}
                        className="flex-1 h-9 px-3 rounded-md border bg-background text-sm font-mono"
                      />
                      <Button
                        size="sm"
                        onClick={runAll}
                        disabled={confirm !== `RUN ${runnableOps.length}`}
                      >
                        <Play className="mr-1 h-3.5 w-3.5" />
                        Run
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
