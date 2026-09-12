"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  ChevronDown,
  ChevronRight,
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
  nextPageToken?: string | null;
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
  permissionsSeen?: number;
  permissionsTargeted?: number;
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
  owner: "border-primary/20 bg-primary/10 text-primary",
  organizer: "border-primary/20 bg-primary/10 text-primary",
  fileOrganizer: "border-primary/20 bg-primary/10 text-primary",
  writer: "border-warning/30 bg-warning/10 text-warning-fg",
  commenter: "border-info/25 bg-info/10 text-info-fg",
  reader: "border-border bg-muted text-muted-foreground",
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
 *
 * `pathsByUser` is keyed by the user the audit ran as, then by fileId.
 * Missing entries get an empty path cell so an export still works if
 * resolution failed for some files.
 */
function toCsv(
  results: AuditResult[],
  pathsByUser?: Record<string, Record<string, string>>
): string {
  const header = [
    "owner",
    "path",
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
    const paths = pathsByUser?.[r.user] ?? {};
    for (const f of r.files) {
      const path = paths[f.id] ?? "";
      for (const p of f.external) {
        rows.push([
          r.user,
          path,
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
    .map((r) => r.map((c) => `"${csvCell(c)}"`).join(","))
    .join("\n");
}

/**
 * Quote-escape a CSV cell and neutralize spreadsheet formula injection.
 * File names and share targets can be renamed by external collaborators, so a
 * cell like `=HYPERLINK(...)` must not execute when the export is opened in
 * Excel/Sheets. A leading apostrophe forces text interpretation.
 */
function csvCell(c: string): string {
  let v = c ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
}

/** Server caps resolve-paths at 1,000 ids per request; chunk to match. */
const PATH_RESOLVE_CHUNK = 1000;

/**
 * Users worked on concurrently by the tenant-wide scan and by path
 * resolution. Impersonation — and Drive's quota — is per user, so a few users
 * in parallel cut wall time roughly this many-fold without competing for one
 * quota. Kept small so a 2,000-user tenant still reads as a steady walk.
 */
const USER_CONCURRENCY = 3;

/**
 * Ask the server to walk Drive's parent chain for every flagged file
 * across these audit results, a few users at a time (impersonation is
 * per user). Returns `{ [user]: { [fileId]: path } }`. Failures fall
 * back to an empty per-user map — the CSV still exports, just without
 * the path column populated for that user. An aborted signal stops the
 * walk early and returns what was resolved so far.
 */
async function fetchPathsForResults(
  results: AuditResult[],
  tenantId?: string | null,
  signal?: AbortSignal
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};

  const resolveUser = async (r: AuditResult) => {
    if (r.files.length === 0) {
      out[r.user] = {};
      return;
    }
    // resolve-paths caps a batch at 1,000 file ids; a single user can exceed
    // that after chained audit pages. Chunk and merge so users with the most
    // flagged files still get their paths (previously the whole request 400'd
    // and their CSV path column came back empty). The catch sits per chunk so
    // one failed chunk costs only its own paths, not the ones already resolved.
    const ids = r.files.map((f) => f.id);
    const merged: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += PATH_RESOLVE_CHUNK) {
      if (signal?.aborted) break;
      const chunk = ids.slice(i, i + PATH_RESOLVE_CHUNK);
      try {
        const res = await tfetch(
          "/api/admin/sharing-audit/resolve-paths",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user: r.user, fileIds: chunk }),
            signal,
          },
          tenantId
        );
        const data = await res.json();
        if (data?.success) {
          Object.assign(merged, (data.data?.paths as Record<string, string>) ?? {});
        }
      } catch {
        // Keep whatever already resolved for this user (an abort lands here too).
      }
    }
    out[r.user] = merged;
  };

  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      if (signal?.aborted) return;
      await resolveUser(results[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(USER_CONCURRENCY, results.length) }, worker)
  );
  return out;
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
  const { tenant, id: tenantId } = useCurrentTenant();

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
  // userIndex set for collapsed users in the tenant-wide results list. A
  // collapsed user shows the summary row but hides the per-file list — much
  // easier to scroll a long tenant when one user has hundreds of flagged
  // files. Default state is expanded (empty set) to preserve the existing
  // out-of-the-box behaviour.
  const [collapsedUsers, setCollapsedUsers] = useState<Set<number>>(
    () => new Set()
  );
  const cancelRef = useRef(false);
  const singleCancelRef = useRef(false);
  // Abort the in-flight scan request on cancel, tenant switch, or unmount —
  // the cancel refs stop the loops between pages, but without an abort the
  // current request keeps running (and hitting the API) invisibly.
  const scanAbortRef = useRef<AbortController | null>(null);
  // Same for the CSV export's path resolution, which can run for minutes on a
  // large tenant result.
  const exportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      singleCancelRef.current = true;
      scanAbortRef.current?.abort();
      exportAbortRef.current?.abort();
    };
  }, []);
  const [includeSuspended, setIncludeSuspended] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Results, selections, and resume tokens are tenant-scoped: revoking,
  // continuing, or exporting a tenant-A snapshot after switching to tenant B
  // would run against the wrong tenant. Cancel anything in flight and clear
  // the slate whenever the tenant changes.
  const prevTenantRef = useRef(tenantId);
  useEffect(() => {
    if (prevTenantRef.current === tenantId) return;
    prevTenantRef.current = tenantId;
    cancelRef.current = true;
    singleCancelRef.current = true;
    scanAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    setSingleResult(null);
    setSingleSelected(new Set());
    setPerUser([]);
    setTenantSelected({});
    setCollapsedUsers(new Set());
    setTenantUserCount(null);
    setRevokeTarget(null);
    setRevokeNotice(null);
    setError(null);
  }, [tenantId]);

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
  // Latest category filter, read by the memoized FileRow's revoke handler so a
  // filter change is honored even when the row itself isn't re-rendered.
  const categoryFilterRef = useRef(categoryFilter);
  categoryFilterRef.current = categoryFilter;

  // Stable ref carrying the latest handlers + filter into the memoized
  // per-user cards. The ref's identity never changes, so a card can skip
  // re-rendering while still calling the CURRENT handler when clicked —
  // without this, every per-user status update during a tenant-wide scan
  // re-rendered every user card (O(users²) work across the whole scan).
  const cardHandlersRef = useRef<TenantCardHandlers>({
    toggleTenant: () => {},
    setTenantAllForUser: () => {},
    toggleUserCollapsed: () => {},
    startRevoke: () => {},
    categoryFilter,
  });
  cardHandlersRef.current = {
    toggleTenant,
    setTenantAllForUser,
    toggleUserCollapsed,
    startRevoke,
    categoryFilter,
  };

  // Export-CSV state. Resolution can take many seconds for large audits so
  // we surface a "Resolving paths…" indicator on the export button, with a
  // Cancel next to it that aborts the resolution (no file is produced then).
  const [exportBusy, setExportBusy] = useState(false);

  async function exportCsvWithPaths(results: AuditResult[], filename: string) {
    if (results.length === 0) return;
    exportAbortRef.current?.abort();
    const ac = new AbortController();
    exportAbortRef.current = ac;
    setExportBusy(true);
    try {
      const paths = await fetchPathsForResults(results, tenantId, ac.signal);
      // Cancelled, tenant switched, or page left: don't drop a half-resolved
      // file on the operator.
      if (ac.signal.aborted) return;
      downloadCsv(filename, toCsv(results, paths));
    } finally {
      if (exportAbortRef.current === ac) setExportBusy(false);
    }
  }

  function exportSingleCsv(result: AuditResult) {
    return exportCsvWithPaths(
      [result],
      `external-sharing-${result.user}-${new Date().toISOString().slice(0, 10)}.csv`
    );
  }

  function exportTenantCsv(aggregated: AuditResult[]) {
    return exportCsvWithPaths(
      aggregated,
      `tenant-external-sharing-${new Date().toISOString().slice(0, 10)}.csv`
    );
  }

  const cancelExport = () => exportAbortRef.current?.abort();

  // -------------------------------------------------------------------------
  // Single-user audit
  // -------------------------------------------------------------------------

  // Belt: cap auto-pagination so a 1M-file Drive can't trap the operator
  // in a 20-minute scan. After this many pages we stop and surface the
  // remaining nextPageToken in the result so they can choose to continue.
  const SINGLE_USER_PAGE_CAP = 20; // up to 20,000 files

  const runSingle = async () => {
    if (!user.trim()) return;
    setSingleLoading(true);
    setError(null);
    setSingleResult(null);
    setSingleSelected(new Set());
    setRevokeNotice(null);
    // Clear any prior tenant-wide scan state. The single-user results card only
    // renders when perUser is empty, so without this a single-user audit run
    // after a tenant-wide scan would appear to do nothing.
    setPerUser([]);
    setTenantSelected({});
    setTenantUserCount(null);
    singleCancelRef.current = false;
    // Pin the tenant for the whole scan so a switch mid-walk can't redirect
    // later pages to a different tenant.
    const pinnedTenantId = tenantId;
    const ac = new AbortController();
    scanAbortRef.current = ac;
    try {
      let pageToken: string | undefined;
      let totalScanned = 0;
      const accumulated: ExternalFile[] = [];
      let pagesFetched = 0;
      // We populate singleResult progressively so the operator sees flagged
      // files appear while the rest of the Drive is still being walked.
      while (true) {
        if (singleCancelRef.current) break;
        const url =
          `/api/admin/sharing-audit?user=${encodeURIComponent(user)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await tfetch(url, { signal: ac.signal }, pinnedTenantId);
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Audit failed");
          return;
        }
        const page: AuditResult = data.data;
        totalScanned += page.scannedFiles;
        accumulated.push(...page.files);
        pagesFetched++;
        // Surface progress every page so the operator isn't staring at a
        // dead spinner during a long Drive walk.
        setSingleResult({
          user: page.user,
          scannedFiles: totalScanned,
          truncated: !!page.nextPageToken,
          nextPageToken: page.nextPageToken,
          files: accumulated.slice(),
        });
        if (!page.nextPageToken) break;
        if (pagesFetched >= SINGLE_USER_PAGE_CAP) break;
        pageToken = page.nextPageToken;
      }
    } catch {
      // An abort is the operator cancelling (or leaving) — not a failure.
      if (!ac.signal.aborted) setError("Failed to connect to the API");
    } finally {
      setSingleLoading(false);
    }
  };

  const cancelSingle = () => {
    singleCancelRef.current = true;
    scanAbortRef.current?.abort();
  };

  // Resume a single-user audit from where it stopped — either because the
  // operator cancelled mid-flight or because we hit the page cap.
  const continueSingleScan = async () => {
    if (!singleResult?.nextPageToken || singleLoading) return;
    setSingleLoading(true);
    singleCancelRef.current = false;
    // Resume against the user the snapshot belongs to — NOT the live input
    // field, which the operator may have edited since the scan ran. Replaying
    // user A's page token against user B would scan the wrong Drive.
    const scanUser = singleResult.user;
    const pinnedTenantId = tenantId;
    const ac = new AbortController();
    scanAbortRef.current = ac;
    try {
      let pageToken: string | undefined = singleResult.nextPageToken;
      let totalScanned = singleResult.scannedFiles;
      const accumulated: ExternalFile[] = singleResult.files.slice();
      let pagesFetched = 0;
      while (true) {
        if (singleCancelRef.current) break;
        const url =
          `/api/admin/sharing-audit?user=${encodeURIComponent(scanUser)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await tfetch(url, { signal: ac.signal }, pinnedTenantId);
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Audit failed");
          return;
        }
        const page: AuditResult = data.data;
        totalScanned += page.scannedFiles;
        accumulated.push(...page.files);
        pagesFetched++;
        setSingleResult({
          user: page.user,
          scannedFiles: totalScanned,
          truncated: !!page.nextPageToken,
          nextPageToken: page.nextPageToken,
          files: accumulated.slice(),
        });
        if (!page.nextPageToken) break;
        if (pagesFetched >= SINGLE_USER_PAGE_CAP) break;
        pageToken = page.nextPageToken;
      }
    } catch {
      // An abort is the operator cancelling (or leaving) — not a failure.
      if (!ac.signal.aborted) setError("Failed to connect to the API");
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
    setCollapsedUsers(new Set());
    setTenantUserCount(null);
    setRevokeNotice(null);
    cancelRef.current = false;
    setTenantLoading(true);
    // Pin the tenant for the entire orchestrated scan so a mid-run switch
    // can't send later per-user audits to a different tenant.
    const pinnedTenantId = tenantId;
    const ac = new AbortController();
    scanAbortRef.current = ac;

    try {
      const allUsers: UserListItem[] = [];
      let pageToken: string | undefined = undefined;
      while (true) {
        const url =
          "/api/admin/users" + (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await tfetch(url, { signal: ac.signal }, pinnedTenantId);
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

      // Scan one user; every state update is functional, so completions from
      // the workers below can interleave without clobbering each other.
      const scanOne = async (i: number) => {
        const target = targets[i];
        setPerUser((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "running" } : p
          )
        );

        try {
          const res = await tfetch(
            `/api/admin/sharing-audit?user=${encodeURIComponent(target.primaryEmail)}`,
            { signal: ac.signal },
            pinnedTenantId
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
              idx === i
                ? cancelRef.current
                  ? { ...p, status: "skipped" }
                  : { ...p, status: "error", error: "Request failed" }
                : p
            )
          );
        }
      };

      // A small worker pool instead of one user at a time: each request can
      // take seconds (up to 1,000 files plus permission walks), so a large
      // tenant was thousands of serial round trips. Quotas are per
      // impersonated user, so the workers don't compete with each other.
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < targets.length) {
          if (cancelRef.current) return;
          await scanOne(nextIndex++);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(USER_CONCURRENCY, targets.length) },
          worker
        )
      );
      if (cancelRef.current) {
        setPerUser((prev) =>
          prev.map((p) =>
            p.status === "pending" ? { ...p, status: "skipped" } : p
          )
        );
      }
    } catch {
      // Without this catch a network failure during user enumeration escaped
      // as an unhandled rejection: no banner, no loading reset — the scan just
      // silently froze. Aborts (cancel / tenant switch / unmount) are not
      // failures.
      if (!ac.signal.aborted) {
        setError("Failed to enumerate tenant users — network error");
      }
    } finally {
      setTenantLoading(false);
    }
  };

  const cancelTenantWide = () => {
    cancelRef.current = true;
    scanAbortRef.current?.abort();
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

  function toggleUserCollapsed(userIndex: number) {
    setCollapsedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userIndex)) next.delete(userIndex);
      else next.add(userIndex);
      return next;
    });
  }

  function collapseAllUsers() {
    const indices = new Set<number>();
    perUser.forEach((p, idx) => {
      if (p.status === "done" && (p.files?.length ?? 0) > 0) {
        indices.add(idx);
      }
    });
    setCollapsedUsers(indices);
  }

  function expandAllUsers() {
    setCollapsedUsers(new Set());
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
    // Pin the tenant for the whole batched revoke so a switch between chunks
    // can't send later deletes to a different tenant.
    const pinnedTenantId = tenantId;
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
          const res = await tfetch(
            "/api/admin/sharing-audit/revoke",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user: revokeTarget.user,
                fileIds: fileChunks[i].map((f) => f.id),
                categories: revokeTarget.categories,
                // The route re-checks the dialog's typed phrase server-side for
                // any multi-file chunk; a single-file revoke ignores it.
                confirm: "REVOKE",
              }),
            },
            pinnedTenantId
          );
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
      // Files where the revoke completed cleanly but found nothing to remove
      // — typically because the audit snapshot was stale (perms got cleaned
      // somewhere between the audit and the revoke). Drop them from the UI
      // list too so the operator sees an up-to-date picture.
      const filesAlreadyClean = mergedResults.filter(
        (r) =>
          r.errors.length === 0 &&
          r.removed === 0 &&
          !r.notFound
      );

      // Optimistically update the result lists. A file that revoked cleanly
      // only leaves the list when NO external permissions remain: with a
      // category filter active, its other-category externals are still live
      // sharing, so dropping the whole file would hide real exposure. Instead
      // strip the revoked categories from the row and keep it listed.
      const revokedCategories = new Set(revokeTarget.categories);
      const cleanOutcomes = new Map(
        mergedResults
          .filter((r) => r.errors.length === 0)
          .map((r) => [r.fileId, r] as const)
      );
      const updateFiles = (files: ExternalFile[]): ExternalFile[] =>
        files.flatMap((f) => {
          const outcome = cleanOutcomes.get(f.id);
          if (!outcome) return [f];
          if (outcome.notFound) return [];
          const remaining = f.external.filter(
            (p) => !revokedCategories.has(p.type)
          );
          if (remaining.length === 0) return [];
          return [
            { ...f, external: remaining, externalCount: remaining.length },
          ];
        });
      // Ids that will disappear from the list — selections must drop them too.
      const droppedIds = new Set(
        revokeTarget.files
          .filter((f) => {
            const outcome = cleanOutcomes.get(f.id);
            if (!outcome) return false;
            if (outcome.notFound) return true;
            return f.external.every((p) => revokedCategories.has(p.type));
          })
          .map((f) => f.id)
      );
      if (revokeTarget.scope.kind === "single") {
        setSingleResult((prev) =>
          prev
            ? {
                ...prev,
                files: updateFiles(prev.files),
              }
            : prev
        );
        setSingleSelected((prev) => {
          const next = new Set(prev);
          for (const id of droppedIds) next.delete(id);
          return next;
        });
      } else {
        const idx = revokeTarget.scope.userIndex;
        setPerUser((prev) =>
          prev.map((p, i) =>
            i === idx
              ? {
                  ...p,
                  files: updateFiles(p.files ?? []),
                }
              : p
          )
        );
        setTenantSelected((prev) => {
          const cur = new Set(prev[idx] ?? []);
          for (const id of droppedIds) cur.delete(id);
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
      const alreadyCleanSummary =
        filesAlreadyClean.length > 0
          ? ` ${filesAlreadyClean.length} file${
              filesAlreadyClean.length === 1 ? "" : "s"
            } had nothing to remove — perms were likely already cleaned between the audit and this run, or fell outside your selected categories. Files with no remaining external permissions were dropped from the list.`
          : "";

      // If we removed nothing and only had no-ops (no errors), the operator
      // is almost certainly looking at a stale audit. Make the message tell
      // them that instead of an ambiguous "0 across 0 files".
      const baseMessage =
        totalRemoved === 0 &&
        filesAlreadyClean.length > 0 &&
        filesWithErrors.length === 0
          ? `No external permissions needed removal on the ${filesAlreadyClean.length} selected file${
              filesAlreadyClean.length === 1 ? "" : "s"
            }. Files with no remaining external permissions were dropped from the list — re-run the audit to refresh.`
          : `Removed ${totalRemoved} external permission${
              totalRemoved === 1 ? "" : "s"
            } across ${filesCleaned.length} file${
              filesCleaned.length === 1 ? "" : "s"
            }.${adminSummary}${errorSummary}${alreadyCleanSummary}`;

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

  // Collapse state is keyed by user index and can hold stale entries after a
  // revoke empties a user's file list — count only indices that still have
  // flagged files so the "X of Y collapsed" summary and button states stay
  // truthful.
  const collapsedFlaggedCount = useMemo(() => {
    let n = 0;
    for (const idx of collapsedUsers) {
      if ((perUser[idx]?.files?.length ?? 0) > 0) n++;
    }
    return n;
  }, [collapsedUsers, perUser]);

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
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {revokeNotice && (
        <Alert
          variant={revokeNotice.tone === "success" ? "success" : "warning"}
          className="mb-6"
        >
          {revokeNotice.tone === "success" ? <CheckCircle2 /> : <AlertTriangle />}
          <AlertDescription>{revokeNotice.message}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-5xl space-y-6">
        {/* Single-user card */}
        <Card>
          <CardHeader>
            <CardTitle>Audit one user</CardTitle>
            <CardDescription>
              Walks every owned Drive file (1,000 per request, auto-continued
              up to 20,000 in a single run) and flags any permission outside
              the tenant&apos;s verified domains. Read-only.
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
                  onKeyDown={(e) => e.key === "Enter" && !singleLoading && runSingle()}
                  disabled={tenantLoading || singleLoading}
                />
                {!singleLoading ? (
                  <Button
                    onClick={runSingle}
                    disabled={!user.trim() || tenantLoading}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button variant="outline" onClick={cancelSingle}>
                    <StopCircle className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {singleLoading && singleResult && (
                <p className="text-xs text-muted-foreground">
                  Scanning… {singleResult.scannedFiles.toLocaleString()} file
                  {singleResult.scannedFiles === 1 ? "" : "s"} walked,{" "}
                  {singleResult.files.length.toLocaleString()} flagged so far.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tenant-wide card */}
        <Card>
          <CardHeader>
            <CardTitle>Audit every user (tenant-wide)</CardTitle>
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
                    void exportTenantCsv(aggregated);
                  }}
                  disabled={tenantSummary.flaggedFiles === 0 || exportBusy}
                >
                  {exportBusy ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {exportBusy ? "Resolving paths…" : "Export CSV"}
                </Button>
              )}
              {tenantSummary && exportBusy && (
                <Button variant="ghost" size="sm" onClick={cancelExport}>
                  Cancel export
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tenant-wide progress + results */}
        {(tenantLoading || perUser.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle>
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
              {tenantSummary && tenantSummary.flaggedUsers > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-muted-foreground">
                  <span>
                    {collapsedFlaggedCount} of {tenantSummary.flaggedUsers}{" "}
                    user
                    {tenantSummary.flaggedUsers === 1 ? "" : "s"} collapsed
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={collapseAllUsers}
                    disabled={
                      collapsedFlaggedCount === tenantSummary.flaggedUsers
                    }
                  >
                    <ChevronRight className="h-3 w-3 mr-1" />
                    Collapse all
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={expandAllUsers}
                    disabled={collapsedFlaggedCount === 0}
                  >
                    <ChevronDown className="h-3 w-3 mr-1" />
                    Expand all
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                {perUser.map((p, idx) => {
                  const isCollapsible =
                    p.status === "done" && (p.files?.length ?? 0) > 0;
                  return (
                    <TenantUserCard
                      key={p.user}
                      p={p}
                      idx={idx}
                      sel={tenantSelected[idx] ?? EMPTY_SELECTION}
                      isCollapsed={isCollapsible && collapsedUsers.has(idx)}
                      revokeBusy={revokeBusy}
                      noCategoriesSelected={noCategoriesSelected}
                      activeCategories={activeCategories}
                      handlers={cardHandlersRef}
                    />
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
                  <CardTitle>
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
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void exportSingleCsv(singleResult)}
                      disabled={exportBusy}
                    >
                      {exportBusy ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {exportBusy ? "Resolving paths…" : "Export CSV"}
                    </Button>
                    {exportBusy && (
                      <Button variant="ghost" size="sm" onClick={cancelExport}>
                        Cancel export
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {singleResult.truncated && !singleLoading && (
                <Alert variant="warning" className="mb-4">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertDescription className="flex items-center justify-between gap-3">
                    <span>
                      Scanned {singleResult.scannedFiles.toLocaleString()} files
                      and hit the per-run page cap. More files in this Drive
                      have not been audited yet.
                    </span>
                    {singleResult.nextPageToken && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={continueSingleScan}
                      >
                        <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
                        Continue scanning
                      </Button>
                    )}
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
                        disabled={singleSelected.size === 0 || revokeBusy || noCategoriesSelected || singleLoading}
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
                              matching.length === 0 || revokeBusy || noCategoriesSelected || singleLoading
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
                    <p className="text-xs text-warning-fg">
                      The scan stopped at the per-run cap — use Continue scanning above to pick up where it left off.
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
                            categories: categoriesFromFilter(
                              categoryFilterRef.current
                            ),
                          })
                        }
                        revokeDisabled={revokeBusy || noCategoriesSelected || singleLoading}
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

/** Empty selection shared across renders so an unselected user's `sel` prop
 * stays reference-equal and the memoized card below can skip re-rendering. */
const EMPTY_SELECTION = new Set<string>();

interface TenantCardHandlers {
  toggleTenant: (userIndex: number, fileId: string) => void;
  setTenantAllForUser: (
    userIndex: number,
    files: ExternalFile[],
    on: boolean
  ) => void;
  toggleUserCollapsed: (userIndex: number) => void;
  startRevoke: (target: RevokeTarget) => void;
  categoryFilter: Record<CategoryKey, boolean>;
}

const TenantUserCard = memo(_TenantUserCard, (prev, next) =>
  // Same idea as FileRow below: skip re-render unless something this card
  // displays changed. `handlers` is a ref whose identity never changes; the
  // card reads .current at event time so it always calls the live handlers
  // and the live category filter even when it skipped intervening renders.
  prev.p === next.p &&
  prev.sel === next.sel &&
  prev.isCollapsed === next.isCollapsed &&
  prev.revokeBusy === next.revokeBusy &&
  prev.noCategoriesSelected === next.noCategoriesSelected &&
  prev.activeCategories === next.activeCategories
);

function _TenantUserCard({
  p,
  idx,
  sel,
  isCollapsed,
  revokeBusy,
  noCategoriesSelected,
  activeCategories,
  handlers,
}: {
  p: PerUserOutcome;
  idx: number;
  sel: Set<string>;
  isCollapsed: boolean;
  revokeBusy: boolean;
  noCategoriesSelected: boolean;
  activeCategories: Set<PermissionType>;
  handlers: React.RefObject<TenantCardHandlers>;
}) {
  const flagged = p.files ?? [];
  const allSelected = flagged.length > 0 && sel.size === flagged.length;
  const matching = flagged.filter((f) => fileMatchesFilter(f, activeCategories));
  const isCollapsible = p.status === "done" && flagged.length > 0;
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div
        className={`flex items-center justify-between gap-3 ${
          isCollapsible
            ? "cursor-pointer select-none -mx-1 px-1 py-0.5 rounded hover:bg-muted/60"
            : ""
        }`}
        onClick={
          isCollapsible
            ? () => handlers.current.toggleUserCollapsed(idx)
            : undefined
        }
        role={isCollapsible ? "button" : undefined}
        tabIndex={isCollapsible ? 0 : undefined}
        aria-expanded={isCollapsible ? !isCollapsed : undefined}
        onKeyDown={
          isCollapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handlers.current.toggleUserCollapsed(idx);
                }
              }
            : undefined
        }
      >
        <div className="min-w-0 flex-1 flex items-center gap-1.5">
          {isCollapsible &&
            (isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ))}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{p.user}</p>
            {p.status === "running" && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> scanning…
              </p>
            )}
            {p.status === "done" && (
              <p className="text-xs text-muted-foreground">
                scanned {p.scannedFiles} · {flagged.length} flagged
                {p.truncated ? " · truncated" : ""}
              </p>
            )}
            {p.status === "error" && (
              <p className="text-xs text-danger">{p.error}</p>
            )}
            {p.status === "skipped" && (
              <p className="text-xs text-muted-foreground">
                cancelled before scan
              </p>
            )}
            {p.status === "pending" && (
              <p className="text-xs text-muted-foreground">queued</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isCollapsed && sel.size > 0 && (
            <Badge
              variant="outline"
              className="border-info/25 bg-info/10 text-info-fg text-xs"
            >
              {sel.size} selected
            </Badge>
          )}
          {p.status === "done" && flagged.length > 0 && (
            <Badge
              variant="outline"
              className="border-warning/30 bg-warning/10 text-warning-fg text-xs"
            >
              {flagged.length} flagged
            </Badge>
          )}
        </div>
      </div>

      {p.status === "done" && flagged.length > 0 && !isCollapsed && (
        <div className="mt-2 space-y-2 pl-3 border-l-2 border-warning/40">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
            <label className="text-xs flex items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) =>
                  handlers.current.setTenantAllForUser(
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
                  handlers.current.startRevoke({
                    user: p.user,
                    files: flagged.filter((f) => sel.has(f.id)),
                    scope: { kind: "tenant", userIndex: idx },
                    categories: categoriesFromFilter(
                      handlers.current.categoryFilter
                    ),
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
                  handlers.current.startRevoke({
                    user: p.user,
                    files: matching,
                    scope: { kind: "tenant", userIndex: idx },
                    categories: categoriesFromFilter(
                      handlers.current.categoryFilter
                    ),
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
            <p className="text-xs text-warning-fg">
              Audit was capped at 1,000 files for this user — run a single-user audit on them to scan the rest.
            </p>
          )}
          <div className="space-y-1.5">
            {flagged.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                selected={sel.has(f.id)}
                onToggle={() => handlers.current.toggleTenant(idx, f.id)}
                onRevoke={() =>
                  handlers.current.startRevoke({
                    user: p.user,
                    files: [f],
                    scope: { kind: "tenant", userIndex: idx },
                    categories: categoriesFromFilter(
                      handlers.current.categoryFilter
                    ),
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
}

const FileRow = memo(_FileRow, (prev, next) =>
  // Skip re-render unless something the row actually displays changed. The
  // onToggle/onRevoke closures are recreated every parent render but are safe to
  // keep stale: they only call setState-style handlers with values that are
  // stable per row (file id, user index), and the one changeable input — the
  // category filter used by revoke — is read live from a ref, not captured here.
  // This stops a single checkbox toggle from re-rendering every row across a
  // multi-thousand-file tenant-wide scan.
  prev.file === next.file &&
  prev.selected === next.selected &&
  prev.revokeDisabled === next.revokeDisabled
);

function _FileRow({
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
                  className="text-xs flex items-center gap-1 text-primary hover:underline"
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
                    ? "border-danger/25 bg-danger/10 text-danger-fg"
                    : "border-warning/30 bg-warning/10 text-warning-fg"
                } text-xs flex items-center gap-1`}
              >
                {permissionIcon(p.type)}
                {permissionLabel(p)}
                <span
                  className={`ml-1 px-1 rounded ${
                    ROLE_BADGE[p.role] ??
                    "border-border bg-muted text-muted-foreground"
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
        <p className="text-xs text-danger mt-2">
          Pick at least one category — revoke is disabled until you do.
        </p>
      )}
    </div>
  );
}
