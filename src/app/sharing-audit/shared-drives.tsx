"use client";

import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FolderTree,
  Loader2,
  PlayCircle,
  X,
} from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

/**
 * Shared drives, for the External Sharing Audit.
 *
 * The per-user audit on this page looks at files people own. A file in a
 * shared drive is owned by the drive, so that audit never sees it. This
 * section scans every shared drive instead: who outside the organisation is a
 * member of the drive, and which files inside are shared outside on top of
 * that. Read-only; it keeps its own state so the rest of the page is untouched.
 */

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
  external: ExternalPermission[];
}

interface DriveSummary {
  id: string;
  name: string;
  externalMembers: ExternalPermission[];
  memberCount: number;
  scanCandidates: string[];
  error: string | null;
}

interface DriveResult extends DriveSummary {
  /** null while waiting or scanning. */
  files: ExternalFile[] | null;
  scannedFiles: number;
  /** Who the files were read as. */
  scannedAs: string | null;
  /** Why the files could not be scanned, when they could not. */
  filesError: string | null;
  state: "waiting" | "scanning" | "done";
}

function permissionLabel(p: ExternalPermission): string {
  if (p.type === "anyone") {
    return p.allowFileDiscovery ? "Anyone (public, indexable)" : "Anyone with the link";
  }
  if (p.type === "domain") return `Everyone at ${p.target}`;
  return p.target;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function csvCell(c: string): string {
  let v = c ?? "";
  // File and drive names are text somebody else chose: keep a spreadsheet
  // from running one as a formula.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
}

function toCsv(drives: DriveResult[]): string {
  const rows: string[][] = [
    ["shared_drive", "kind", "file", "file_id", "link", "shared_with", "type", "role"],
  ];
  for (const d of drives) {
    for (const m of d.externalMembers) {
      rows.push([d.name, "drive member", "", d.id, "", permissionLabel(m), m.type, m.role]);
    }
    for (const f of d.files ?? []) {
      for (const p of f.external) {
        rows.push([
          d.name,
          "file",
          f.name,
          f.id,
          f.webViewLink ?? "",
          permissionLabel(p),
          p.type,
          p.role,
        ]);
      }
    }
  }
  return rows.map((r) => r.map((c) => `"${csvCell(c)}"`).join(",")).join("\n");
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

export function SharedDrivesAudit({ tenantId }: { tenantId: string | null }) {
  const [drives, setDrives] = useState<DriveResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const [stopped, setStopped] = useState<"cancelled" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  // One tenant's drives must never be shown as another's.
  useEffect(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setDrives([]);
    setScanning(false);
    setDone(false);
    setStopped(null);
    setError(null);
    setOpen(null);
  }, [tenantId]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const run = async () => {
    cancelRef.current = false;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const pinned = tenantId;
    const current = () => tenantIdRef.current === pinned;
    const patch = (id: string, change: Partial<DriveResult>) =>
      setDrives((prev) => prev.map((d) => (d.id === id ? { ...d, ...change } : d)));

    setDrives([]);
    setError(null);
    setDone(false);
    setStopped(null);
    setOpen(null);
    setScanning(true);

    try {
      // 1. Every shared drive and its members.
      const all: DriveSummary[] = [];
      let pageToken: string | null = null;
      do {
        const qs = new URLSearchParams();
        if (pageToken) qs.set("pageToken", pageToken);
        const res = await tfetch(
          `/api/admin/sharing-audit/shared-drives?${qs.toString()}`,
          { signal: ac.signal },
          pinned
        );
        const result = await res.json();
        if (!current()) return;
        if (!result.success) {
          setError(result.error || "The shared drives could not be listed");
          if (all.length > 0) {
            setStopped("failed");
            setDone(true);
          }
          return;
        }
        const page = result.data as { drives: DriveSummary[]; nextPageToken: string | null };
        all.push(...page.drives);
        setDrives((prev) => [
          ...prev,
          ...page.drives.map(
            (d): DriveResult => ({
              ...d,
              files: null,
              scannedFiles: 0,
              scannedAs: null,
              filesError: null,
              state: "waiting",
            })
          ),
        ]);
        pageToken = page.nextPageToken;
      } while (pageToken && !cancelRef.current);

      // 2. Each drive's files, one drive at a time.
      for (const d of all) {
        if (cancelRef.current) break;
        if (d.scanCandidates.length === 0) {
          patch(d.id, {
            state: "done",
            files: [],
            filesError: d.error
              ? "The drive's members could not be read, so there was no one to read its files as."
              : "None of this drive's members is an individual in your organisation, so there is no one to read its files as.",
          });
          continue;
        }
        patch(d.id, { state: "scanning" });
        const found: ExternalFile[] = [];
        let scanned = 0;
        let as: string[] = d.scanCandidates;
        let token: string | null = null;
        let failure: string | null = null;
        do {
          const qs = new URLSearchParams({ driveId: d.id, as: as.join(",") });
          if (token) qs.set("pageToken", token);
          const res = await tfetch(
            `/api/admin/sharing-audit/shared-drives/files?${qs.toString()}`,
            { signal: ac.signal },
            pinned
          );
          const result = await res.json();
          if (!current()) return;
          if (!result.success) {
            failure = result.error || "The drive's files could not be read";
            break;
          }
          const page = result.data as {
            user: string;
            scannedFiles: number;
            files: ExternalFile[];
            nextPageToken: string | null;
          };
          found.push(...page.files);
          scanned += page.scannedFiles;
          // Drive's page tokens belong to whoever was issued them.
          as = [page.user];
          token = page.nextPageToken;
          patch(d.id, { files: [...found], scannedFiles: scanned, scannedAs: page.user });
        } while (token && !cancelRef.current);
        patch(d.id, {
          state: "done",
          files: found,
          scannedFiles: scanned,
          filesError: failure,
        });
      }

      if (cancelRef.current) setStopped("cancelled");
      setDone(true);
    } catch {
      if (!current()) return;
      if (ac.signal.aborted) {
        if (cancelRef.current) {
          setStopped("cancelled");
          setDone(true);
        }
      } else {
        setError("Failed to connect to the API");
        setStopped("failed");
        setDone(true);
      }
    } finally {
      if (current()) setScanning(false);
    }
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const finished = drives.filter((d) => d.state === "done").length;
  const filesScanned = drives.reduce((n, d) => n + d.scannedFiles, 0);
  const externalMembers = drives.reduce((n, d) => n + d.externalMembers.length, 0);
  const externalFiles = drives.reduce((n, d) => n + (d.files?.length ?? 0), 0);
  const unread = drives.filter((d) => d.error || d.filesError).length;
  const flagged = drives.filter(
    (d) => d.externalMembers.length > 0 || (d.files?.length ?? 0) > 0
  );
  const started = scanning || done || drives.length > 0;

  const summary = () => {
    const state = scanning
      ? "Scanning…"
      : stopped === "cancelled"
        ? "Cancelled: results cover only part of the tenant."
        : stopped === "failed"
          ? "Stopped early: results cover only part of the tenant."
          : done
            ? "Complete."
            : "";
    return `${state} ${finished.toLocaleString()} of ${plural(drives.length, "shared drive")} · ${plural(filesScanned, "file")} checked`.trim();
  };

  return (
    <>
      <Card data-testid="shared-drives-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderTree className="h-5 w-5" />
            Audit shared drives
          </CardTitle>
          <CardDescription>
            The audits above look at files people own. Files in a shared drive
            belong to the drive, so they are checked here: who outside your
            organisation is a member of each drive, and which files inside are
            shared outside on top of that. Read-only. To change what it finds,
            use the drive&apos;s Manage members and each file&apos;s Share
            dialog in Google Drive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {scanning ? (
              <Button variant="secondary" onClick={cancel}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            ) : (
              <Button onClick={() => void run()}>
                <PlayCircle className="h-4 w-4" />
                {started ? "Scan again" : "Scan shared drives"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={scanning || externalMembers + externalFiles === 0}
              onClick={() =>
                downloadCsv(
                  `shared-drives-external-sharing-${new Date().toISOString().slice(0, 10)}.csv`,
                  toCsv(drives)
                )
              }
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </div>
          {error && (
            <p className="text-sm text-danger-fg break-words" role="alert">
              {error}
            </p>
          )}
          {started && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              data-testid="shared-drives-status"
            >
              {scanning && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{summary()}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {started && drives.length > 0 && (
        <Card data-testid="shared-drives-results">
          <CardHeader>
            <CardTitle>Shared drive results</CardTitle>
            <CardDescription>
              {plural(flagged.length, "drive")} with something shared outside:{" "}
              {plural(externalMembers, "outside member")} and{" "}
              {plural(externalFiles, "file")} shared outside.
              {unread > 0
                ? ` ${plural(unread, "drive")} could not be fully read, so these results don't cover ${unread === 1 ? "it" : "them"}.`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {drives.map((d) => {
              const isOpen = open === d.id;
              const fileCount = d.files?.length ?? 0;
              const clean =
                d.state === "done" &&
                d.externalMembers.length === 0 &&
                fileCount === 0 &&
                !d.error &&
                !d.filesError;
              return (
                <div key={d.id} className="rounded-lg border bg-muted/30">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : d.id)}
                    className="flex w-full items-start justify-between gap-3 p-3 text-left"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium break-all">{d.name}</p>
                        {d.externalMembers.length > 0 && (
                          <Badge variant="destructive">
                            {plural(d.externalMembers.length, "outside member")}
                          </Badge>
                        )}
                        {fileCount > 0 && (
                          <Badge variant="warning">
                            {plural(fileCount, "file")} shared outside
                          </Badge>
                        )}
                        {clean && <Badge variant="success">nothing outside</Badge>}
                        {(d.error || d.filesError) && (
                          <Badge variant="outline">
                            <AlertTriangle />
                            not fully read
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {d.state === "waiting"
                          ? "Waiting…"
                          : d.state === "scanning"
                            ? `Scanning… ${plural(d.scannedFiles, "file")} so far`
                            : `${plural(d.memberCount, "member")} · ${plural(d.scannedFiles, "file")} checked${
                                d.scannedAs ? ` as ${d.scannedAs}` : ""
                              }`}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center text-muted-foreground">
                      {d.state === "scanning" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="space-y-3 border-t px-3 py-3 text-xs">
                      {d.error && (
                        <p className="text-warning-fg break-words">
                          The drive&apos;s members could not be read: {d.error}
                        </p>
                      )}
                      {d.filesError && (
                        <p className="text-warning-fg break-words">
                          Its files were not checked. {d.filesError}
                        </p>
                      )}
                      <div>
                        <p className="font-medium">Members outside your organisation</p>
                        {d.externalMembers.length === 0 ? (
                          <p className="text-muted-foreground">None</p>
                        ) : (
                          <ul className="text-muted-foreground">
                            {d.externalMembers.map((m, i) => (
                              <li key={`${m.type}|${m.target}|${i}`} className="break-all">
                                {permissionLabel(m)}{" "}
                                <span className="text-foreground">({m.role})</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <p className="font-medium">Files shared outside, beyond the members</p>
                        {fileCount === 0 ? (
                          <p className="text-muted-foreground">
                            {d.state === "done" && !d.filesError ? "None" : "Not known"}
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            {(d.files ?? []).map((f) => (
                              <li key={f.id}>
                                {f.webViewLink ? (
                                  <a
                                    href={f.webViewLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-medium underline underline-offset-2 break-all"
                                  >
                                    {f.name}
                                  </a>
                                ) : (
                                  <span className="font-medium break-all">{f.name}</span>
                                )}
                                <span className="block text-muted-foreground break-all">
                                  {f.external
                                    .map((p) => `${permissionLabel(p)} (${p.role})`)
                                    .join(" · ")}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {done && !scanning && drives.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">This tenant has no shared drives.</p>
      )}
    </>
  );
}
