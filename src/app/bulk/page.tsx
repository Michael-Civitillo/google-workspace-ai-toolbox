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
import { isValidEmail } from "@/lib/validate-email";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

type OperationId = "delegation_add" | "delegation_remove" | "set_forwarding";

interface OperationDef {
  label: string;
  endpoint: string;
  method: "POST" | "DELETE";
  columns: [string, string, ...string[]];
  hint: string;
  /** Map a parsed row's cells to the request body. */
  toBody: (cells: string[]) => Record<string, string>;
  /** Row-level validation beyond the two-emails baseline; returns an error or null. */
  validateRow: (cells: string[]) => string | null;
}

const FORWARD_ACTIONS = new Set(["keep", "archive", "trash", "markRead"]);

const OPERATIONS: Record<OperationId, OperationDef> = {
  delegation_add: {
    label: "Add email delegate",
    endpoint: "/api/gws/email-delegation",
    method: "POST",
    columns: ["user", "delegate"],
    hint: "One row per grant: the mailbox owner, then the delegate to add.",
    toBody: (c) => ({ user: c[0], delegate: c[1] }),
    validateRow: (c) => baselineEmails(c, "user", "delegate"),
  },
  delegation_remove: {
    label: "Remove email delegate",
    endpoint: "/api/gws/email-delegation",
    method: "DELETE",
    columns: ["user", "delegate"],
    hint: "One row per removal: the mailbox owner, then the delegate to remove.",
    toBody: (c) => ({ user: c[0], delegate: c[1] }),
    validateRow: (c) => baselineEmails(c, "user", "delegate"),
  },
  set_forwarding: {
    label: "Set up email forwarding",
    endpoint: "/api/gws/email-transfer",
    method: "POST",
    columns: ["sourceUser", "targetUser", "action (optional)"],
    hint: "One row per mailbox: source, forward-to target, and optionally what happens to originals (keep, archive, trash, markRead — defaults to keep).",
    toBody: (c) => ({
      sourceUser: c[0],
      targetUser: c[1],
      action: c[2] || "keep",
    }),
    validateRow: (c) => {
      const base = baselineEmails(c, "sourceUser", "targetUser");
      if (base) return base;
      if (c[2] && !FORWARD_ACTIONS.has(c[2])) {
        return `action must be one of: ${[...FORWARD_ACTIONS].join(", ")}`;
      }
      return null;
    },
  },
};

function baselineEmails(
  cells: string[],
  firstName: string,
  secondName: string
): string | null {
  if (cells.length < 2 || !cells[0] || !cells[1]) {
    return `needs two columns: ${firstName}, ${secondName}`;
  }
  if (!isValidEmail(cells[0])) return `${firstName} is not a valid email`;
  if (!isValidEmail(cells[1])) return `${secondName} is not a valid email`;
  if (cells[0].toLowerCase() === cells[1].toLowerCase()) {
    return `${firstName} and ${secondName} must be different`;
  }
  return null;
}

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Minimal RFC 4180-style CSV parser: quoted cells, doubled quotes as escapes,
 * commas inside quotes, and CR/LF/CRLF row endings. Unquoted cells are
 * trimmed; fully empty rows are dropped.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;

  const endCell = () => {
    row.push(cellWasQuoted ? cell : cell.trim());
    cell = "";
    cellWasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cellWasQuoted = true;
      cell = "";
      continue;
    }
    if (ch === ",") {
      endCell();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

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
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
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
    setRows(
      parsed.map((cells, index) => {
        const error = def.validateRow(cells);
        return {
          index,
          cells,
          status: error ? ("invalid" as const) : ("pending" as const),
          ...(error ? { error } : {}),
        };
      })
    );
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
        return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
      case "error":
      case "invalid":
        return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
      case "running":
        return (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
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

      {message && (
        <Alert
          className={`mb-6 ${message.type === "error" ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40" : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"}`}
        >
          <AlertDescription
            className={
              message.type === "error"
                ? "text-red-800 dark:text-red-300"
                : "text-emerald-800 dark:text-emerald-300"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
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
              <Select value={operation} onValueChange={changeOperation}>
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
                placeholder={`${op.columns.map((c) => c.split(" ")[0]).join(",")}\nalice@yourdomain.com,bob@yourdomain.com`}
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  buildPreview(e.target.value, operation);
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
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <AlertDescription className="text-red-800 dark:text-red-300">
                  {parseError}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {rows.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Preview & Run</CardTitle>
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
                    className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-muted/30"
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
                        className="ml-auto shrink-0 border-red-300 dark:border-red-800 text-red-700 dark:text-red-400"
                      >
                        invalid
                      </Badge>
                    )}
                    {r.error && (
                      <span className="ml-auto text-xs text-red-600 dark:text-red-400 truncate max-w-[40%]">
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
        confirmPhrase={`RUN ${validCount}`}
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
        warnings={
          operation === "set_forwarding" ? (
            <>
              Rows that forward to an address outside this tenant&apos;s
              verified domains are rejected by the server (they need the
              dedicated Email Transfer page&apos;s external confirmation) and
              will show as failed.
            </>
          ) : undefined
        }
        onConfirm={run}
      />
    </>
  );
}
