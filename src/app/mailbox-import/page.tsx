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
  Upload,
  Loader2,
  StopCircle,
  AlertTriangle,
  CheckCircle2,
  FileUp,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

const EXPORT_TYPE = "gws-mailbox-export";

// Mirror the server batch cap, and bound each request by cumulative raw size
// so a batch of large messages never blows the import body limit.
const IMPORT_BATCH_COUNT = 25;
const IMPORT_BATCH_BYTES = 20 * 1024 * 1024;

interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

interface ExportHeader {
  type: string;
  version: number;
  sourceUser: string;
  exportedAt?: string;
  labels: GmailLabel[];
}

interface ExportedMessage {
  raw: string;
  labelIds?: string[];
}

interface BatchOutcome {
  inserted: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
}

/** Async line iterator over a File, memory-bounded via the streams API. */
async function* readLines(file: File): AsyncGenerator<string> {
  const reader = file
    .stream()
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** Read just the first line of a file (the export header) without a full pass. */
async function readHeaderLine(file: File): Promise<string> {
  // Headers are small; 5 MB is far more than enough even for thousands of
  // labels, and avoids decoding a multi-GB file just to read line one.
  const slice = file.slice(0, 5 * 1024 * 1024);
  const text = await slice.text();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

export default function MailboxImport() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [targetUser, setTargetUser] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [header, setHeader] = useState<ExportHeader | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

  const [progress, setProgress] = useState<{
    inserted: number;
    failed: number;
  } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<{
    inserted: number;
    failed: number;
    cancelled: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validTarget = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(targetUser.trim());

  const onPickFile = async (f: File | null) => {
    setFile(f);
    setHeader(null);
    setParseError(null);
    setSummary(null);
    setError(null);
    setErrors([]);
    if (!f) return;
    try {
      const line = await readHeaderLine(f);
      const parsed = JSON.parse(line) as ExportHeader;
      if (parsed.type !== EXPORT_TYPE) {
        setParseError(
          "This file isn't a mailbox export — its header is missing or unrecognised."
        );
        return;
      }
      setHeader({
        type: parsed.type,
        version: parsed.version,
        sourceUser: parsed.sourceUser,
        exportedAt: parsed.exportedAt,
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      });
    } catch {
      setParseError(
        "Couldn't read the export header. Make sure you selected a .ndjson file produced by Mailbox Export."
      );
    }
  };

  const runImport = async () => {
    if (!file || !header || !validTarget) return;
    setConfirmOpen(false);
    setRunning(true);
    setError(null);
    setErrors([]);
    setSummary(null);
    setProgress({ inserted: 0, failed: 0 });
    cancelRef.current = false;
    const pinnedTenantId = tenantId;
    const user = targetUser.trim();

    let inserted = 0;
    let failed = 0;
    const collectedErrors: string[] = [];

    try {
      // Step 1: recreate labels in the target mailbox and get the id map.
      const labelRes = await tfetch(
        "/api/admin/mailbox-import/labels",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, labels: header.labels }),
        },
        pinnedTenantId
      );
      const labelData = await labelRes.json();
      if (!labelData.success) {
        setError(labelData.error || "Failed to prepare labels");
        setRunning(false);
        return;
      }
      const labelMap: Record<string, string> = labelData.data?.map ?? {};

      // Step 2: stream the file and insert messages in size-bounded batches.
      let batch: ExportedMessage[] = [];
      let batchBytes = 0;
      let lineNo = 0;

      const flush = async () => {
        if (batch.length === 0) return true;
        const res = await tfetch(
          "/api/admin/mailbox-import",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user, messages: batch }),
          },
          pinnedTenantId
        );
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Import batch failed");
          return false;
        }
        const out: BatchOutcome = data.data;
        inserted += out.inserted;
        failed += out.failed;
        for (const e of out.errors) {
          if (collectedErrors.length < 50) collectedErrors.push(e.message);
        }
        setProgress({ inserted, failed });
        batch = [];
        batchBytes = 0;
        return true;
      };

      for await (const line of readLines(file)) {
        lineNo++;
        if (lineNo === 1) continue; // header line, already parsed
        if (cancelRef.current) break;
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: ExportedMessage;
        try {
          msg = JSON.parse(trimmed) as ExportedMessage;
        } catch {
          failed++;
          if (collectedErrors.length < 50) {
            collectedErrors.push(`Line ${lineNo}: not valid JSON — skipped`);
          }
          setProgress({ inserted, failed });
          continue;
        }
        if (typeof msg.raw !== "string" || !msg.raw) continue;

        // Remap label IDs from the source mailbox to the target. Unknown IDs
        // (e.g. stable system labels) pass through unchanged.
        const labelIds = Array.isArray(msg.labelIds)
          ? msg.labelIds.map((id) => labelMap[id] ?? id)
          : undefined;

        batch.push({ raw: msg.raw, labelIds });
        batchBytes += msg.raw.length;

        if (batch.length >= IMPORT_BATCH_COUNT || batchBytes >= IMPORT_BATCH_BYTES) {
          const ok = await flush();
          if (!ok) {
            setRunning(false);
            setErrors(collectedErrors);
            return;
          }
        }
      }

      if (!cancelRef.current) {
        const ok = await flush();
        if (!ok) {
          setRunning(false);
          setErrors(collectedErrors);
          return;
        }
      }

      setSummary({ inserted, failed, cancelled: cancelRef.current });
      setErrors(collectedErrors);
    } catch {
      setError("Failed to connect to the API. Some messages may have imported.");
      setErrors(collectedErrors);
    } finally {
      setRunning(false);
    }
  };

  const cancel = () => {
    cancelRef.current = true;
  };

  return (
    <>
      <PageHeader
        title="Mailbox Import"
        description="Restore a mailbox export into another user's Gmail. Messages are inserted with their original dates and labels recreated by name."
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
        <Alert className="mb-6 border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <AlertDescription className="text-emerald-800 dark:text-emerald-300 text-sm">
            {summary.cancelled ? "Import cancelled — " : "Import complete — "}
            inserted {summary.inserted.toLocaleString()} message
            {summary.inserted === 1 ? "" : "s"}
            {summary.failed > 0
              ? `, ${summary.failed.toLocaleString()} failed`
              : ""}{" "}
            into {targetUser.trim()}.
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Restore an export
            </CardTitle>
            <CardDescription>
              Select a <code>.ndjson</code> file from Mailbox Export and choose
              the mailbox to restore it into. Messages are added directly via
              IMAP-style insert — no re-delivery, no spam reclassification.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="target">Target User</Label>
              <Input
                id="target"
                placeholder="restore-into@yourdomain.com"
                value={targetUser}
                onChange={(e) => setTargetUser(e.target.value)}
                disabled={running}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="file">Export file</Label>
              <input
                ref={fileInputRef}
                id="file"
                type="file"
                accept=".ndjson,application/x-ndjson,application/json,.json"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                disabled={running}
              />
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={running}
                >
                  <FileUp className="h-4 w-4 mr-1.5" />
                  Choose file
                </Button>
                {file && (
                  <span className="text-xs text-muted-foreground truncate">
                    {file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)
                  </span>
                )}
              </div>
            </div>

            {parseError && (
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                  {parseError}
                </AlertDescription>
              </Alert>
            )}

            {header && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">Source mailbox:</span>{" "}
                  <span className="font-medium">{header.sourceUser}</span>
                </p>
                {header.exportedAt && (
                  <p>
                    <span className="text-muted-foreground">Exported:</span>{" "}
                    {new Date(header.exportedAt).toLocaleString()}
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Labels in export:</span>{" "}
                  {header.labels.length}
                </p>
              </div>
            )}

            <Alert className="border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
                Importing is not idempotent — running it twice inserts duplicate
                copies of every message. Import into a fresh or intended mailbox,
                and only once.
              </AlertDescription>
            </Alert>

            <div className="flex items-center gap-3">
              {!running ? (
                <Button
                  onClick={() => {
                    setSummary(null);
                    setConfirmOpen(true);
                  }}
                  disabled={!file || !header || !validTarget}
                >
                  <Upload className="h-4 w-4 mr-1.5" />
                  Review &amp; Import
                </Button>
              ) : (
                <Button variant="outline" onClick={cancel}>
                  <StopCircle className="h-4 w-4 mr-1.5" />
                  Cancel
                </Button>
              )}
              {running && progress && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Imported {progress.inserted.toLocaleString()} message
                  {progress.inserted === 1 ? "" : "s"}
                  {progress.failed > 0
                    ? ` · ${progress.failed.toLocaleString()} failed`
                    : ""}
                </p>
              )}
            </div>

            {errors.length > 0 && (
              <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-medium">
                  {errors.length} message error
                  {errors.length === 1 ? "" : "s"} (first {Math.min(errors.length, 50)} shown):
                </p>
                <ul className="list-disc pl-4 space-y-0.5 max-h-40 overflow-y-auto">
                  {errors.map((e, i) => (
                    <li key={i} className="break-words">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {header && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => !running && setConfirmOpen(o)}
          title="Import mailbox into target"
          summary={`Insert every message from ${header.sourceUser}'s export into ${targetUser.trim()}.`}
          tenant={
            tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
          }
          severity="high"
          confirmPhrase={targetUser.trim()}
          confirmLabel="Import mailbox"
          busy={running}
          changes={[
            { label: "Source export", after: header.sourceUser },
            { label: "Target mailbox (messages inserted here)", after: targetUser.trim(), emphasis: true },
            { label: "Labels", after: `${header.labels.length} recreated by name` },
            { label: "Message dates", after: "Preserved from each message's Date header" },
          ]}
          warnings={
            <span>
              This <strong>adds</strong> messages to {targetUser.trim()} — it
              never deletes existing mail, but re-running will create duplicates.
              Inserted messages are not re-delivered and won&apos;t notify
              anyone.
            </span>
          }
          onConfirm={runImport}
        />
      )}
    </>
  );
}
