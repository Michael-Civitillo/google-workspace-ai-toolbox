"use client";

import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import {
  Layers,
  Loader2,
  Upload,
  Play,
  Download,
  X,
  CheckCircle2,
  XCircle,
  Circle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import {
  confirmPhraseFor,
  duplicateRows,
  OPERATIONS,
  parseCsv,
  type OperationDef,
  type OperationId,
} from "@/lib/bulk-operations";

/** What the operation picker shows for each choice once it is picked. */
const OPERATION_LABELS = Object.fromEntries(
  Object.entries(OPERATIONS).map(([id, def]) => [id, def.label])
);

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 1024 * 1024;

type RowStatus = "invalid" | "pending" | "running" | "success" | "error";

interface BulkRow {
  index: number;
  cells: string[];
  status: RowStatus;
  error?: string;
}

function csvCell(c: string): string {
  let v = c;
  // Guard against spreadsheet formula injection when the export is opened
  // in Excel/Sheets: prefix risky leading characters with a quote.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BulkOperations() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [operation, setOperation] = useState<OperationId>("delegation_add");
  const [csvText, setCsvText] = useState("");
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Pending debounced preview rebuild (see schedulePreview).
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, []);

  // A preview built under tenant A must not be runnable against tenant B.
  useEffect(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setRows([]);
    setRan(false);
    setParseError(null);
  }, [tenantId]);

  const op = OPERATIONS[operation];

  const buildPreview = (text: string, opId: OperationId) => {
    // An immediate rebuild supersedes any debounced one still pending.
    if (previewTimer.current) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    const def = OPERATIONS[opId];
    setParseError(null);
    setRan(false);
    setMessage(null);
    if (!text.trim()) {
      setRows([]);
      return;
    }
    let parsed = parseCsv(text);
    // Tolerate a header row: drop row 0 if its first cell names the first column.
    if (
      parsed.length > 0 &&
      parsed[0][0]?.toLowerCase() === def.columns[0].toLowerCase()
    ) {
      parsed = parsed.slice(1);
    }
    if (parsed.length === 0) {
      setRows([]);
      setParseError("No data rows found");
      return;
    }
    if (parsed.length > MAX_ROWS) {
      setRows([]);
      setParseError(
        `Too many rows (${parsed.length.toLocaleString()}). The limit is ${MAX_ROWS} per run — split the file and run in batches.`
      );
      return;
    }
    const repeats = duplicateRows(parsed, def);
    setRows(
      parsed.map((cells, index) => {
        const error =
          def.validateRow(cells) ??
          (repeats.has(index) ? "same as an earlier row" : null);
        return {
          index,
          cells,
          status: error ? ("invalid" as const) : ("pending" as const),
          ...(error ? { error } : {}),
        };
      })
    );
  };

  // Typing in the textarea re-parses and re-validates the whole input; on a
  // large paste (up to 1 MB / 500 rows) doing that on every keystroke made
  // typing stutter. Debounce it briefly — file picks and operation changes
  // still rebuild immediately.
  const schedulePreview = (text: string, opId: OperationId) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      buildPreview(text, opId);
    }, 150);
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setParseError(
        `File is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the limit is 1 MB (that's far past the ${MAX_ROWS}-row cap anyway).`
      );
      return;
    }
    const text = await file.text();
    setCsvText(text);
    buildPreview(text, operation);
  };

  const changeOperation = (v: OperationId | null) => {
    // Switching operations rebuilds `rows`, but an active run keeps writing
    // per-row statuses into it by index — the old run's results would land on
    // the new operation's rows. Freeze the selector until the run finishes.
    if (running) return;
    if (!v || !(v in OPERATIONS)) return;
    setOperation(v);
    // Re-validate the existing input against the new operation's rules.
    buildPreview(csvText, v);
  };

  const validCount = rows.filter((r) => r.status === "pending").length;
  const invalidCount = rows.filter((r) => r.status === "invalid").length;
  const successCount = rows.filter((r) => r.status === "success").length;
  const errorCount = rows.filter((r) => r.status === "error").length;

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setMessage(null);
    cancelRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    // Snapshot what this run operates on: the rows, the operation, and the
    // tenant. Edits or switches mid-run must not retarget in-flight work.
    const pinnedTenantId = tenantId;
    const def = op;
    const snapshot = rows;

    try {
      for (let i = 0; i < snapshot.length; i++) {
        const row = snapshot[i];
        if (row.status !== "pending") continue;
        if (cancelRef.current) break;

        setRows((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status: "running" } : r))
        );
        let status: RowStatus = "error";
        let error: string | undefined;
        try {
          const res = await tfetch(
            def.endpoint,
            {
              method: def.method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(def.toBody(row.cells)),
              signal: ac.signal,
            },
            pinnedTenantId
          );
          const result = await res.json();
          if (result.success) {
            status = "success";
          } else {
            error = result.error || `HTTP ${res.status}`;
          }
        } catch {
          if (ac.signal.aborted) {
            // Roll the row back to pending — it never ran.
            setRows((prev) =>
              prev.map((r, idx) =>
                idx === i ? { ...r, status: "pending" } : r
              )
            );
            break;
          }
          error = "Failed to connect to the API";
        }
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status, ...(error ? { error } : {}) } : r
          )
        );
      }
      setRan(true);
    } finally {
      setRunning(false);
    }
  };

  const cancelRun = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const exportResults = () => {
    const header = [...op.columns.map((c) => c.split(" ")[0]), "status", "error"];
    const lines = rows.map((r) =>
      [...op.columns.map((_, ci) => r.cells[ci] ?? ""), r.status, r.error ?? ""]
        .map((c) => `"${csvCell(String(c))}"`)
        .join(",")
    );
    downloadCsv(
      `bulk-${operation}-${new Date().toISOString().slice(0, 10)}.csv`,
      [header.map((c) => `"${csvCell(c)}"`).join(","), ...lines].join("\n")
    );
  };

  const statusIcon = (s: RowStatus) => {
    switch (s) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-success shrink-0" />;
      case "error":
      case "invalid":
        return <XCircle className="h-4 w-4 text-danger shrink-0" />;
      case "running":
        return (
          <Loader2 className="h-4 w-4 animate-spin text-info shrink-0" />
        );
      default:
        return <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />;
    }
  };

  return (
    <>
      <PageHeader
        title="Bulk Operations"
        description="Paste or upload a CSV and run one operation across many users — with per-row validation before anything fires, and per-row results after."
        badge="CSV"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Operation & Input
            </CardTitle>
            <CardDescription>
              Each row calls the same API the dedicated page uses, so every row
              is validated server-side and lands in the audit log individually.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 max-w-md">
              <Label>Operation</Label>
              <Select
                value={operation}
                onValueChange={changeOperation}
                items={OPERATION_LABELS}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Bulk operation"
                  disabled={running}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(OPERATIONS) as [OperationId, OperationDef][]
                  ).map(([id, def]) => (
                    <SelectItem key={id} value={id}>
                      {def.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Columns: <code>{op.columns.join(", ")}</code>. {op.hint}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="csv-input">CSV rows</Label>
              <Textarea
                id="csv-input"
                rows={6}
                placeholder={`${op.columns.map((c) => c.split(" ")[0]).join(",")}\n${op.example}`}
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  schedulePreview(e.target.value, operation);
                }}
                disabled={running}
                className="font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    void onPickFile(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={running}
                >
                  <Upload className="h-4 w-4" />
                  Upload CSV file
                </Button>
                <p className="text-xs text-muted-foreground">
                  Up to {MAX_ROWS} rows per run. A header row is skipped
                  automatically.
                </p>
              </div>
            </div>

            {parseError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {parseError}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {rows.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Preview & Run</CardTitle>
              <CardDescription>
                {ran || running
                  ? `${successCount} succeeded · ${errorCount} failed · ${invalidCount} skipped (invalid)`
                  : `${validCount} row${validCount === 1 ? "" : "s"} ready to run · ${invalidCount} invalid (will be skipped)`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setMessage(null);
                    setConfirmOpen(true);
                  }}
                  disabled={validCount === 0 || running}
                >
                  {running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Run {validCount} row{validCount === 1 ? "" : "s"}
                </Button>
                {running && (
                  <Button variant="outline" onClick={cancelRun}>
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                )}
                {(ran || errorCount > 0) && (
                  <Button variant="secondary" onClick={exportResults}>
                    <Download className="h-4 w-4" />
                    Export results CSV
                  </Button>
                )}
              </div>

              <div className="space-y-1.5">
                {rows.map((r) => (
                  <div
                    key={r.index}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-lg border bg-muted/30"
                  >
                    {statusIcon(r.status)}
                    <span className="text-xs text-muted-foreground w-8 shrink-0">
                      {r.index + 1}
                    </span>
                    <span className="text-sm font-mono truncate">
                      {r.cells.join(", ")}
                    </span>
                    {r.status === "invalid" && (
                      <Badge
                        variant="outline"
                        className="ml-auto shrink-0 border-danger/40 text-danger-fg"
                      >
                        invalid
                      </Badge>
                    )}
                    {r.error && (
                      // On its own line, in full: a cut-off reason is no reason.
                      <span className="basis-full pl-[3.25rem] text-xs text-danger break-words">
                        {r.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={(o) => !running && setConfirmOpen(o)}
        title="Run bulk operation"
        summary={`Run "${op.label}" across ${validCount} row${validCount === 1 ? "" : "s"}. Rows execute one at a time and can be cancelled mid-run.`}
        tenant={
          tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
        }
        severity="high"
        confirmPhrase={confirmPhraseFor(op, validCount)}
        confirmLabel="Start run"
        busy={running}
        changes={[
          { label: "Operation", after: op.label },
          {
            label: "Rows to run",
            after: String(validCount),
            emphasis: true,
          },
          { label: "Rows skipped (invalid)", after: String(invalidCount) },
        ]}
        warnings={op.warning}
        onConfirm={run}
      />
    </>
  );
}
