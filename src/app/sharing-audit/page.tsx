"use client";

import { useRef, useState } from "react";
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
import { PageHeader } from "@/components/page-header";
import {
  Search,
  Loader2,
  ExternalLink,
  Globe2,
  Users,
  Mail,
  AlertTriangle,
  Download,
  StopCircle,
  PlayCircle,
} from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

interface ExternalPermission {
  type: "anyone" | "domain" | "user" | "group";
  role: string;
  target: string;
  allowFileDiscovery?: boolean | null;
}

interface ExternalFile {
  id: string;
  name: string;
  webViewLink: string | null;
  mimeType: string;
  ownedByMe: boolean;
  externalCount: number;
  external: ExternalPermission[];
}

interface AuditResult {
  user: string;
  scannedFiles: number;
  truncated: boolean;
  files: ExternalFile[];
}

interface UserListItem {
  primaryEmail: string;
  fullName: string;
  isAdmin: boolean;
  suspended: boolean;
  orgUnitPath: string;
}

interface PerUserOutcome {
  user: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  scannedFiles?: number;
  truncated?: boolean;
  files?: ExternalFile[];
  error?: string;
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900/50",
  organizer: "bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900/50",
  fileOrganizer: "bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900/50",
  writer: "bg-amber-100 text-amber-700 border-amber-200",
  commenter: "bg-blue-100 text-blue-700 border-blue-200",
  reader: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

function permissionIcon(type: ExternalPermission["type"]) {
  switch (type) {
    case "anyone":
    case "domain":
      return <Globe2 className="h-3.5 w-3.5" />;
    case "group":
      return <Users className="h-3.5 w-3.5" />;
    default:
      return <Mail className="h-3.5 w-3.5" />;
  }
}

function permissionLabel(p: ExternalPermission): string {
  if (p.type === "anyone") {
    return p.allowFileDiscovery
      ? "Anyone (public, indexable)"
      : "Anyone with the link";
  }
  if (p.type === "domain") return `Domain: ${p.target}`;
  return `${p.type}: ${p.target}`;
}

/**
 * Convert one or more per-user audit results into a flat CSV. We expand each
 * external permission into its own row and prefix with the file owner so the
 * tenant-wide export slots straight into a remediation spreadsheet.
 */
function toCsv(results: AuditResult[]): string {
  const header = [
    "owner",
    "file_name",
    "file_id",
    "mime_type",
    "web_view_link",
    "share_type",
    "share_target",
    "role",
    "anyone_with_link_indexable",
  ];
  const rows: string[][] = [header];
  for (const r of results) {
    for (const f of r.files) {
      for (const p of f.external) {
        rows.push([
          r.user,
          f.name,
          f.id,
          f.mimeType,
          f.webViewLink ?? "",
          p.type,
          p.target,
          p.role,
          p.type === "anyone" ? String(p.allowFileDiscovery ?? "") : "",
        ]);
      }
    }
  }
  return rows
    .map((r) => r.map((c) => `"${(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
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

export default function SharingAudit() {
  // Single-user state
  const [user, setUser] = useState("");
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<AuditResult | null>(null);

  // Tenant-wide state
  const [tenantLoading, setTenantLoading] = useState(false);
  const [perUser, setPerUser] = useState<PerUserOutcome[]>([]);
  const [tenantUserCount, setTenantUserCount] = useState<number | null>(null);
  // Mutable cancel flag — used inside the async loop without rerunning the
  // effect every state update.
  const cancelRef = useRef(false);
  // Skip suspended users by default — they're typically noise for a sharing
  // audit (admin can still tick to include them).
  const [includeSuspended, setIncludeSuspended] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Single-user audit
  // -------------------------------------------------------------------------
  const runSingle = async () => {
    if (!user.trim()) return;
    setSingleLoading(true);
    setError(null);
    setSingleResult(null);
    try {
      const res = await tfetch(
        `/api/admin/sharing-audit?user=${encodeURIComponent(user)}`
      );
      const data = await res.json();
      if (data.success) setSingleResult(data.data);
      else setError(data.error || "Audit failed");
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setSingleLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Tenant-wide audit — client-orchestrated
  // -------------------------------------------------------------------------

  /**
   * Walk every user in the tenant via paginated /api/admin/users, then for
   * each user invoke the per-user sharing-audit endpoint. We render results
   * incrementally (per user) and short-circuit on cancel. Each per-user call
   * has independent error isolation — one user's 500 doesn't kill the whole
   * scan.
   */
  const runTenantWide = async () => {
    setError(null);
    setSingleResult(null);
    setPerUser([]);
    setTenantUserCount(null);
    cancelRef.current = false;
    setTenantLoading(true);

    try {
      // Step 1: enumerate every tenant user.
      const allUsers: UserListItem[] = [];
      let pageToken: string | undefined = undefined;
      while (true) {
        const url =
          "/api/admin/users" + (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await tfetch(url);
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Failed to enumerate tenant users");
          setTenantLoading(false);
          return;
        }
        allUsers.push(...(data.data.users as UserListItem[]));
        pageToken = data.data.nextPageToken ?? undefined;
        if (cancelRef.current) break;
        if (!pageToken) break;
      }

      // Optionally filter out suspended users.
      const targets = allUsers.filter(
        (u) => includeSuspended || !u.suspended
      );

      // Seed the per-user table so the UI shows everyone we plan to scan.
      const seeded: PerUserOutcome[] = targets.map((u) => ({
        user: u.primaryEmail,
        status: "pending",
      }));
      setPerUser(seeded);
      setTenantUserCount(targets.length);

      // Step 2: scan each user sequentially. Sequential (not parallel) keeps
      // us politely under per-app Drive API quotas and makes progress display
      // easy. For genuinely large tenants this would batch with a small
      // concurrency limit, but per the requirements small tenants only.
      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) {
          // Mark every still-pending user as skipped.
          setPerUser((prev) =>
            prev.map((p) =>
              p.status === "pending" ? { ...p, status: "skipped" } : p
            )
          );
          break;
        }

        const target = targets[i];
        setPerUser((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "running" } : p
          )
        );

        try {
          const res = await tfetch(
            `/api/admin/sharing-audit?user=${encodeURIComponent(target.primaryEmail)}`
          );
          const data = await res.json();
          if (data.success) {
            const r: AuditResult = data.data;
            setPerUser((prev) =>
              prev.map((p, idx) =>
                idx === i
                  ? {
                      ...p,
                      status: "done",
                      scannedFiles: r.scannedFiles,
                      truncated: r.truncated,
                      files: r.files,
                    }
                  : p
              )
            );
          } else {
            setPerUser((prev) =>
              prev.map((p, idx) =>
                idx === i
                  ? { ...p, status: "error", error: data.error || "Audit failed" }
                  : p
              )
            );
          }
        } catch {
          setPerUser((prev) =>
            prev.map((p, idx) =>
              idx === i ? { ...p, status: "error", error: "Request failed" } : p
            )
          );
        }
      }
    } finally {
      setTenantLoading(false);
    }
  };

  const cancelTenantWide = () => {
    cancelRef.current = true;
  };

  const tenantSummary = (() => {
    if (perUser.length === 0) return null;
    const done = perUser.filter((p) => p.status === "done").length;
    const errored = perUser.filter((p) => p.status === "error").length;
    const flaggedFiles = perUser
      .map((p) => p.files?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    const flaggedUsers = perUser.filter(
      (p) => (p.files?.length ?? 0) > 0
    ).length;
    const truncatedUsers = perUser.filter((p) => p.truncated).length;
    return { done, errored, flaggedFiles, flaggedUsers, truncatedUsers };
  })();

  return (
    <>
      <PageHeader
        title="External Sharing Audit"
        description="Find Drive files shared outside your tenant — link-shared, shared with external domains, or shared with external email addresses. Per-user or tenant-wide."
        badge="Drive"
      />

      {error && (
        <Alert className="mb-6 border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
          <AlertDescription className="text-red-800 dark:text-red-300">{error}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-5xl space-y-6">
        {/* Single-user card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Audit one user</CardTitle>
            <CardDescription>
              Scans up to 1,000 owned Drive files and flags any permission
              outside the tenant&apos;s verified domains. Read-only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="user">User Email</Label>
              <div className="flex gap-2">
                <Input
                  id="user"
                  placeholder="user@yourdomain.com"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSingle()}
                  disabled={tenantLoading}
                />
                <Button
                  onClick={runSingle}
                  disabled={!user.trim() || singleLoading || tenantLoading}
                >
                  {singleLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tenant-wide card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Audit every user (tenant-wide)</CardTitle>
            <CardDescription>
              Walks every user in your tenant and runs the same audit per
              mailbox. Sequential and read-only. Best for small tenants — for
              very large directories, use the single-user mode per individual
              of interest.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSuspended}
                onChange={(e) => setIncludeSuspended(e.target.checked)}
                disabled={tenantLoading}
              />
              Include suspended users
            </label>

            <div className="flex gap-2">
              {!tenantLoading ? (
                <Button onClick={runTenantWide} disabled={singleLoading}>
                  <PlayCircle className="h-4 w-4 mr-1.5" />
                  Scan every user
                </Button>
              ) : (
                <Button variant="outline" onClick={cancelTenantWide}>
                  <StopCircle className="h-4 w-4 mr-1.5" />
                  Cancel
                </Button>
              )}
              {tenantSummary && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const aggregated: AuditResult[] = perUser
                      .filter((p) => p.status === "done" && p.files)
                      .map((p) => ({
                        user: p.user,
                        scannedFiles: p.scannedFiles ?? 0,
                        truncated: p.truncated ?? false,
                        files: p.files ?? [],
                      }));
                    if (aggregated.length === 0) return;
                    downloadCsv(
                      `tenant-external-sharing-${new Date()
                        .toISOString()
                        .slice(0, 10)}.csv`,
                      toCsv(aggregated)
                    );
                  }}
                  disabled={tenantSummary.flaggedFiles === 0}
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Export CSV
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tenant-wide progress + results */}
        {(tenantLoading || perUser.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                Tenant-wide results{" "}
                {tenantUserCount !== null && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {tenantSummary?.done ?? 0} / {tenantUserCount} scanned
                    {tenantSummary?.errored
                      ? ` · ${tenantSummary.errored} errors`
                      : ""}
                  </span>
                )}
              </CardTitle>
              {tenantSummary && (
                <CardDescription>
                  {tenantSummary.flaggedFiles} flagged file
                  {tenantSummary.flaggedFiles === 1 ? "" : "s"} across{" "}
                  {tenantSummary.flaggedUsers} user
                  {tenantSummary.flaggedUsers === 1 ? "" : "s"}
                  {tenantSummary.truncatedUsers > 0 &&
                    ` · ${tenantSummary.truncatedUsers} user${tenantSummary.truncatedUsers === 1 ? "" : "s"} hit the 1,000-file cap`}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              {/* Compact per-user status strip */}
              <div className="space-y-2">
                {perUser.map((p) => (
                  <div
                    key={p.user}
                    className="rounded-lg border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{p.user}</p>
                        {p.status === "running" && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />{" "}
                            scanning…
                          </p>
                        )}
                        {p.status === "done" && (
                          <p className="text-xs text-muted-foreground">
                            scanned {p.scannedFiles} · {p.files?.length ?? 0}{" "}
                            flagged
                            {p.truncated ? " · truncated" : ""}
                          </p>
                        )}
                        {p.status === "error" && (
                          <p className="text-xs text-red-600">
                            {p.error}
                          </p>
                        )}
                        {p.status === "skipped" && (
                          <p className="text-xs text-muted-foreground">
                            cancelled before scan
                          </p>
                        )}
                        {p.status === "pending" && (
                          <p className="text-xs text-muted-foreground">
                            queued
                          </p>
                        )}
                      </div>
                      {p.status === "done" && (p.files?.length ?? 0) > 0 && (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50 text-xs shrink-0"
                        >
                          {p.files?.length} flagged
                        </Badge>
                      )}
                    </div>

                    {/* Per-user file list */}
                    {p.status === "done" && (p.files?.length ?? 0) > 0 && (
                      <div className="mt-2 space-y-1.5 pl-3 border-l-2 border-amber-200">
                        {p.files!.map((f) => (
                          <FileRow key={f.id} file={f} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Single-user results */}
        {singleResult && !tenantLoading && perUser.length === 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-lg">
                    Results — {singleResult.user}
                  </CardTitle>
                  <CardDescription>
                    Scanned {singleResult.scannedFiles} file
                    {singleResult.scannedFiles === 1 ? "" : "s"} ·{" "}
                    {singleResult.files.length} flagged
                    {singleResult.truncated
                      ? " · result was truncated at the cap"
                      : ""}
                  </CardDescription>
                </div>
                {singleResult.files.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadCsv(
                        `external-sharing-${singleResult.user}-${new Date()
                          .toISOString()
                          .slice(0, 10)}.csv`,
                        toCsv([singleResult])
                      )
                    }
                  >
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Export CSV
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {singleResult.truncated && (
                <Alert className="mb-4 border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
                    Hit the 1,000-file cap. There may be additional
                    externally-shared files that weren&apos;t scanned.
                  </AlertDescription>
                </Alert>
              )}
              {singleResult.files.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No externally-shared files found in {singleResult.scannedFiles}{" "}
                  scanned.
                </div>
              ) : (
                <div className="space-y-2">
                  {singleResult.files.map((f) => (
                    <FileRow key={f.id} file={f} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function FileRow({ file }: { file: ExternalFile }) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{file.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {file.mimeType}
          </p>
        </div>
        {file.webViewLink && (
          <a
            href={file.webViewLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs flex items-center gap-1 text-blue-600 hover:underline shrink-0"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {file.external.map((p, i) => (
          <Badge
            key={i}
            variant="outline"
            className={`${
              p.type === "anyone"
                ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900/50"
                : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50"
            } text-xs flex items-center gap-1`}
          >
            {permissionIcon(p.type)}
            {permissionLabel(p)}
            <span
              className={`ml-1 px-1 rounded ${
                ROLE_BADGE[p.role] ??
                "bg-zinc-100 text-zinc-700 border-zinc-200"
              }`}
            >
              {p.role}
            </span>
          </Badge>
        ))}
      </div>
    </div>
  );
}
