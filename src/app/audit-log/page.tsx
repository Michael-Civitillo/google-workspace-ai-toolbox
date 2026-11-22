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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import { ScrollText, Loader2, Search, Download, X } from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

interface AuditLogEntry {
  ts?: string;
  action?: string;
  tenantId?: string | null;
  tenantName?: string | null;
  outcome?: string;
  error?: string;
  actor?: string;
  params?: unknown;
  [key: string]: unknown;
}

interface AuditLogResponse {
  entries: AuditLogEntry[];
  nextCursor: string | null;
  scannedBytes: number;
  skippedLines: number;
  done: boolean;
  /** Done because the walk reached entries older than the From date. */
  reachedFromBound?: boolean;
  /** Timestamp of the furthest-back entry read, matched or not. */
  oldestScannedTs?: string | null;
  /** The log rotated away under the cursor: this page starts from the top. */
  restarted?: boolean;
}

// A filtered 512 KiB window can legitimately match nothing, so one click
// chains windows until it has a screenful, reaches the end, or has spent its
// time budget, then hands control back with a way to keep going.
const MAX_REQUESTS_PER_CLICK = 40;
const CLICK_TIME_BUDGET_MS = 3_000;
const TARGET_ENTRIES_PER_CLICK = 200;

/** Why the last search stopped before reaching the end of the log. */
type StopReason = "budget" | "cancelled" | "failed";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

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
    "actor",
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
      typeof e.actor === "string" ? e.actor : "",
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
  // Released later, not straight after click(): some browsers start reading
  // the blob only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function AuditLog() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [actionFilter, setActionFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("any");
  const [tenantScope, setTenantScope] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [reachedFromBound, setReachedFromBound] = useState(false);
  const [searched, setSearched] = useState(false);
  const [skippedLines, setSkippedLines] = useState(0);
  // How much of the log the current search has read, and how far back in
  // time that got: what an empty or partial result is honestly about.
  const [scannedBytes, setScannedBytes] = useState(0);
  const [oldestTs, setOldestTs] = useState<string | null>(null);
  const [pagesRead, setPagesRead] = useState(0);
  const [stopReason, setStopReason] = useState<StopReason | null>(null);
  const [restartedNote, setRestartedNote] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  // The query (filters, no cursor) the listed entries were fetched with.
  // "Load older entries" continues THAT search: building it from the filter
  // boxes again would pair the cursor with filters edited since, and append
  // entries that answer a different question to the list.
  const [listedQuery, setListedQuery] = useState<string | null>(null);

  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  // Bumped by every new search, a tenant switch and unmount: a walk only
  // writes to the page while it is still the latest one.
  const searchSeq = useRef(0);

  // Stop an in-flight walk and drop results when the page unmounts.
  useEffect(() => {
    // The counter object, not its value: unmount must bump the live count.
    const seq = searchSeq;
    return () => {
      seq.current++;
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // Results filtered under one tenant scope must not survive a switch.
  useEffect(() => {
    searchSeq.current++;
    cancelRef.current = true;
    abortRef.current?.abort();
    setLoading(false);
    setEntries([]);
    setCursor(null);
    setDone(false);
    setReachedFromBound(false);
    setSearched(false);
    setSkippedLines(0);
    setScannedBytes(0);
    setOldestTs(null);
    setPagesRead(0);
    setStopReason(null);
    setRestartedNote(false);
    setListedQuery(null);
    setExpanded(new Set());
  }, [tenantId]);

  /** The filters in the boxes now, as a query string without a cursor. */
  const buildQuery = (): string => {
    const params = new URLSearchParams();
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
    const query = reset ? buildQuery() : listedQuery;
    if (query === null) return;
    const seq = ++searchSeq.current;
    const pinnedTenantId = tenantId;
    const isLatest = () =>
      searchSeq.current === seq && tenantIdRef.current === pinnedTenantId;
    setLoading(true);
    setMessage(null);
    setStopReason(null);
    cancelRef.current = false;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const startedAt = Date.now();

    let localCursor = reset ? null : cursor;
    let collected = 0;
    let reachedEnd = false;
    let stopped: StopReason = "budget";

    if (reset) {
      setListedQuery(query);
      setEntries([]);
      setExpanded(new Set());
      setSkippedLines(0);
      setScannedBytes(0);
      setOldestTs(null);
      setPagesRead(0);
      setDone(false);
      setReachedFromBound(false);
      setRestartedNote(false);
      setCursor(null);
      setSearched(true);
    }

    try {
      for (let i = 0; i < MAX_REQUESTS_PER_CLICK; i++) {
        if (cancelRef.current) {
          stopped = "cancelled";
          break;
        }
        if (i > 0 && Date.now() - startedAt > CLICK_TIME_BUDGET_MS) break;
        const params = new URLSearchParams(query);
        if (localCursor !== null) params.set("cursor", localCursor);
        const res = await tfetch(
          `/api/admin/audit-log?${params.toString()}`,
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (!isLatest()) return;

        if (!result.success) {
          stopped = "failed";
          setMessage({
            type: "error",
            text: result.error || "Failed to read the audit log",
          });
          break;
        }
        const page = result.data as AuditLogResponse;
        if (page.restarted) {
          // The file this search was reading rotated away. The page holds
          // the newest entries again, so replace the list rather than
          // appending what would be duplicates.
          setEntries(page.entries);
          setExpanded(new Set());
          setSkippedLines(page.skippedLines);
          setScannedBytes(page.scannedBytes);
          setOldestTs(page.oldestScannedTs ?? null);
          setPagesRead(1);
          setRestartedNote(true);
          collected = page.entries.length;
        } else {
          if (page.entries.length > 0) {
            setEntries((prev) => [...prev, ...page.entries]);
            collected += page.entries.length;
          }
          if (page.skippedLines > 0) {
            setSkippedLines((prev) => prev + page.skippedLines);
          }
          setScannedBytes((prev) => prev + page.scannedBytes);
          if (page.oldestScannedTs) setOldestTs(page.oldestScannedTs);
          setPagesRead((prev) => prev + 1);
        }
        setCursor(page.nextCursor);
        localCursor = page.nextCursor;
        if (page.done) {
          reachedEnd = true;
          setDone(true);
          setReachedFromBound(!!page.reachedFromBound);
          break;
        }
        if (collected >= TARGET_ENTRIES_PER_CLICK) break;
      }
    } catch {
      if (!isLatest()) return;
      if (ac.signal.aborted) {
        stopped = "cancelled";
      } else {
        stopped = "failed";
        setMessage({ type: "error", text: "Failed to connect to the API" });
      }
    }
    if (!isLatest()) return;
    setStopReason(reachedEnd ? null : stopped);
    setLoading(false);
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
    // Only what has been loaded so far: say so in the file name, so a copy
    // of part of the log is never mistaken for the whole of it.
    downloadCsv(
      `audit-log-${new Date().toISOString().slice(0, 10)}${done ? "" : "-PARTIAL"}.csv`,
      toCsv(entries)
    );
  };

  const oldestLabel = formatWhen(oldestTs);
  const howFar = `${formatBytes(scannedBytes)} of the log${
    oldestLabel ? `, back to ${oldestLabel}` : ""
  }`;
  const stoppedNote =
    stopReason === "cancelled"
      ? "Search cancelled. "
      : stopReason === "failed"
        ? "Search stopped on an error. "
        : "";

  let entriesSummary: string;
  if (loading && entries.length === 0) {
    entriesSummary = pagesRead > 0 ? `Searching… read ${howFar}` : "Searching…";
  } else if (entries.length > 0) {
    const loaded = `${entries.length.toLocaleString()} entr${entries.length === 1 ? "y" : "ies"} loaded`;
    const extent = done
      ? reachedFromBound
        ? " — searched back to the From date"
        : " — reached the oldest entry the log keeps"
      : ` — searched ${howFar} so far`;
    const stopped =
      done || loading
        ? ""
        : stopReason === "cancelled"
          ? " (cancelled)"
          : stopReason === "failed"
            ? " (stopped on an error)"
            : "";
    const skipped =
      skippedLines > 0
        ? ` · ${skippedLines} unreadable line${skippedLines === 1 ? "" : "s"} skipped`
        : "";
    entriesSummary = `${loaded}${extent}${stopped}${skipped}`;
  } else if (searched && done) {
    entriesSummary = "No entries matched the filters";
  } else if (searched && pagesRead > 0) {
    entriesSummary = `${stoppedNote}No matches in the newest ${howFar}. Load older entries to keep searching.`;
  } else if (searched) {
    entriesSummary = `${stoppedNote}Nothing has been read yet — try again.`;
  } else {
    entriesSummary = "Run a search to load audit entries";
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Every change this tool has made, newest first, from the live log and its rotated archives. Secrets are redacted before entries are written."
        badge="Local"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
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
                items={{ any: "Any outcome", success: "Success", error: "Error" }}
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
                items={{
                  all: "All tenants",
                  current: tenant ? `Current (${tenant.name})` : "Current tenant",
                }}
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
              {done || entries.length === 0
                ? "Export CSV"
                : "Export CSV (loaded so far)"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entries</CardTitle>
          <CardDescription>{entriesSummary}</CardDescription>
        </CardHeader>
        <CardContent>
          {restartedNote && (
            <p className="mb-3 text-xs text-muted-foreground">
              The log rotated while this search was reading it, so the list
              started again from the newest entry.
            </p>
          )}
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
                              ? "border-success/40 text-success-fg"
                              : "border-danger/40 text-danger-fg"
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
                          <span className="text-danger">
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

          {searched && !done && listedQuery !== null && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => fetchEntries(false)}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {pagesRead > 0 ? "Load older entries" : "Try again"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
