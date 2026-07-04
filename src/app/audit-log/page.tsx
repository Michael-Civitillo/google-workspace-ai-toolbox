"use client";

import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { ScrollText, Loader2, Search, Download, X } from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

interface AuditLogEntry {
  ts?: string;
  action?: string;
  tenantId?: string | null;
  tenantName?: string | null;
  outcome?: string;
  error?: string;
  params?: unknown;
  [key: string]: unknown;
}

interface AuditLogResponse {
  entries: AuditLogEntry[];
  nextCursor: number | null;
  scannedBytes: number;
  skippedLines: number;
  done: boolean;
}

// A filtered 512 KiB window can legitimately match nothing, so one click
// chains a bounded number of windows before handing control back.
const MAX_REQUESTS_PER_CLICK = 10;
const TARGET_ENTRIES_PER_CLICK = 200;

function csvCell(c: string): string {
  let v = c;
  // Guard against spreadsheet formula injection when the export is opened
  // in Excel/Sheets: prefix risky leading characters with a quote.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
}

function toCsv(entries: AuditLogEntry[]): string {
  const header = [
    "ts",
    "action",
    "tenantId",
    "tenantName",
    "outcome",
    "error",
    "params",
  ];
  const rows = entries.map((e) =>
    [
      e.ts ?? "",
      e.action ?? "",
      e.tenantId ?? "",
      e.tenantName ?? "",
      e.outcome ?? "",
      e.error ?? "",
      e.params === undefined ? "" : JSON.stringify(e.params),
    ]
      .map((c) => `"${csvCell(String(c))}"`)
      .join(",")
  );
  return [header.map((c) => `"${csvCell(c)}"`).join(","), ...rows].join("\n");
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

export default function AuditLog() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [actionFilter, setActionFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("any");
  const [tenantScope, setTenantScope] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [searched, setSearched] = useState(false);
  const [skippedLines, setSkippedLines] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  // Stop an in-flight walk and drop results when the page unmounts.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // Results filtered under one tenant scope must not survive a switch.
  useEffect(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setEntries([]);
    setCursor(null);
    setDone(false);
    setSearched(false);
    setSkippedLines(0);
    setExpanded(new Set());
  }, [tenantId]);

  const buildQuery = (cursorArg: number | null): string => {
    const params = new URLSearchParams();
    if (cursorArg !== null) params.set("cursor", String(cursorArg));
    params.set("limit", "200");
    if (actionFilter.trim()) params.set("action", actionFilter.trim());
    if (outcomeFilter !== "any") params.set("outcome", outcomeFilter);
    if (tenantScope === "current" && tenantId) params.set("tenantId", tenantId);
    // Send both bounds as explicit UTC instants for the operator's LOCAL
    // day. Sending the raw strings instead splits interpretation: a bare
    // date parses as UTC midnight while a zoneless date-time parses in the
    // SERVER's timezone — so the two bounds could sit in different frames
    // and each disagree with the day the operator picked.
    if (fromDate) {
      const from = new Date(`${fromDate}T00:00:00`);
      if (!Number.isNaN(from.getTime())) {
        params.set("from", from.toISOString());
      }
    }
    if (toDate) {
      // Inclusive of the whole "to" day.
      const to = new Date(`${toDate}T23:59:59.999`);
      if (!Number.isNaN(to.getTime())) {
        params.set("to", to.toISOString());
      }
    }
    return params.toString();
  };

  const fetchEntries = async (reset: boolean) => {
    setLoading(true);
    setMessage(null);
    cancelRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const pinnedTenantId = tenantId;

    let localCursor = reset ? null : cursor;
    let collected = 0;

    try {
      if (reset) {
        setEntries([]);
        setExpanded(new Set());
        setSkippedLines(0);
        setDone(false);
        setSearched(true);
      }
      for (let i = 0; i < MAX_REQUESTS_PER_CLICK; i++) {
        if (cancelRef.current) break;
        const res = await tfetch(
          `/api/admin/audit-log?${buildQuery(localCursor)}`,
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;

        if (!result.success) {
          setMessage({
            type: "error",
            text: result.error || "Failed to read the audit log",
          });
          return;
        }
        const page = result.data as AuditLogResponse;
        if (page.entries.length > 0) {
          setEntries((prev) => [...prev, ...page.entries]);
          collected += page.entries.length;
        }
        if (page.skippedLines > 0) {
          setSkippedLines((prev) => prev + page.skippedLines);
        }
        setCursor(page.nextCursor);
        localCursor = page.nextCursor;
        if (page.done) {
          setDone(true);
          break;
        }
        if (collected >= TARGET_ENTRIES_PER_CLICK) break;
      }
    } catch {
      if (!ac.signal.aborted) {
        setMessage({ type: "error", text: "Failed to connect to the API" });
      }
    } finally {
      setLoading(false);
    }
  };

  const cancelFetch = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const exportCsv = () => {
    downloadCsv(
      `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(entries)
    );
  };

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Every mutating action this tool has run, newest first. Secrets are redacted before entries are written."
        badge="Local"
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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ScrollText className="h-5 w-5" />
            Filters
          </CardTitle>
          <CardDescription>
            All filters are optional — search with none to browse the full log.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="action-filter">Action contains</Label>
              <Input
                id="action-filter"
                placeholder="e.g. offboarding or member_add"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Outcome</Label>
              <Select
                value={outcomeFilter}
                onValueChange={(v) => v && setOutcomeFilter(v)}
              >
                <SelectTrigger className="w-full" aria-label="Outcome filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any outcome</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tenant</Label>
              <Select
                value={tenantScope}
                onValueChange={(v) => v && setTenantScope(v)}
              >
                <SelectTrigger className="w-full" aria-label="Tenant filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tenants</SelectItem>
                  <SelectItem value="current" disabled={!tenantId}>
                    {tenant ? `Current (${tenant.name})` : "Current tenant"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="from-date">From</Label>
              <Input
                id="from-date"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="to-date">To</Label>
              <Input
                id="to-date"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => fetchEntries(true)} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Search
            </Button>
            {loading && (
              <Button variant="outline" onClick={cancelFetch}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={exportCsv}
              disabled={entries.length === 0}
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Entries</CardTitle>
          <CardDescription>
            {entries.length > 0
              ? `${entries.length.toLocaleString()} entr${entries.length === 1 ? "y" : "ies"} loaded${done ? " — end of log reached" : ""}${skippedLines > 0 ? ` · ${skippedLines} unreadable line${skippedLines === 1 ? "" : "s"} skipped` : ""}`
              : searched && !loading
                ? "No entries matched the filters"
                : "Run a search to load audit entries"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No entries to display
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry, i) => (
                <div key={i} className="rounded-lg border bg-muted/30">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(i)}
                    className="w-full flex items-center justify-between gap-3 p-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">
                          {entry.action ?? "(unknown action)"}
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            entry.outcome === "success"
                              ? "border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"
                              : "border-red-300 dark:border-red-800 text-red-700 dark:text-red-400"
                          }
                        >
                          {entry.outcome ?? "unknown"}
                        </Badge>
                        {entry.tenantName && (
                          <span className="text-xs text-muted-foreground">
                            {entry.tenantName}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {entry.ts ? new Date(entry.ts).toLocaleString() : "—"}
                        {entry.error && (
                          <span className="text-red-600 dark:text-red-400">
                            {" "}
                            · {String(entry.error).slice(0, 140)}
                          </span>
                        )}
                      </p>
                    </div>
                  </button>
                  {expanded.has(i) && (
                    <div className="px-3 pb-3">
                      <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-auto max-h-80 whitespace-pre-wrap break-words">
                        {JSON.stringify(entry, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {entries.length > 0 && !done && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => fetchEntries(false)}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Load older entries
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
