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
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

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
  URL.revokeObjectURL(url);
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

export default function MailboxExport() {
  const { id: tenantId } = useCurrentTenant();

  const [user, setUser] = useState("");
  const [format, setFormat] = useState<"ndjson" | "mbox">("ndjson");
  const [includeSpamTrash, setIncludeSpamTrash] = useState(true);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  // Tracks whether the component is still mounted. Navigating away mid-export
  // must stop the loop and skip the final download — otherwise the loop keeps
  // fetching invisibly and drops a surprise multi-GB file minutes later.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelRef.current = true;
    };
  }, []);

  const [progress, setProgress] = useState<{
    exported: number;
    bytes: number;
    estimate: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    user: string;
    exported: number;
    bytes: number;
    skipped: number;
    cancelled: boolean;
  } | null>(null);

  const runExport = async () => {
    if (!user.trim() || running) return;
    setRunning(true);
    setError(null);
    setSummary(null);
    setProgress({ exported: 0, bytes: 0, estimate: null });
    cancelRef.current = false;
    // Pin the tenant and format for the whole walk so a switch mid-export can't
    // redirect later pages to a different tenant or change the output shape.
    const pinnedTenantId = tenantId;
    const exportFormat = format;

    // Accumulate the output as Blob parts so the file is never materialised as
    // one giant string — past V8's ~512 MB string cap that would throw "Invalid
    // string length" and destroy a large export. NDJSON pushes each JSON line
    // plus its newline (line 1 is a header with the source user + labels); mbox
    // pushes each message's "From "-delimited bytes.
    const parts: BlobPart[] = [];
    let headerWritten = false;
    let exported = 0;
    let bytes = 0;
    let skipped = 0;
    let exportUser = user.trim().toLowerCase();

    try {
      let pageToken: string | undefined;
      let pendingIds: string[] | undefined;
      while (true) {
        if (cancelRef.current || !alive.current) break;
        const url =
          `/api/admin/mailbox-export?user=${encodeURIComponent(user.trim())}` +
          `&includeSpamTrash=${includeSpamTrash ? "true" : "false"}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") +
          (pendingIds && pendingIds.length
            ? `&pendingIds=${encodeURIComponent(pendingIds.join(","))}`
            : "");
        const res = await tfetch(url, {}, pinnedTenantId);
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Export failed");
          break;
        }
        const page: ExportPage = data.data;
        exportUser = page.user;

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
          parts.push(headerLine, "\n");
          headerWritten = true;
          // +1 for the newline pushed after each line. Tracking emitted bytes
          // (here and below) keeps the reported size consistent with mbox and
          // close to the actual downloaded file.
          bytes += headerLine.length + 1;
        }

        for (const m of page.messages) {
          if (exportFormat === "mbox") {
            // A message whose raw body won't decode can't be written to the
            // mbox; count it as skipped rather than aborting the export.
            try {
              const entry = mboxEntry(m.raw, m.internalDate);
              parts.push(entry);
              bytes += entry.length;
              exported++;
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
            parts.push(line, "\n");
            exported++;
            bytes += line.length + 1;
          }
        }
        skipped += page.skipped?.length ?? 0;
        setProgress({
          exported,
          bytes,
          estimate: page.resultSizeEstimate,
        });

        // Drain any unfetched ids from this list page first (byte budget hit),
        // then advance to the next list page. Stop only when both are exhausted.
        pendingIds = page.pendingIds ?? undefined;
        pageToken = page.nextPageToken ?? undefined;
        if (!pageToken && !(pendingIds && pendingIds.length)) break;
      }
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setRunning(false);
      // If the user navigated away, don't drop a surprise download or push state
      // into an unmounted component — just stop.
      if (!alive.current) return;
      // Download whenever we captured at least one message — even on cancel or
      // a mid-walk error, so partial backups aren't thrown away. Still show a
      // summary when nothing was captured but messages were skipped, so a fully
      // failed run isn't silent.
      if (exported > 0 || skipped > 0) {
        if (exported > 0) {
          const date = new Date().toISOString().slice(0, 10);
          if (exportFormat === "mbox") {
            downloadBlob(
              `mailbox-${exportUser}-${date}.mbox`,
              parts,
              "application/mbox"
            );
          } else {
            downloadBlob(
              `mailbox-${exportUser}-${date}.ndjson`,
              parts,
              "application/x-ndjson;charset=utf-8"
            );
          }
        }
        setSummary({
          user: exportUser,
          exported,
          bytes,
          skipped,
          cancelled: cancelRef.current,
        });
      }
    }
  };

  const cancel = () => {
    cancelRef.current = true;
  };

  return (
    <>
      <PageHeader
        title="Mailbox Export"
        description="Back up a user's entire Gmail mailbox to a portable file. Choose full-fidelity NDJSON to restore later with Mailbox Import, or standard mbox to open in another mail client."
        badge="Gmail"
      />

      {error && (
        <Alert className="mb-6 border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
          <AlertDescription className="text-red-800 dark:text-red-300">
            {error}
          </AlertDescription>
        </Alert>
      )}

      {summary && (
        <Alert
          className={`mb-6 ${
            summary.skipped > 0
              ? "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40"
              : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
          }`}
        >
          {summary.skipped > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          )}
          <AlertDescription
            className={`text-sm ${
              summary.skipped > 0
                ? "text-amber-800 dark:text-amber-300"
                : "text-emerald-800 dark:text-emerald-300"
            }`}
          >
            {summary.cancelled ? "Export cancelled — " : "Export complete — "}
            saved {summary.exported.toLocaleString()} message
            {summary.exported === 1 ? "" : "s"} (≈{formatBytes(summary.bytes)})
            from {summary.user}.
            {summary.exported > 0 ? " The file has been downloaded." : ""}
            {summary.skipped > 0 &&
              ` ${summary.skipped.toLocaleString()} message${
                summary.skipped === 1 ? "" : "s"
              } could not be exported (no raw content, or still unreachable after retries) and were left out.`}
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Download className="h-5 w-5" />
              Export a mailbox
            </CardTitle>
            <CardDescription>
              Walks every message in the mailbox 25 at a time and streams them
              into a single file in your browser. Read-only — nothing in the
              source mailbox is changed.
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

            <Alert className="border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/40">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 dark:text-blue-300 text-sm">
                The export contains the full content of every email. Store the
                downloaded file somewhere secure. Large mailboxes are held in
                browser memory until the download is assembled — for very large
                accounts, run the export on a machine with ample RAM.
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
                  Cancel &amp; download what&apos;s gathered
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
          </CardContent>
        </Card>
      </div>
    </>
  );
}
