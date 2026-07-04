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
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { AiSummary } from "@/components/ai-summary";
import {
  Activity,
  Loader2,
  Search,
  Download,
  Sparkles,
  FileText,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

interface ActivityEvent {
  time: string;
  actor: string;
  ip: string | null;
  eventType: string;
  eventName: string;
  params?: Record<string, string>;
}

type AppTab = "login" | "admin";

function csvCell(c: string): string {
  let v = c;
  // Guard against spreadsheet formula injection when the export is opened
  // in Excel/Sheets: prefix risky leading characters with a quote.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
}

function toCsv(events: ActivityEvent[]): string {
  const header = ["time", "actor", "ip", "eventType", "eventName", "params"];
  const rows = events.map((e) =>
    [
      e.time,
      e.actor,
      e.ip ?? "",
      e.eventType,
      e.eventName,
      e.params ? JSON.stringify(e.params) : "",
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

export default function ActivityReports() {
  const { id: tenantId } = useCurrentTenant();

  const [tab, setTab] = useState<AppTab>("login");
  const [userFilter, setUserFilter] = useState("");
  const [days, setDays] = useState("7");

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [pageToken, setPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [digestDays, setDigestDays] = useState("7");
  const [digest, setDigest] = useState("");
  const [digestMeta, setDigestMeta] = useState("");
  const [digestLoading, setDigestLoading] = useState(false);

  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // Monotonic request id: a response only applies while it's the latest
  // events request, so a slow first page can't clobber a newer one.
  const eventsSeqRef = useRef(0);
  // The filters the current listing was fetched with. "Load more" reuses
  // them — a Reports pageToken belongs to the query it came from, so pairing
  // it with live (possibly edited) inputs returns the wrong window.
  const [listedFilters, setListedFilters] = useState<{
    user: string;
    days: number | null;
  } | null>(null);

  // Events fetched for tenant A must not survive a switch to tenant B.
  useEffect(() => {
    setEvents([]);
    setPageToken(null);
    setSearched(false);
    setExpanded(new Set());
    setDigest("");
    setDigestMeta("");
    setListedFilters(null);
  }, [tenantId]);

  // Switching between login/admin shows a different data set — clear the list.
  const switchTab = (value: string) => {
    if (value !== "login" && value !== "admin") return;
    setTab(value);
    setEvents([]);
    setPageToken(null);
    setSearched(false);
    setExpanded(new Set());
  };

  const loadEvents = async (append: boolean) => {
    setLoading(true);
    setMessage(null);
    const pinnedTenantId = tenantId;
    const pinnedTab = tab;
    const seq = ++eventsSeqRef.current;
    const d = Number(days);
    const filters =
      append && listedFilters
        ? listedFilters
        : {
            user: userFilter.trim(),
            days: Number.isInteger(d) && d >= 1 ? d : null,
          };
    try {
      const params = new URLSearchParams({ app: pinnedTab, pageSize: "100" });
      if (filters.user) params.set("user", filters.user);
      if (filters.days !== null) params.set("days", String(filters.days));
      if (append && pageToken) params.set("pageToken", pageToken);

      const res = await tfetch(
        `/api/admin/activity?${params.toString()}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      // A response for the other tab (or an outdated request) must be
      // dropped: sign-in events rendering under the Admin Console tab is
      // exactly the kind of quiet misinformation an audit page can't have.
      if (tabRef.current !== pinnedTab) return;
      if (eventsSeqRef.current !== seq) return;

      if (result.success) {
        if (!append) setListedFilters(filters);
        setEvents((prev) =>
          append ? [...prev, ...result.data.events] : result.data.events
        );
        setPageToken(result.data.nextPageToken);
        setSearched(true);
        if (!append) setExpanded(new Set());
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to load activity",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  const generateDigest = async () => {
    setDigestLoading(true);
    setMessage(null);
    setDigest("");
    const pinnedTenantId = tenantId;
    try {
      const d = Number(digestDays);
      const res = await tfetch(
        "/api/ai/security-digest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            days: Number.isInteger(d) && d >= 1 ? d : 7,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setDigest(result.data.summary);
        setDigestMeta(
          `Last ${result.data.days} day${result.data.days === 1 ? "" : "s"}`
        );
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to generate the digest",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setDigestLoading(false);
    }
  };

  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const eventBadgeClass = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes("fail") || n.includes("suspicious")) {
      return "border-red-300 dark:border-red-800 text-red-700 dark:text-red-400";
    }
    if (n.includes("challenge") || n.includes("verification")) {
      return "border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400";
    }
    return "";
  };

  return (
    <>
      <PageHeader
        title="Activity Reports"
        description="Sign-in and Admin Console activity from Google's Reports API. Data can lag by minutes to hours — an empty list doesn't always mean no activity."
        badge="Reports"
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
              <Sparkles className="h-5 w-5" />
              Security Digest
            </CardTitle>
            <CardDescription>
              A Gemini summary of recent sign-in and admin activity: suspicious
              logins, elevated changes, and recommended follow-ups.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="digest-days">Days to cover</Label>
                <Input
                  id="digest-days"
                  type="number"
                  min={1}
                  max={30}
                  className="w-28"
                  value={digestDays}
                  onChange={(e) => setDigestDays(e.target.value)}
                />
              </div>
              <Button onClick={generateDigest} disabled={digestLoading}>
                {digestLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate digest
              </Button>
            </div>

            {digestLoading && (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
                <div className="text-center">
                  <p className="font-medium text-foreground">
                    Generating digest...
                  </p>
                  <p className="text-sm">
                    Pulling activity from the Reports API, then summarizing.
                  </p>
                </div>
              </div>
            )}

            {digest && (
              <>
                <Separator />
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="h-4 w-4" />
                    <p className="text-sm font-medium">
                      Security Digest — {digestMeta}
                    </p>
                  </div>
                  <AiSummary text={digest} />
                  <p className="text-xs text-muted-foreground mt-4">
                    Gemini summary of Reports API data. Always verify critical
                    findings manually.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Browse Events
            </CardTitle>
            <CardDescription>
              Raw activity events, newest first. Filter by user and lookback
              window.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={tab} onValueChange={switchTab}>
              <TabsList>
                <TabsTrigger value="login">Sign-ins</TabsTrigger>
                <TabsTrigger value="admin">Admin Console</TabsTrigger>
              </TabsList>
              <TabsContent value={tab} className="mt-4 space-y-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-2">
                    <Label htmlFor="user-filter">
                      User (optional{tab === "admin" ? ", actor" : ""})
                    </Label>
                    <Input
                      id="user-filter"
                      placeholder="user@yourdomain.com"
                      className="w-64"
                      value={userFilter}
                      onChange={(e) => setUserFilter(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="days">Days</Label>
                    <Input
                      id="days"
                      type="number"
                      min={1}
                      max={180}
                      className="w-24"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                    />
                  </div>
                  <Button onClick={() => loadEvents(false)} disabled={loading}>
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Load events
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      downloadCsv(
                        `activity-${tab}-${new Date().toISOString().slice(0, 10)}.csv`,
                        toCsv(events)
                      )
                    }
                    disabled={events.length === 0}
                  >
                    <Download className="h-4 w-4" />
                    Export CSV
                  </Button>
                </div>

                {events.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {searched && !loading
                      ? "No events in this window (Reports data can lag by minutes to hours)"
                      : "Load events to browse activity"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {events.length.toLocaleString()} event
                      {events.length === 1 ? "" : "s"} loaded
                    </p>
                    {events.map((e, i) => (
                      <div key={i} className="rounded-lg border bg-muted/30">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(i)}
                          className="w-full flex items-center justify-between gap-3 p-3 text-left"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium">{e.actor}</p>
                              <Badge
                                variant="outline"
                                className={eventBadgeClass(e.eventName)}
                              >
                                {e.eventName || "(event)"}
                              </Badge>
                              {e.eventType && (
                                <span className="text-xs text-muted-foreground">
                                  {e.eventType}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {e.time ? new Date(e.time).toLocaleString() : "—"}
                              {e.ip && ` · ${e.ip}`}
                            </p>
                          </div>
                        </button>
                        {expanded.has(i) && e.params && (
                          <div className="px-3 pb-3">
                            <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-auto max-h-80 whitespace-pre-wrap break-words">
                              {JSON.stringify(e.params, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                    {pageToken && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => loadEvents(true)}
                        disabled={loading}
                      >
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Load more events
                      </Button>
                    )}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
