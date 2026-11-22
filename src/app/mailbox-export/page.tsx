"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import {
  Download,
  Loader2,
  StopCircle,
  Info,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  tenantStateGeneration,
  tfetch,
  useCurrentTenant,
} from "@/lib/tenant-client";

/** Export-file format version. Bump if the line schema changes. */
const EXPORT_VERSION = 1;
const EXPORT_TYPE = "gws-mailbox-export";

interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

interface ExportedMessage {
  id: string;
  threadId: string;
  internalDate: string | null;
  labelIds: string[];
  sizeEstimate: number;
  raw: string;
}

interface ExportPage {
  user: string;
  messages: ExportedMessage[];
  nextPageToken: string | null;
  /** Unfetched ids from the current list page (byte budget hit) to send back. */
  pendingIds?: string[] | null;
  resultSizeEstimate: number | null;
  skipped?: Array<{ id: string; error: string }>;
  labels?: GmailLabel[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function downloadBlob(filename: string, parts: BlobPart[], type: string) {
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Released later, not straight after click(): some browsers only start
  // reading the blob after the click handler returns, and revoking it first
  // cancels a download that can be gigabytes long.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** asctime-style UTC date for an mbox "From " postmark (e.g. "Thu Jun 18 ..."). */
function mboxDate(internalDate: string | null): string {
  const ms = internalDate ? Number(internalDate) : NaN;
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const p2 = (n: number) => String(n).padStart(2, "0");
  const dom = String(d.getUTCDate()).padStart(2, " ");
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${dom} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ` +
    `${d.getUTCFullYear()}`
  );
}

/**
 * Turn one raw RFC 822 message (Gmail `format=raw`, base64url) into the bytes
 * of a single mbox entry: a "From " postmark line, the message body with
 * mboxrd ">From " escaping, and a trailing blank line so the next postmark
 * always begins a line. Throws if the base64 can't be decoded, so the caller
 * can skip that message instead of aborting the whole export.
 */
function mboxEntry(
  rawBase64Url: string,
  internalDate: string | null
): Uint8Array<ArrayBuffer> {
  let b64 = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  // atob yields a binary string (one char per byte). mboxrd escaping prefixes
  // ">" to any line of zero or more ">" followed by "From ", so a real "From "
  // line is never mistaken for a delimiter and the escaping reverses cleanly.
  const body = atob(b64).replace(/(^|\n)(>*From )/g, "$1>$2");

  const postmark = `From MAILER-DAEMON ${mboxDate(internalDate)}\n`;
  const trailer = body.endsWith("\n") ? "\n" : "\n\n";
  const entry = postmark + body + trailer;

  // Map the binary string straight to bytes. Building a Blob from the string
  // instead would UTF-8 re-encode bytes >= 128 and corrupt the message.
  const out = new Uint8Array(entry.length);
  for (let i = 0; i < entry.length; i++) out[i] = entry.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Why a run may not start with this tenant id, or null when it may. Every
 * request of a run is pinned to the id it started with, but a null pin sends
 * no tenant at all, and the server then uses whichever tenant is active in
 * its own settings. While the tenant list is still loading that is not
 * necessarily the tenant the page is about to show. Once the list has loaded
 * empty, null is right: the install runs on environment-variable credentials.
 */
async function tenantPinProblem(tenantId: string | null): Promise<string | null> {
  if (tenantId) return null;
  if (tenantStateGeneration() === 0) {
    return "The tenant list is still loading — try again in a moment.";
  }
  try {
    const r = await fetch("/api/tenants");
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d?.tenants) && d.tenants.length === 0) return null;
    }
  } catch {
    // Fall through: unknown is not "no tenants".
  }
  return "No tenant is selected — pick one in the sidebar first.";
}

/**
 * Where the export goes. In browsers with the File System Access API the
 * operator picks a file first and each page is written to it as it arrives,
 * so the mailbox never has to fit in memory. Elsewhere the pages are kept as
 * Blob segments and downloaded as one file at the end.
 */
interface OutputSink {
  kind: "disk" | "download";
  write(part: Blob): Promise<void>;
  /** Keep what was written; `partial` marks a stopped export in its name. */
  finish(partial: boolean): Promise<{ name: string; markedPartial: boolean }>;
  /** Throw away what was written. */
  discard(): Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
type ShowSaveFilePicker = (
  options?: SaveFilePickerOptions
) => Promise<FileSystemFileHandle>;

function saveFilePicker(): ShowSaveFilePicker | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { showSaveFilePicker?: ShowSaveFilePicker };
  return typeof w.showSaveFilePicker === "function"
    ? w.showSaveFilePicker.bind(window)
    : null;
}

const noSubscribe = () => () => {};

/** "mailbox.ndjson" → "mailbox-PARTIAL.ndjson". */
function partialName(name: string): string {
  return name.replace(/(\.[^./\\]+)?$/, "-PARTIAL$1");
}

function memorySink(baseName: string, ext: string, type: string): OutputSink {
  // Blob SEGMENTS, one per fetched page: a single giant string would hit
  // V8's string cap, and strings or byte arrays live in the JS heap, while
  // Blobs are managed by the browser's blob storage, which can spill to disk.
  let parts: Blob[] = [];
  return {
    kind: "download",
    async write(part) {
      parts.push(part);
    },
    async finish(partial) {
      const name = `${baseName}${partial ? "-PARTIAL" : ""}.${ext}`;
      downloadBlob(name, parts, type);
      parts = [];
      return { name, markedPartial: partial };
    },
    async discard() {
      parts = [];
    },
  };
}

function diskSink(
  handle: FileSystemFileHandle,
  writable: FileSystemWritableFileStream
): OutputSink {
  return {
    kind: "disk",
    async write(part) {
      await writable.write(part);
    },
    async finish(partial) {
      // The browser writes to a temporary file and only puts it in place on
      // close, so an export that stopped part-way has to be closed to be kept.
      await writable.close();
      if (!partial) return { name: handle.name, markedPartial: false };
      const renamed = partialName(handle.name);
      const movable = handle as unknown as {
        move?: (newName: string) => Promise<void>;
      };
      if (typeof movable.move === "function") {
        try {
          await movable.move(renamed);
          return { name: renamed, markedPartial: true };
        } catch {
          // Not every browser can rename a file it was handed; say so below.
        }
      }
      return { name: handle.name, markedPartial: false };
    },
    async discard() {
      await writable.abort().catch(() => {});
    },
  };
}

interface Summary {
  user: string;
  tenantName: string | null;
  exported: number;
  bytes: number;
  skipped: number;
  cancelled: boolean;
  /** Stopped on an error: the file holds only part of the mailbox. */
  failed: boolean;
  file: { name: string; markedPartial: boolean; kind: "disk" | "download" } | null;
}

export default function MailboxExport() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const canStreamToDisk = useSyncExternalStore(
    noSubscribe,
    () => saveFilePicker() !== null,
    () => false
  );

  const [user, setUser] = useState("");
  const [format, setFormat] = useState<"ndjson" | "mbox">("ndjson");
  const [includeSpamTrash, setIncludeSpamTrash] = useState(true);
  const [running, setRunning] = useState(false);
  // The tenant and file a running export is pinned to, for its panel: after
  // a tenant switch the page shows another tenant, but this run carries on
  // against the one it started with.
  const [runInfo, setRunInfo] = useState<{
    user: string;
    tenantName: string | null;
    fileName: string | null;
  } | null>(null);
  const cancelRef = useRef(false);
  // Aborts the page request in flight: cancelRef only stops the loop between
  // pages, and one page of large messages can take a while to fetch.
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors `running` for the tenant effect, which must leave a running
  // export's panel alone.
  const runningRef = useRef(false);
  // Tracks whether the component is still mounted. Navigating away mid-export
  // must stop the loop and skip the final download — otherwise the loop keeps
  // fetching invisibly and drops a surprise multi-GB file minutes later.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  const [progress, setProgress] = useState<{
    exported: number;
    bytes: number;
    estimate: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  // A result belongs to the tenant it was exported from: clear it when the
  // tenant changes. A running export is left alone — its requests are pinned
  // and its panel names its tenant.
  useEffect(() => {
    if (runningRef.current) return;
    setError(null);
    setSummary(null);
    setProgress(null);
    setRunInfo(null);
  }, [tenantId]);

  const runExport = async () => {
    const target = user.trim();
    if (!target || running || runningRef.current) return;
    setError(null);
    setSummary(null);

    const pinnedTenantId = tenantId;
    const pinnedTenantName = tenant?.name ?? null;
    const problem = await tenantPinProblem(pinnedTenantId);
    if (problem) {
      setError(problem);
      return;
    }

    // Pin the format for the whole walk so a change mid-export can't change
    // the output shape.
    const exportFormat = format;
    const ext = exportFormat === "mbox" ? "mbox" : "ndjson";
    const mime =
      exportFormat === "mbox"
        ? "application/mbox"
        : "application/x-ndjson;charset=utf-8";
    const baseName = `mailbox-${target.toLowerCase()}-${new Date()
      .toISOString()
      .slice(0, 10)}`;

    let sink: OutputSink | null = null;
    let chosenFile: string | null = null;
    const pick = saveFilePicker();
    if (pick) {
      let handle: FileSystemFileHandle | null = null;
      try {
        handle = await pick({
          suggestedName: `${baseName}.${ext}`,
          types: [
            {
              description:
                exportFormat === "mbox" ? "mbox mailbox" : "Mailbox export",
              accept: {
                [exportFormat === "mbox" ? "application/mbox" : "application/x-ndjson"]:
                  [`.${ext}`],
              },
            },
          ],
        });
      } catch (e) {
        // The operator closed the picker: they chose not to export.
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Anything else (a policy, an odd browser): keep the old behaviour.
      }
      if (handle) {
        try {
          sink = diskSink(handle, await handle.createWritable());
          chosenFile = handle.name;
        } catch {
          sink = null;
        }
      }
    }
    if (!alive.current) {
      await sink?.discard();
      return;
    }
    // The picker can stay open a while; a run must not start against a
    // tenant the page no longer shows.
    if (tenantIdRef.current !== pinnedTenantId) {
      await sink?.discard();
      setError("The tenant changed — start the export again.");
      return;
    }
    if (!sink) sink = memorySink(baseName, ext, mime);

    runningRef.current = true;
    setRunning(true);
    setRunInfo({
      user: target,
      tenantName: pinnedTenantName,
      fileName: sink.kind === "disk" ? chosenFile : null,
    });
    setProgress({ exported: 0, bytes: 0, estimate: null });
    cancelRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;

    // Set when the walk stopped on an error: the file is then partial, and
    // the summary must say so rather than "complete".
    let failure: string | null = null;
    let headerWritten = false;
    let exported = 0;
    let bytes = 0;
    let skipped = 0;
    let exportUser = target.toLowerCase();

    try {
      let pageToken: string | undefined;
      let pendingIds: string[] | undefined;
      while (true) {
        if (cancelRef.current || !alive.current) break;
        const url =
          `/api/admin/mailbox-export?user=${encodeURIComponent(target)}` +
          `&includeSpamTrash=${includeSpamTrash ? "true" : "false"}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") +
          (pendingIds && pendingIds.length
            ? `&pendingIds=${encodeURIComponent(pendingIds.join(","))}`
            : "");
        const res = await tfetch(url, { signal: ac.signal }, pinnedTenantId);
        let data;
        try {
          data = await res.json();
        } catch (e) {
          if (ac.signal.aborted) throw e;
          failure = `The server sent an unexpected response (HTTP ${res.status}).`;
          break;
        }
        if (!data?.success) {
          // Includes the server's 429 when other exports hold its slots.
          failure = data?.error || "Export failed";
          break;
        }
        const page: ExportPage = data.data;
        exportUser = page.user;

        // This page's output, sealed into one Blob segment below so the raw
        // strings/bytes don't accumulate in the JS heap across the whole walk.
        const pageParts: BlobPart[] = [];

        // mbox is a bare message stream — it carries no header or label set.
        if (exportFormat === "ndjson" && !headerWritten) {
          const headerLine = JSON.stringify({
            type: EXPORT_TYPE,
            version: EXPORT_VERSION,
            sourceUser: page.user,
            exportedAt: new Date().toISOString(),
            includeSpamTrash,
            labels: page.labels ?? [],
          });
          pageParts.push(headerLine, "\n");
          headerWritten = true;
          // +1 for the newline pushed after each line. Tracking emitted bytes
          // (here and below) keeps the reported size consistent with mbox and
          // close to the actual file.
          bytes += headerLine.length + 1;
        }

        let pageExported = 0;
        for (const m of page.messages) {
          if (exportFormat === "mbox") {
            // A message whose raw body won't decode can't be written to the
            // mbox; count it as skipped rather than aborting the export.
            try {
              const entry = mboxEntry(m.raw, m.internalDate);
              pageParts.push(entry);
              bytes += entry.length;
              pageExported++;
            } catch {
              skipped++;
            }
          } else {
            const line = JSON.stringify({
              id: m.id,
              threadId: m.threadId,
              internalDate: m.internalDate,
              labelIds: m.labelIds,
              sizeEstimate: m.sizeEstimate,
              raw: m.raw,
            });
            pageParts.push(line, "\n");
            pageExported++;
            bytes += line.length + 1;
          }
        }
        if (pageParts.length > 0) {
          try {
            await sink.write(new Blob(pageParts));
          } catch (e) {
            failure = `Couldn't write to the file: ${
              e instanceof Error ? e.message : String(e)
            }`;
            break;
          }
        }
        exported += pageExported;
        skipped += page.skipped?.length ?? 0;
        if (alive.current) {
          setProgress({ exported, bytes, estimate: page.resultSizeEstimate });
        }

        // Drain any unfetched ids from this list page first (byte budget hit),
        // then advance to the next list page. Stop only when both are exhausted.
        pendingIds = page.pendingIds ?? undefined;
        pageToken = page.nextPageToken ?? undefined;
        if (!pageToken && !(pendingIds && pendingIds.length)) break;
      }
    } catch {
      // An abort is the operator cancelling (or leaving the page): the pages
      // already captured are still kept below, as for a cancel between pages.
      if (!ac.signal.aborted) failure = "Failed to connect to the API";
    }

    runningRef.current = false;
    // If the user navigated away, don't drop a surprise download or push state
    // into an unmounted component — just stop.
    if (!alive.current) {
      await sink.discard();
      return;
    }
    const cancelled = failure === null && cancelRef.current;
    const partial = failure !== null || cancelled;

    // Keep whatever was captured — even on cancel or a mid-walk error, so a
    // partial backup isn't thrown away — and name it as partial.
    let file: Summary["file"] = null;
    if (exported > 0) {
      try {
        const kept = await sink.finish(partial);
        file = { ...kept, kind: sink.kind };
      } catch (e) {
        failure ??= `Couldn't finish writing the file: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    } else {
      await sink.discard();
    }

    setRunning(false);
    setError(failure);
    // Summarise every run, including an empty mailbox or an early cancel —
    // except a hard error before anything was captured, which the error
    // banner explains on its own.
    if (failure === null || exported > 0 || skipped > 0) {
      setSummary({
        user: exportUser,
        tenantName: pinnedTenantName,
        exported,
        bytes,
        skipped,
        cancelled,
        failed: failure !== null,
        file,
      });
    }
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const summaryWarn =
    !!summary && (summary.failed || summary.cancelled || summary.skipped > 0);
  const messages = (n: number) =>
    `${n.toLocaleString()} message${n === 1 ? "" : "s"}`;

  return (
    <>
      <PageHeader
        title="Mailbox Export"
        description="Back up a user's entire Gmail mailbox to a portable file. Choose full-fidelity NDJSON to restore later with Mailbox Import, or standard mbox to open in another mail client."
        badge="Gmail"
      />

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {summary && (
        <Alert variant={summaryWarn ? "warning" : "success"} className="mb-6">
          {summaryWarn ? <AlertTriangle /> : <CheckCircle2 />}
          <AlertDescription>
            {summary.failed
              ? `Export stopped — partial file (${messages(summary.exported)}, ≈${formatBytes(summary.bytes)}) from ${summary.user}`
              : summary.cancelled
                ? `Export cancelled — partial file (${messages(summary.exported)}, ≈${formatBytes(summary.bytes)}) from ${summary.user}`
                : `Export complete — saved ${messages(summary.exported)} (≈${formatBytes(summary.bytes)}) from ${summary.user}`}
            {summary.tenantName ? ` in ${summary.tenantName}` : ""}.
            {summary.file
              ? summary.file.kind === "disk"
                ? ` Saved as ${summary.file.name}.`
                : ` Downloaded as ${summary.file.name}.`
              : summary.exported === 0
                ? " No file was saved."
                : ""}
            {summary.file &&
            (summary.failed || summary.cancelled) &&
            !summary.file.markedPartial
              ? " Rename it so it isn't mistaken for a full backup."
              : ""}
            {summary.skipped > 0 &&
              ` ${messages(summary.skipped)} could not be exported (no raw content, or still unreachable after retries) and were left out.`}
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              Export a mailbox
            </CardTitle>
            <CardDescription>
              Walks every message in the mailbox 25 at a time and streams them
              into a single file. Read-only — nothing in the source mailbox is
              changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user">User Email</Label>
              <Input
                id="user"
                placeholder="user@yourdomain.com"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && !running && runExport()
                }
                disabled={running}
              />
            </div>

            <div className="space-y-2">
              <Label>Export format</Label>
              <Select
                value={format}
                onValueChange={(v) => {
                  if (v === "ndjson" || v === "mbox") setFormat(v);
                }}
                disabled={running}
                items={{
                  ndjson: "NDJSON — full-fidelity backup",
                  mbox: "mbox — portable to other mail clients",
                }}
              >
                <SelectTrigger className="w-full" aria-label="Export format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ndjson">
                    NDJSON — full-fidelity backup
                  </SelectItem>
                  <SelectItem value="mbox">
                    mbox — portable to other mail clients
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {format === "mbox"
                  ? "A standard mailbox file readable by Thunderbird, Apple Mail, and other clients, and convertible to PST. Does not preserve Gmail labels and can't be restored with Mailbox Import."
                  : "Preserves labels, threading, and dates alongside the raw MIME. Required to restore the backup with Mailbox Import."}
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSpamTrash}
                onChange={(e) => setIncludeSpamTrash(e.target.checked)}
                disabled={running}
              />
              Include Spam &amp; Trash (recommended for a complete backup)
            </label>

            <Alert variant="info">
              <Info className="h-4 w-4 text-info" />
              <AlertDescription>
                The export contains the full content of every email. Store the
                file somewhere secure.{" "}
                {canStreamToDisk
                  ? "Your browser asks where to save it first, then writes each batch of messages to that file as it arrives, so a large mailbox doesn't have to fit in memory."
                  : "In this browser the whole mailbox is held in memory until the download is assembled — for very large accounts, use a Chromium-based browser (which writes to disk as it goes) or a machine with ample RAM."}
              </AlertDescription>
            </Alert>

            <div className="flex items-center gap-3">
              {!running ? (
                <Button onClick={runExport} disabled={!user.trim()}>
                  <Download className="h-4 w-4 mr-1.5" />
                  Start export
                </Button>
              ) : (
                <Button variant="outline" onClick={cancel}>
                  <StopCircle className="h-4 w-4 mr-1.5" />
                  {runInfo?.fileName
                    ? "Cancel & keep what's saved"
                    : "Cancel & download what's gathered"}
                </Button>
              )}
              {running && progress && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Exported {progress.exported.toLocaleString()}
                  {progress.estimate
                    ? ` of ~${progress.estimate.toLocaleString()}`
                    : ""}{" "}
                  message{progress.exported === 1 ? "" : "s"} (≈
                  {formatBytes(progress.bytes)})
                </p>
              )}
            </div>
            {running && runInfo && (
              <p className="text-xs text-muted-foreground">
                Exporting {runInfo.user}
                {runInfo.tenantName ? ` from ${runInfo.tenantName}` : ""}
                {runInfo.fileName ? `, writing to ${runInfo.fileName}` : ""}.
                {runInfo.tenantName && tenant && tenant.name !== runInfo.tenantName
                  ? ` You have since switched to ${tenant.name}; this export carries on against ${runInfo.tenantName}.`
                  : ""}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
