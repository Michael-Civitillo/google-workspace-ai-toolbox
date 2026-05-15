"use client";

import { useMemo, useRef, useState } from "react";
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
  ShieldOff,
  CheckCircle2,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

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

interface RevokeFileOutcome {
  fileId: string;
  fileName?: string;
  removed: number;
  removedAsAdmin?: number;
  errors: Array<{ permissionId: string; target: string; message: string }>;
  notFound?: boolean;
}

interface RevokeBatchResult {
  user: string;
  results: RevokeFileOutcome[];
}

type PermissionType = ExternalPermission["type"];

interface RevokeTarget {
  /** Email of the file owner — the user we'll impersonate to delete perms. */
  user: string;
  /** Files we plan to strip external permissions from. */
  files: ExternalFile[];
  /** Where to apply the optimistic removal once it succeeds. */
  scope: { kind: "single" } | { kind: "tenant"; userIndex: number };
  /**
   * Snapshot of which permission categories to revoke when this action runs.
   * Captured at dialog-open time so toggling the filter mid-confirm doesn't
   * change the in-flight operation.
   */
  categories: PermissionType[];
}

type CategoryKey = "anyone" | "domain" | "users";

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  anyone: "Anyone-with-link / public",
  domain: "External domains",
  users: "External users & groups",
};

/** Map UI checkbox state to the API category list (users covers user+group). */
function categoriesFromFilter(
  filter: Record<CategoryKey, boolean>
): PermissionType[] {
  const out: PermissionType[] = [];
  if (filter.anyone) out.push("anyone");
  if (filter.domain) out.push("domain");
  if (filter.users) out.push("user", "group");
  return out;
}

/** A file matches the active filter when at least one of its externals matches. */
function fileMatchesFilter(
  file: ExternalFile,
  active: Set<PermissionType>
): boolean {
  return file.external.some((p) => active.has(p.type));
}

/** Per-batch cap on the server — mirrored here so we can chunk client-side. */
const REVOKE_BATCH_SIZE = 200;

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
  const { tenant } = useCurrentTenant();

  // Single-user state
  const [user, setUser] = useState("");
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<AuditResult | null>(null);
  const [singleSelected, setSingleSelected] = useState<Set<string>>(
    () => new Set()
  );

  // Tenant-wide state
  const [tenantLoading, setTenantLoading] = useState(false);
  const [perUser, setPerUser] = useState<PerUserOutcome[]>([]);
  const [tenantUserCount, setTenantUserCount] = useState<number | null>(null);
  // Per-user-result selection map keyed by userIndex — kept sparse so a switch
  // back to a tenant-wide scan after a single audit doesn't leak old picks.
  const [tenantSelected, setTenantSelected] = useState<
    Record<number, Set<string>>
  >({});
  const cancelRef = useRef(false);
  const [includeSuspended, setIncludeSuspended] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Revoke-flow state
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeNotice, setRevokeNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  // Which permission categories to strip on the next revoke. All on by default
  // because the most common workflow is a full lockdown.
  const [categoryFilter, setCategoryFilter] = useState<
    Record<CategoryKey, boolean>
  >({ anyone: true, domain: true, users: true });

  const activeCategories = useMemo(
    () => new Set(categoriesFromFilter(categoryFilter)),
    [categoryFilter]
  );
  const noCategoriesSelected = activeCategories.size === 0;

  // -------------------------------------------------------------------------
  // Single-user audit
  // -------------------------------------------------------------------------
  const runSingle = async () => {
    if (!user.trim()) return;
    setSingleLoading(true);
    setError(null);
    setSingleResult(null);
    setSingleSelected(new Set());
    setRevokeNotice(null);
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

  const runTenantWide = async (mode: "all" | "suspended-only" = "all") => {
    setError(null);
    setSingleResult(null);
    setSingleSelected(new Set());
    setPerUser([]);
    setTenantSelected({});
    setTenantUserCount(null);
    setRevokeNotice(null);
    cancelRef.current = false;
    setTenantLoading(true);

    try {
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

      const targets = allUsers.filter((u) =>
        mode === "suspended-only" ? u.suspended : includeSuspended || !u.suspended
      );

      const seeded: PerUserOutcome[] = targets.map((u) => ({
        user: u.primaryEmail,
        status: "pending",
      }));
      setPerUser(seeded);
      setTenantUserCount(targets.length);

      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) {
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

  // -------------------------------------------------------------------------
  // Selection helpers
  // -------------------------------------------------------------------------

  function toggleSingle(fileId: string) {
    setSingleSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function setSingleAll(files: ExternalFile[], on: boolean) {
    setSingleSelected(on ? new Set(files.map((f) => f.id)) : new Set());
  }

  function toggleTenant(userIndex: number, fileId: string) {
    setTenantSelected((prev) => {
      const cur = new Set(prev[userIndex] ?? []);
      if (cur.has(fileId)) cur.delete(fileId);
      else cur.add(fileId);
      return { ...prev, [userIndex]: cur };
    });
  }

  function setTenantAllForUser(
    userIndex: number,
    files: ExternalFile[],
    on: boolean
  ) {
    setTenantSelected((prev) => ({
      ...prev,
      [userIndex]: on ? new Set(files.map((f) => f.id)) : new Set(),
    }));
  }

  // -------------------------------------------------------------------------
  // Revoke flow
  // -------------------------------------------------------------------------

  function startRevoke(target: RevokeTarget) {
    setRevokeNotice(null);
    setRevokeTarget(target);
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      // The server enforces a 200-file cap per request to bound Drive API
      // blast radius. Split larger targets into sequential chunks and merge
      // results before driving optimistic UI updates.
      const fileChunks: ExternalFile[][] = [];
      for (let i = 0; i < revokeTarget.files.length; i += REVOKE_BATCH_SIZE) {
        fileChunks.push(revokeTarget.files.slice(i, i + REVOKE_BATCH_SIZE));
      }

      const mergedResults: RevokeFileOutcome[] = [];
      let abortedAt: { index: number; reason: string } | null = null;

      for (let i = 0; i < fileChunks.length; i++) {
        try {
          const res = await tfetch("/api/admin/sharing-audit/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user: revokeTarget.user,
              fileIds: fileChunks[i].map((f) => f.id),
              categories: revokeTarget.categories,
            }),
          });
          const data = await res.json();
          if (!data.success) {
            abortedAt = { index: i, reason: data.error || "Revoke failed" };
            break;
          }
          const batch: RevokeBatchResult = data.data;
          mergedResults.push(...batch.results);
        } catch {
          abortedAt = { index: i, reason: "Network error" };
          break;
        }
      }

      const totalRemoved = mergedResults.reduce(
        (sum, r) => sum + r.removed,
        0
      );
      const filesCleaned = mergedResults.filter(
        (r) =>
          r.errors.length === 0 && (r.removed > 0 || r.notFound === true)
      );
      const filesWithErrors = mergedResults.filter(
        (r) => r.errors.length > 0
      );

      // Optimistically remove fully-cleaned files from the result lists.
      const cleanedIds = new Set(filesCleaned.map((r) => r.fileId));
      if (revokeTarget.scope.kind === "single") {
        setSingleResult((prev) =>
          prev
            ? {
                ...prev,
                files: prev.files.filter((f) => !cleanedIds.has(f.id)),
              }
            : prev
        );
        setSingleSelected((prev) => {
          const next = new Set(prev);
          for (const id of cleanedIds) next.delete(id);
          return next;
        });
      } else {
        const idx = revokeTarget.scope.userIndex;
        setPerUser((prev) =>
          prev.map((p, i) =>
            i === idx
              ? {
                  ...p,
                  files: (p.files ?? []).filter(
                    (f) => !cleanedIds.has(f.id)
                  ),
                }
              : p
          )
        );
        setTenantSelected((prev) => {
          const cur = new Set(prev[idx] ?? []);
          for (const id of cleanedIds) cur.delete(id);
          return { ...prev, [idx]: cur };
        });
      }

      const totalRemovedAsAdmin = mergedResults.reduce(
        (sum, r) => sum + (r.removedAsAdmin ?? 0),
        0
      );
      const adminSummary =
        totalRemovedAsAdmin > 0
          ? ` ${totalRemovedAsAdmin} of those required domain-admin escalation (Shared Drive inherited permissions).`
          : "";
      const errorSummary =
        filesWithErrors.length > 0
          ? ` ${filesWithErrors.length} file${
              filesWithErrors.length === 1 ? "" : "s"
            } had per-file errors — see Drive directly to investigate.`
          : "";
      const baseMessage = `Removed ${totalRemoved} external permission${
        totalRemoved === 1 ? "" : "s"
      } across ${filesCleaned.length} file${
        filesCleaned.length === 1 ? "" : "s"
      }.${adminSummary}${errorSummary}`;

      if (abortedAt) {
        // Earlier batches are always full REVOKE_BATCH_SIZE chunks (the partial
        // is always last), so mergedResults.length matches the number of files
        // sent to the server before the failure.
        const filesProcessed = mergedResults.length;
        const earlierResults =
          filesProcessed === 0
            ? "no earlier batches succeeded"
            : `earlier batches removed ${totalRemoved} permission${
                totalRemoved === 1 ? "" : "s"
              } across ${filesCleaned.length} of ${filesProcessed} file${
                filesProcessed === 1 ? "" : "s"
              }${
                filesWithErrors.length > 0
                  ? ` (${filesWithErrors.length} with per-file errors)`
                  : ""
              }`;
        setRevokeNotice({
          tone: "error",
          message: `Batch ${abortedAt.index + 1} of ${fileChunks.length} failed: ${
            abortedAt.reason
          }. ${earlierResults}. Re-run to retry the remainder.`,
        });
      } else {
        setRevokeNotice({
          tone: filesWithErrors.length > 0 ? "error" : "success",
          message: baseMessage,
        });
      }
      setRevokeTarget(null);
    } catch {
      setRevokeNotice({
        tone: "error",
        message: "Unexpected error while revoking. Some changes may have been applied.",
      });
    } finally {
      setRevokeBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

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

  const revokeChanges = useMemo(() => {
    if (!revokeTarget) return [];
    const targetCategories = new Set(revokeTarget.categories);
    // Category-aware count: only count permissions that would actually be
    // stripped given the snapshot filter.
    const totalPerms = revokeTarget.files.reduce(
      (sum, f) =>
        sum + f.external.filter((p) => targetCategories.has(p.type)).length,
      0
    );
    const sample = revokeTarget.files
      .slice(0, 5)
      .map((f) => f.name)
      .join(", ");

    const categoryLabels: string[] = [];
    if (targetCategories.has("anyone")) categoryLabels.push(CATEGORY_LABELS.anyone);
    if (targetCategories.has("domain")) categoryLabels.push(CATEGORY_LABELS.domain);
    if (targetCategories.has("user") || targetCategories.has("group")) {
      categoryLabels.push(CATEGORY_LABELS.users);
    }

    return [
      {
        label: "File owner (will be impersonated)",
        after: revokeTarget.user,
      },
      {
        label: "Files affected",
        after:
          revokeTarget.files.length === 1
            ? sample
            : `${revokeTarget.files.length} files (${sample}${
                revokeTarget.files.length > 5 ? ", …" : ""
              })`,
      },
      {
        label: "Categories to remove",
        after: categoryLabels.join(", "),
      },
      {
        label: "External permissions to remove",
        after: `${totalPerms} permission${totalPerms === 1 ? "" : "s"}`,
        emphasis: true,
      },
      {
        label: "Internal collaborators",
        after: "Untouched — only external sharing is removed",
      },
    ];
  }, [revokeTarget]);

  const isBulk = (revokeTarget?.files.length ?? 0) > 1;

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

      {revokeNotice && (
        <Alert
          className={`mb-6 ${
            revokeNotice.tone === "success"
              ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
              : "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40"
          }`}
        >
          {revokeNotice.tone === "success" ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          )}
          <AlertDescription
            className={`text-sm ${
              revokeNotice.tone === "success"
                ? "text-emerald-800 dark:text-emerald-300"
                : "text-amber-800 dark:text-amber-300"
            }`}
          >
            {revokeNotice.message}
          </AlertDescription>
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
              Include suspended users in &quot;Scan every user&quot;
            </label>

            <div className="flex flex-wrap gap-2">
              {!tenantLoading ? (
                <>
                  <Button
                    onClick={() => runTenantWide("all")}
                    disabled={singleLoading}
                  >
                    <PlayCircle className="h-4 w-4 mr-1.5" />
                    Scan every user
                  </Button>
                  <Button
                    onClick={() => runTenantWide("suspended-only")}
                    disabled={singleLoading}
                    variant="outline"
                    title="Run the audit only on users whose account is currently suspended — the fastest path to locking down shares left behind by offboarded staff"
                  >
                    <PlayCircle className="h-4 w-4 mr-1.5" />
                    Scan suspended users only
                  </Button>
                </>
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
              <CategoryFilterRow
                value={categoryFilter}
                onChange={setCategoryFilter}
                disabled={revokeBusy}
              />
              <div className="space-y-2">
                {perUser.map((p, idx) => {
                  const flagged = p.files ?? [];
                  const sel = tenantSelected[idx] ?? new Set<string>();
                  const allSelected =
                    flagged.length > 0 && sel.size === flagged.length;
                  const matching = flagged.filter((f) =>
                    fileMatchesFilter(f, activeCategories)
                  );
                  return (
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
                              scanned {p.scannedFiles} · {flagged.length}{" "}
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
                        {p.status === "done" && flagged.length > 0 && (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50 text-xs shrink-0"
                          >
                            {flagged.length} flagged
                          </Badge>
                        )}
                      </div>

                      {p.status === "done" && flagged.length > 0 && (
                        <div className="mt-2 space-y-2 pl-3 border-l-2 border-amber-200 dark:border-amber-900/50">
                          <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                            <label className="text-xs flex items-center gap-1.5 text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={(e) =>
                                  setTenantAllForUser(
                                    idx,
                                    flagged,
                                    e.target.checked
                                  )
                                }
                              />
                              Select all
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="xs"
                                variant="destructive"
                                disabled={sel.size === 0 || revokeBusy || noCategoriesSelected}
                                onClick={() =>
                                  startRevoke({
                                    user: p.user,
                                    files: flagged.filter((f) => sel.has(f.id)),
                                    scope: { kind: "tenant", userIndex: idx },
                                    categories: categoriesFromFilter(categoryFilter),
                                  })
                                }
                              >
                                <ShieldOff className="h-3 w-3 mr-1" />
                                Revoke on selected ({sel.size})
                              </Button>
                              <Button
                                size="xs"
                                variant="destructive"
                                disabled={
                                  matching.length === 0 || revokeBusy || noCategoriesSelected
                                }
                                onClick={() =>
                                  startRevoke({
                                    user: p.user,
                                    files: matching,
                                    scope: { kind: "tenant", userIndex: idx },
                                    categories: categoriesFromFilter(categoryFilter),
                                  })
                                }
                                title={`Strip selected categories from every matching file for ${p.user} (files with other external sharing types may stay listed)`}
                              >
                                <ShieldOff className="h-3 w-3 mr-1" />
                                Revoke selected categories on {matching.length} file
                                {matching.length === 1 ? "" : "s"}
                              </Button>
                            </div>
                          </div>
                          {p.truncated && (
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                              Audit was capped at 1,000 files — re-run after this completes to pick up the rest.
                            </p>
                          )}
                          <div className="space-y-1.5">
                            {flagged.map((f) => (
                              <FileRow
                                key={f.id}
                                file={f}
                                selected={sel.has(f.id)}
                                onToggle={() => toggleTenant(idx, f.id)}
                                onRevoke={() =>
                                  startRevoke({
                                    user: p.user,
                                    files: [f],
                                    scope: { kind: "tenant", userIndex: idx },
                                    categories: categoriesFromFilter(categoryFilter),
                                  })
                                }
                                revokeDisabled={revokeBusy || noCategoriesSelected}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
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
                <div className="space-y-3">
                  <CategoryFilterRow
                    value={categoryFilter}
                    onChange={setCategoryFilter}
                    disabled={revokeBusy}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs flex items-center gap-1.5 text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={
                          singleSelected.size === singleResult.files.length &&
                          singleResult.files.length > 0
                        }
                        onChange={(e) =>
                          setSingleAll(singleResult.files, e.target.checked)
                        }
                      />
                      Select all ({singleResult.files.length})
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={singleSelected.size === 0 || revokeBusy || noCategoriesSelected}
                        onClick={() =>
                          startRevoke({
                            user: singleResult.user,
                            files: singleResult.files.filter((f) =>
                              singleSelected.has(f.id)
                            ),
                            scope: { kind: "single" },
                            categories: categoriesFromFilter(categoryFilter),
                          })
                        }
                      >
                        <ShieldOff className="h-4 w-4 mr-1.5" />
                        Revoke on selected ({singleSelected.size})
                      </Button>
                      {(() => {
                        const matching = singleResult.files.filter((f) =>
                          fileMatchesFilter(f, activeCategories)
                        );
                        return (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={
                              matching.length === 0 || revokeBusy || noCategoriesSelected
                            }
                            onClick={() =>
                              startRevoke({
                                user: singleResult.user,
                                files: matching,
                                scope: { kind: "single" },
                                categories: categoriesFromFilter(categoryFilter),
                              })
                            }
                            title={`Strip selected categories from every matching file for ${singleResult.user} (files with other external sharing types may stay listed)`}
                          >
                            <ShieldOff className="h-4 w-4 mr-1.5" />
                            Revoke selected categories on {matching.length} file
                            {matching.length === 1 ? "" : "s"}
                          </Button>
                        );
                      })()}
                    </div>
                  </div>
                  {singleResult.truncated && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Audit was capped at 1,000 files — re-run after this completes to pick up the rest.
                    </p>
                  )}
                  <div className="space-y-2">
                    {singleResult.files.map((f) => (
                      <FileRow
                        key={f.id}
                        file={f}
                        selected={singleSelected.has(f.id)}
                        onToggle={() => toggleSingle(f.id)}
                        onRevoke={() =>
                          startRevoke({
                            user: singleResult.user,
                            files: [f],
                            scope: { kind: "single" },
                            categories: categoriesFromFilter(categoryFilter),
                          })
                        }
                        revokeDisabled={revokeBusy || noCategoriesSelected}
                      />
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Confirm dialog — single click for one file, typed REVOKE for bulk */}
      <ConfirmActionDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o && !revokeBusy) setRevokeTarget(null);
        }}
        title={
          isBulk
            ? `Revoke external sharing on ${revokeTarget?.files.length ?? 0} files`
            : "Revoke external sharing"
        }
        summary="Removes external permissions in the selected categories from the listed files. Internal collaborators stay untouched."
        tenant={
          tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
        }
        severity={isBulk ? "high" : "medium"}
        confirmPhrase={isBulk ? "REVOKE" : undefined}
        confirmLabel={
          isBulk
            ? `Revoke on ${revokeTarget?.files.length ?? 0} files`
            : "Revoke external sharing"
        }
        busy={revokeBusy}
        changes={revokeChanges}
        warnings={
          <span>
            Permission removal is <strong>irreversible</strong> — Google issues
            a fresh permission ID on re-share, so the same link won&apos;t
            grant access again. Re-sharing requires the file owner to add the
            collaborator from scratch.
          </span>
        }
        onConfirm={confirmRevoke}
      />
    </>
  );
}

function FileRow({
  file,
  selected,
  onToggle,
  onRevoke,
  revokeDisabled,
}: {
  file: ExternalFile;
  selected: boolean;
  onToggle: () => void;
  onRevoke: () => void;
  revokeDisabled: boolean;
}) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 shrink-0"
          aria-label={`Select ${file.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{file.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {file.mimeType}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {file.webViewLink && (
                <a
                  href={file.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 text-blue-600 hover:underline"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <Button
                size="xs"
                variant="destructive"
                onClick={onRevoke}
                disabled={revokeDisabled}
              >
                <ShieldOff className="h-3 w-3 mr-1" />
                Revoke external
              </Button>
            </div>
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
      </div>
    </div>
  );
}

function CategoryFilterRow({
  value,
  onChange,
  disabled,
}: {
  value: Record<CategoryKey, boolean>;
  onChange: (next: Record<CategoryKey, boolean>) => void;
  disabled: boolean;
}) {
  const noneSelected = !value.anyone && !value.domain && !value.users;
  return (
    <div className="rounded-md border bg-muted/30 p-3 mb-3">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Which sharing types should bulk and per-file revoke remove?
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((key) => (
          <label key={key} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={value[key]}
              onChange={(e) =>
                onChange({ ...value, [key]: e.target.checked })
              }
              disabled={disabled}
            />
            {CATEGORY_LABELS[key]}
          </label>
        ))}
      </div>
      {noneSelected && (
        <p className="text-xs text-red-600 mt-2">
          Pick at least one category — revoke is disabled until you do.
        </p>
      )}
    </div>
  );
}
