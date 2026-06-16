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

function downloadNdjson(filename: string, lines: string[]) {
  // Each line is already a JSON string; join with newlines into one Blob.
  const blob = new Blob([lines.join("\n") + "\n"], {
    type: "application/x-ndjson;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function MailboxExport() {
  const { id: tenantId } = useCurrentTenant();

  const [user, setUser] = useState("");
  const [includeSpamTrash, setIncludeSpamTrash] = useState(true);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

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
    // Pin the tenant for the whole walk so a switch mid-export can't redirect
    // later pages to a different tenant.
    const pinnedTenantId = tenantId;

    // Accumulate NDJSON lines. Line 1 is a header (source user + labels);
    // every subsequent line is one message.
    const lines: string[] = [];
    let exported = 0;
    let bytes = 0;
    let skipped = 0;
    let exportUser = user.trim().toLowerCase();

    try {
      let pageToken: string | undefined;
      while (true) {
        if (cancelRef.current) break;
        const url =
          `/api/admin/mailbox-export?user=${encodeURIComponent(user.trim())}` +
          `&includeSpamTrash=${includeSpamTrash ? "true" : "false"}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await tfetch(url, {}, pinnedTenantId);
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Export failed");
          break;
        }
        const page: ExportPage = data.data;
        exportUser = page.user;

        if (lines.length === 0) {
          lines.push(
            JSON.stringify({
              type: EXPORT_TYPE,
              version: EXPORT_VERSION,
              sourceUser: page.user,
              exportedAt: new Date().toISOString(),
              includeSpamTrash,
              labels: page.labels ?? [],
            })
          );
        }

        for (const m of page.messages) {
          lines.push(
            JSON.stringify({
              id: m.id,
              threadId: m.threadId,
              internalDate: m.internalDate,
              labelIds: m.labelIds,
              sizeEstimate: m.sizeEstimate,
              raw: m.raw,
            })
          );
          exported++;
          bytes += m.raw.length;
        }
        skipped += page.skipped?.length ?? 0;
        setProgress({
          exported,
          bytes,
          estimate: page.resultSizeEstimate,
        });

        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setRunning(false);
      // Download whenever we captured at least one message — even on cancel or
      // a mid-walk error, so partial backups aren't thrown away. Still show a
      // summary when nothing was captured but messages were skipped, so a fully
      // failed run isn't silent.
      if (exported > 0 || skipped > 0) {
        if (exported > 0) {
          const date = new Date().toISOString().slice(0, 10);
          downloadNdjson(`mailbox-${exportUser}-${date}.ndjson`, lines);
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
        description="Back up a user's entire Gmail mailbox to a portable file. Every message is saved as its raw MIME blob with labels and dates preserved, ready to restore with Mailbox Import."
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
              } could not be fetched after retries and were left out — re-run the export to try them again.`}
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
              into a single <code>.ndjson</code> file in your browser. Read-only
              — nothing in the source mailbox is changed.
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
