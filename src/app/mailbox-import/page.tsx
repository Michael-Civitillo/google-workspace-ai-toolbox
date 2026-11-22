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
import { PageHeader } from "@/components/page-header";
import {
  Upload,
  Loader2,
  StopCircle,
  AlertTriangle,
  CheckCircle2,
  FileUp,
  RotateCcw,
} from "lucide-react";
import {
  tenantStateGeneration,
  tfetch,
  useCurrentTenant,
} from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

const EXPORT_TYPE = "gws-mailbox-export";
/** The export format this page reads (Mailbox Export's EXPORT_VERSION). */
const SUPPORTED_EXPORT_VERSION = 1;

// Mirror the server batch cap (MAILBOX_IMPORT_BATCH_CAP), and bound each
// request's cumulative raw size well under the server body cap (80 MB) so a
// multi-message batch plus JSON overhead never trips the limit. A single
// message larger than this budget is sent on its own (it can still be up to
// ~72 MB, which fits under the body cap).
const IMPORT_BATCH_COUNT = 25;
// 8 MB per batch keeps the server-side peak (the body, its parsed copy and
// the re-serialised inserts) around 40 MB instead of 100 MB.
const IMPORT_BATCH_BYTES = 8 * 1024 * 1024;
// The label route takes at most 8 MB, so a longer header could not be sent
// anyway; reading further would only fill memory with a file that is not an
// export (a binary file has no newline to stop at).
const HEADER_MAX_CHARS = 8 * 1024 * 1024;
// Above the largest message the server accepts (~72 MB of base64 plus JSON).
const MESSAGE_LINE_MAX_CHARS = 80 * 1024 * 1024;

/**
 * Waits between attempts at one batch. Only failures that provably stored
 * nothing are simply sent again: the server's 429 (another import holds the
 * slot; refused before the body is read) and its own 5xx answers (the route
 * only fails that way before the first insert). See `deliverBatch` for a
 * dropped connection, whose outcome is unknown.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];
/**
 * After a dropped connection the server may still be finishing the batch
 * (it stops between messages once it notices the caller left). Look in the
 * audit log this many times, this far apart, before concluding it has no
 * record of the batch.
 */
const LOST_CHECK_DELAYS_MS = [10_000, 15_000, 20_000, 30_000];
/** The same check after Cancel: the batch in flight stops within seconds. */
const CANCEL_CHECK_DELAYS_MS = [3_000, 5_000, 7_000];

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
  /** Label entries in the header that were not { id, name } and are skipped. */
  badLabels: number;
}

/** One message line, ready to send, and the file line it came from. */
interface PendingMessage {
  line: number;
  raw: string;
  labelIds?: string[];
}

interface BatchOutcome {
  inserted: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
  /**
   * Indexes of messages Gmail refused with their labels and accepted without
   * them. Counted in `inserted`, but they carry none of their labels — not
   * even Inbox or Unread.
   */
  insertedWithoutLabels?: number[];
}

/** Labels the target mailbox could not match or create. */
interface UnmappedLabels {
  count: number;
  names: string[];
}

/** How many messages of a batch were stored without their labels. */
function countWithoutLabels(value: unknown): number {
  if (Array.isArray(value)) return value.filter((i) => Number.isInteger(i)).length;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** A line the reader had to give up on: longer than it may be. */
const LINE_TOO_LONG = Symbol("LINE_TOO_LONG");

/**
 * Async line iterator over a File, memory-bounded via the streams API.
 *
 * Each decoded chunk is scanned once from where the last line ended, and the
 * pieces of a line are joined once when its newline arrives — appending to
 * one string and searching it from the start on every chunk made a long line
 * (a message with attachments is tens of MB) cost time quadratic in its
 * length. A line longer than `maxLineChars` is dropped as it streams past and
 * reported as LINE_TOO_LONG, so a file with no newlines cannot fill memory.
 */
async function* readLines(
  file: File,
  opts: { signal?: AbortSignal; maxLineChars: number }
): AsyncGenerator<string | typeof LINE_TOO_LONG> {
  const reader = file
    .stream()
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let pieces: string[] = [];
  let pendingChars = 0;
  let overlong = false;
  try {
    while (true) {
      if (opts.signal?.aborted) {
        throw new DOMException("The read was superseded", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      let nl: number;
      while ((nl = value.indexOf("\n", start)) !== -1) {
        if (overlong) {
          yield LINE_TOO_LONG;
        } else {
          pieces.push(value.slice(start, nl));
          yield pieces.length === 1 ? pieces[0] : pieces.join("");
        }
        pieces = [];
        pendingChars = 0;
        overlong = false;
        start = nl + 1;
      }
      if (start < value.length && !overlong) {
        const rest = start === 0 ? value : value.slice(start);
        pendingChars += rest.length;
        if (pendingChars > opts.maxLineChars) {
          overlong = true;
          pieces = [];
        } else {
          pieces.push(rest);
        }
      }
    }
    if (overlong) yield LINE_TOO_LONG;
    else if (pieces.length > 0) yield pieces.join("");
  } finally {
    // cancel() both aborts the underlying stream (when we break early, e.g. on
    // reading only the header) and releases the reader lock — leaving the File
    // stream pipeline closed rather than dangling.
    await reader.cancel().catch(() => {});
  }
}

const NOT_AN_EXPORT =
  "This file isn't a mailbox export — its header is missing or unrecognised.";

/** Read and check the export header (the first line). */
async function readHeader(
  file: File,
  signal: AbortSignal
): Promise<{ header: ExportHeader } | { error: string }> {
  let line: string | typeof LINE_TOO_LONG | null = null;
  for await (const l of readLines(file, { signal, maxLineChars: HEADER_MAX_CHARS })) {
    line = l;
    break;
  }
  if (line === LINE_TOO_LONG) {
    return {
      error: `${NOT_AN_EXPORT} Its first line is longer than any export header.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line ?? "");
  } catch {
    return {
      error:
        "Couldn't read the export header. Make sure you selected a .ndjson file produced by Mailbox Export.",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: NOT_AN_EXPORT };
  }
  const h = parsed as Record<string, unknown>;
  if (h.type !== EXPORT_TYPE) return { error: NOT_AN_EXPORT };
  if (h.version !== SUPPORTED_EXPORT_VERSION) {
    return {
      error: `This export uses format version ${JSON.stringify(h.version ?? null)}, and this page reads version ${SUPPORTED_EXPORT_VERSION}. Import it with the Open Admin version that made it.`,
    };
  }
  if (typeof h.sourceUser !== "string" || !h.sourceUser.trim()) {
    return { error: "The export header doesn't say which mailbox it came from." };
  }
  const labels: GmailLabel[] = [];
  let badLabels = 0;
  for (const raw of Array.isArray(h.labels) ? h.labels : []) {
    const l = (raw ?? {}) as Record<string, unknown>;
    if (typeof l.id === "string" && l.id && typeof l.name === "string") {
      labels.push({
        id: l.id,
        name: l.name,
        type: typeof l.type === "string" ? l.type : "user",
      });
    } else {
      badLabels++;
    }
  }
  const exportedAt =
    typeof h.exportedAt === "string" && !Number.isNaN(Date.parse(h.exportedAt))
      ? h.exportedAt
      : undefined;
  return {
    header: {
      type: EXPORT_TYPE,
      version: SUPPORTED_EXPORT_VERSION,
      sourceUser: h.sourceUser.trim(),
      exportedAt,
      labels,
      badLabels,
    },
  };
}

/** A message line from the export, or why it can't be imported. */
function parseMessageLine(
  text: string
): { raw: string; labelIds?: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "not a message" };
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.raw !== "string" || !m.raw) {
    return { error: "message has no raw content" };
  }
  return {
    raw: m.raw,
    labelIds: Array.isArray(m.labelIds)
      ? m.labelIds.filter((id): id is string => typeof id === "string")
      : undefined,
  };
}

/**
 * Where an import of one file into one mailbox has got to, kept in this
 * browser so a stopped import can resume instead of being run again from the
 * top (messages.insert has no way to recognise a message it already stored,
 * so a re-run duplicates everything).
 */
interface ImportProgress {
  /** First file line not yet handled (line 1 is the header). */
  nextLine: number;
  /** Lines at or after nextLine already inserted (part of a cut-short batch). */
  skipLines: number[];
  /** Totals over every run of this import. */
  inserted: number;
  failed: number;
  /** Of `inserted`, how many were stored without their labels. */
  withoutLabels?: number;
  /** A batch that was sent and never confirmed: some of it may be stored. */
  inFlight: { from: number; to: number; count: number } | null;
  complete: boolean;
  updatedAt: string;
}

const PROGRESS_STORAGE_KEY = "open-admin.mailbox-import-progress.v1";
const PROGRESS_KEEP = 20;

function fileKey(file: File, header: ExportHeader): string {
  return [
    file.name,
    file.size,
    file.lastModified,
    header.sourceUser.toLowerCase(),
    header.exportedAt ?? "",
  ].join("|");
}

function progressKey(tenantId: string | null, target: string, fKey: string) {
  return `${tenantId ?? "-"}|${target.toLowerCase()}|${fKey}`;
}

function loadProgressStore(): Record<string, ImportProgress> {
  try {
    const raw = window.localStorage.getItem(PROGRESS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ImportProgress>)
      : {};
  } catch {
    return {};
  }
}

function saveProgress(key: string, value: ImportProgress | null) {
  try {
    const store = loadProgressStore();
    if (value) store[key] = value;
    else delete store[key];
    // Keep the newest few: old finished imports are only a reminder.
    const keys = Object.keys(store).sort((a, b) =>
      (store[b].updatedAt ?? "").localeCompare(store[a].updatedAt ?? "")
    );
    for (const k of keys.slice(PROGRESS_KEEP)) delete store[k];
    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage blocked or full: the run still works, it just can't be resumed
    // from another visit.
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const isAbort = (e: unknown) =>
  e instanceof DOMException && e.name === "AbortError";

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

interface AuditEntry {
  ts?: string;
  action?: string;
  tenantId?: string | null;
  params?: Record<string, unknown>;
}

/**
 * The `mailbox_import.batch` audit entries for this mailbox since `fromIso`:
 * how many, and the newest. Every batch the server accepts writes exactly one
 * (a 429 writes none), which is how a batch whose answer was lost is matched
 * to what the server did with it.
 */
async function countBatchEntries(opts: {
  tenantId: string | null;
  target: string;
  fromIso: string;
  signal: AbortSignal;
}): Promise<{ count: number; newest: AuditEntry | null }> {
  let cursor: string | null = null;
  let count = 0;
  let newest: AuditEntry | null = null;
  for (let i = 0; i < 60; i++) {
    const qs = new URLSearchParams({
      action: "mailbox_import.batch",
      from: opts.fromIso,
      limit: "500",
    });
    if (opts.tenantId) qs.set("tenantId", opts.tenantId);
    if (cursor) qs.set("cursor", cursor);
    const res = await tfetch(
      `/api/admin/audit-log?${qs.toString()}`,
      { signal: opts.signal },
      opts.tenantId
    );
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || "Audit log unavailable");
    if (data.data.restarted) {
      // The log rotated mid-count and the walk started again from the top.
      count = 0;
      newest = null;
    }
    for (const e of data.data.entries as AuditEntry[]) {
      if (e?.action !== "mailbox_import.batch") continue;
      if ((e.tenantId ?? null) !== opts.tenantId) continue;
      const user = e.params?.user;
      if (typeof user !== "string" || user.toLowerCase() !== opts.target) continue;
      if (!newest) newest = e;
      count++;
    }
    if (data.data.done) return { count, newest };
    cursor = data.data.nextCursor;
    if (!cursor) return { count, newest };
  }
  throw new Error("The audit log is too long to count");
}

/** What one POST of a batch came back with. */
type Attempt =
  | { kind: "ok"; outcome: BatchOutcome }
  /** 429: another import holds the server's slot; nothing was read. */
  | { kind: "busy"; message: string }
  /** The route's own 5xx: it fails that way only before the first insert. */
  | { kind: "server"; message: string }
  /** Any other refusal (bad input, unknown tenant, too large): won't succeed. */
  | { kind: "refused"; message: string }
  /** No usable answer: the connection dropped, or the reply was not JSON. */
  | { kind: "lost"; message: string };

/** Where a run starts, pinned when its confirmation dialog opens. */
interface RunPlan {
  file: File;
  header: ExportHeader;
  fKey: string;
  target: string;
  startLine: number;
  skipLines: number[];
  priorInserted: number;
  priorFailed: number;
  priorWithoutLabels: number;
  /** Lines of an unconfirmed batch this run skips rather than re-sends. */
  skippedUncertain: { from: number; to: number; count: number } | null;
}

interface Summary {
  target: string;
  tenantName: string | null;
  inserted: number;
  failed: number;
  /** Of `inserted`, stored without any of their labels. */
  withoutLabels: number;
  /** Labels that could not be recreated in the target mailbox. */
  unmapped: UnmappedLabels | null;
  /** Inserted by earlier runs of the same import. */
  priorInserted: number;
  complete: boolean;
  cancelled: boolean;
  /** Why the run stopped before the end, when it did. */
  stopReason: string | null;
  /** Last file line fully handled; resume starts after it. */
  doneThrough: number;
  /** A batch whose fate is unknown: some of its messages may be stored. */
  uncertain: { from: number; to: number; count: number } | null;
}

export default function MailboxImport() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [targetUser, setTargetUser] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [header, setHeader] = useState<ExportHeader | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The run the confirmation dialog is for, pinned when it opened.
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [runTenantName, setRunTenantName] = useState<string | null>(null);
  const cancelRef = useRef(false);
  // Aborts the request or wait in flight: cancelRef only stops the loop
  // between batches, and one batch upload can take a long time.
  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every file pick; stale header reads check it before landing,
  // and the superseded read itself is aborted.
  const pickSeq = useRef(0);
  const pickAbortRef = useRef<AbortController | null>(null);
  // Stop the insert loop if the user navigates away mid-import — otherwise it
  // keeps writing messages into the mailbox invisibly after the page is gone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelRef.current = true;
      abortRef.current?.abort();
      pickAbortRef.current?.abort();
    };
  }, []);

  const [progress, setProgress] = useState<{
    inserted: number;
    failed: number;
    doneThrough: number;
    note: string | null;
  } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Saved progress, read once and kept in step with what this page writes.
  const [progressStore, setProgressStore] = useState<Record<string, ImportProgress>>(
    () => (typeof window === "undefined" ? {} : loadProgressStore())
  );

  const target = targetUser.trim().toLowerCase();
  const validTarget = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target);
  const fKey = file && header ? fileKey(file, header) : null;
  const savedKey = fKey && validTarget ? progressKey(tenantId, target, fKey) : null;
  const saved = savedKey ? progressStore[savedKey] ?? null : null;

  // Results belong to the tenant they ran against, and a dialog opened for
  // one tenant must not confirm a run against another: clear both when the
  // tenant changes. A running import is left alone — its requests are pinned
  // and its panel names its tenant.
  useEffect(() => {
    setPlan(null);
    setDialogError(null);
    if (runningRef.current) return;
    setSummary(null);
    setError(null);
    setErrors([]);
    setProgress(null);
  }, [tenantId]);

  const onPickFile = async (f: File | null) => {
    // Reading the header can take seconds for a multi-MB header line; if the
    // operator re-picks a different file meanwhile, the slower read must not
    // land last and pair file B with file A's header (and label map) — and
    // it is cancelled rather than left reading.
    const seq = ++pickSeq.current;
    pickAbortRef.current?.abort();
    const ac = new AbortController();
    pickAbortRef.current = ac;
    setFile(f);
    setHeader(null);
    setParseError(null);
    setSummary(null);
    setError(null);
    setErrors([]);
    if (!f) return;
    try {
      const result = await readHeader(f, ac.signal);
      if (seq !== pickSeq.current) return;
      if ("error" in result) setParseError(result.error);
      else setHeader(result.header);
    } catch (e) {
      if (seq !== pickSeq.current || isAbort(e)) return;
      setParseError(
        "Couldn't read the export header. Make sure you selected a .ndjson file produced by Mailbox Export."
      );
    }
  };

  /** Open the confirmation for a run starting at `startLine`. */
  const review = (mode: "fresh" | "resume" | "resume-skip") => {
    if (!file || !header || !fKey || !validTarget) return;
    const base = mode === "fresh" ? null : saved;
    const skipUncertain = mode === "resume-skip" && base?.inFlight ? base.inFlight : null;
    setSummary(null);
    setDialogError(null);
    setPlan({
      file,
      header,
      fKey,
      target,
      startLine: skipUncertain ? skipUncertain.to + 1 : base?.nextLine ?? 2,
      skipLines: skipUncertain ? [] : base?.skipLines ?? [],
      priorInserted: base?.inserted ?? 0,
      priorFailed: base?.failed ?? 0,
      priorWithoutLabels: base?.withoutLabels ?? 0,
      skippedUncertain: skipUncertain,
    });
  };

  const runImport = async (p: RunPlan) => {
    if (runningRef.current) return;
    const pinnedTenantId = tenantId;
    const problem = await tenantPinProblem(pinnedTenantId);
    if (problem) {
      setDialogError(problem);
      return;
    }
    if (!alive.current) return;
    const key = progressKey(pinnedTenantId, p.target, p.fKey);
    const persist = (value: ImportProgress | null) => {
      saveProgress(key, value);
      setProgressStore(loadProgressStore());
    };

    runningRef.current = true;
    setPlan(null);
    setRunning(true);
    setRunTenantName(tenant?.name ?? null);
    setError(null);
    setErrors([]);
    setSummary(null);
    cancelRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const signal = ac.signal;

    // Totals over every run of this import; `committed*` only count lines up
    // to `doneThrough`, everything before which is finished for good.
    let committedInserted = p.priorInserted;
    let committedFailed = p.priorFailed;
    let committedWithoutLabels = p.priorWithoutLabels;
    let unmapped: UnmappedLabels | null = null;
    let doneThrough = p.startLine - 1;
    let skipLines = p.skipLines.filter((l) => l >= p.startLine);
    // Lines read since the last commit that could not be imported.
    let badSinceCommit = 0;
    let uncertain: Summary["uncertain"] = null;
    let stopReason: string | null = null;
    let complete = false;
    const collectedErrors: string[] = [];
    const noteError = (text: string) => {
      if (collectedErrors.length < 50) collectedErrors.push(text);
    };
    const showProgress = (note: string | null = null) => {
      if (!alive.current) return;
      setProgress({
        inserted: committedInserted,
        failed: committedFailed + badSinceCommit,
        doneThrough,
        note,
      });
    };
    const saveState = (inFlight: ImportProgress["inFlight"]) =>
      persist({
        nextLine: doneThrough + 1,
        skipLines,
        inserted: committedInserted,
        failed: committedFailed,
        withoutLabels: committedWithoutLabels,
        inFlight,
        complete: false,
        updatedAt: new Date().toISOString(),
      });
    showProgress();

    // The audit trail lets a batch whose answer was lost be matched to what
    // the server did with it: entries for this mailbox since a little before
    // the run (generous, for a server clock that differs from this one),
    // counted now and compared later.
    const auditFrom = new Date(Date.now() - 10 * 60_000).toISOString();
    let auditBaseline: number | null = null;
    let auditRecorded = 0;

    // The attempt whose fate is unknown: sent, with no answer yet (or an
    // answer that never arrived). Cleared as soon as an answer settles it, so
    // a Cancel during a wait between attempts leaves nothing in doubt.
    let inFlight: { batch: PendingMessage[]; lastLine: number } | null = null;

    /**
     * Messages of `sent` that the audit log shows were stored: committed at
     * once, so a resume never sends them again even if the run stops before
     * the rest of their batch goes through.
     */
    const commitStored = (
      sent: PendingMessage[],
      indexes: unknown[],
      withoutLabelsValue: unknown
    ): Set<number> => {
      const stored = new Set(
        indexes.filter((i): i is number => Number.isInteger(i))
      );
      const lines = sent.filter((_, i) => stored.has(i)).map((m) => m.line);
      skipLines = [...skipLines, ...lines];
      committedInserted += lines.length;
      committedWithoutLabels += countWithoutLabels(withoutLabelsValue);
      return stored;
    };

    /**
     * Send one batch until it is answered, retrying what is safe to retry,
     * and return its outcome or why it stopped. When it stops with an attempt
     * still in doubt, `inFlight` says which messages may be stored.
     */
    const deliverBatch = async (
      batch: PendingMessage[],
      lastLine: number
    ): Promise<
      | { ok: true; inserted: number; failed: number; withoutLabels: number }
      | { ok: false; reason: string }
    > => {
      let toSend = batch;
      let lost = false;
      let lostChecks = 0;
      let answeredSince = false;
      let attempts = 0;
      const range = `lines ${batch[0].line.toLocaleString()}–${lastLine.toLocaleString()}`;

      while (true) {
        if (lost) {
          // The last attempt's answer never arrived. Before sending anything
          // again, find out from the audit log whether the server did it.
          if (auditBaseline === null) {
            return {
              ok: false,
              reason: `the connection dropped while ${range} were being sent, and the audit log can't be read to tell whether they were stored`,
            };
          }
          if (lostChecks >= LOST_CHECK_DELAYS_MS.length) {
            return {
              ok: false,
              reason: answeredSince
                ? `the connection dropped while ${range} were being sent, and the server has no record of them. They were probably not stored — unless Open Admin's server stopped part-way through them`
                : `the connection dropped while ${range} were being sent, and Open Admin's server hasn't answered since`,
            };
          }
          const wait = LOST_CHECK_DELAYS_MS[lostChecks++];
          showProgress(
            `The connection dropped. Checking in ${Math.round(wait / 1000)} s whether ${range} were stored…`
          );
          await sleep(wait, signal);
          let check: { count: number; newest: AuditEntry | null };
          try {
            check = await countBatchEntries({
              tenantId: pinnedTenantId,
              target: p.target,
              fromIso: auditFrom,
              signal,
            });
          } catch (e) {
            if (isAbort(e)) throw e;
            continue; // Server still unreachable: wait and look again.
          }
          answeredSince = true;
          const ours = check.count - auditBaseline;
          if (ours === auditRecorded) continue; // No record yet.
          const params = check.newest?.params ?? {};
          if (ours !== auditRecorded + 1 || params.batchSize !== toSend.length) {
            return {
              ok: false,
              reason: `the connection dropped while ${range} were being sent, and the audit log shows other imports into ${p.target} since, so it can't tell which of them were stored`,
            };
          }
          auditRecorded++;
          lost = false;
          inFlight = null;
          if (typeof params.inserted !== "number") {
            // Logged on the route's error path: nothing was inserted, so the
            // batch is sent again below.
          } else if (params.aborted === true && Array.isArray(params.insertedIndexes)) {
            // Cut short when the connection dropped: send only the rest.
            const stored = commitStored(
              toSend,
              params.insertedIndexes,
              params.insertedWithoutLabels
            );
            toSend = toSend.filter((_, i) => !stored.has(i));
            if (toSend.length === 0) {
              return { ok: true, inserted: 0, failed: 0, withoutLabels: 0 };
            }
          } else {
            const f = typeof params.failed === "number" ? params.failed : 0;
            if (f > 0) {
              noteError(
                `Lines ${batch[0].line.toLocaleString()}–${lastLine.toLocaleString()}: ${f} message${f === 1 ? "" : "s"} failed; the details were lost with the connection`
              );
            }
            return {
              ok: true,
              inserted: params.inserted,
              failed: f,
              withoutLabels: countWithoutLabels(params.insertedWithoutLabels),
            };
          }
        }

        // Written before sending: if the page is closed now, the next visit
        // knows this batch may be partly stored.
        saveState({ from: toSend[0].line, to: lastLine, count: toSend.length });
        showProgress();
        inFlight = { batch: toSend, lastLine };
        let attempt: Attempt;
        try {
          const res = await tfetch(
            "/api/admin/mailbox-import",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // The route re-checks the typed confirmation server-side on
              // every batch: send the address the operator confirmed.
              body: JSON.stringify({
                user: p.target,
                messages: toSend.map((m) => ({ raw: m.raw, labelIds: m.labelIds })),
                confirm: p.target,
              }),
              signal,
            },
            pinnedTenantId
          );
          let data;
          try {
            data = await res.json();
          } catch (e) {
            if (isAbort(e)) throw e;
            data = null;
          }
          if (data === null) {
            attempt = { kind: "lost", message: `unexpected answer (HTTP ${res.status})` };
          } else if (data.success && data.data) {
            attempt = { kind: "ok", outcome: data.data as BatchOutcome };
          } else {
            const message = data.error || `Import batch failed (HTTP ${res.status})`;
            attempt =
              res.status === 429
                ? { kind: "busy", message }
                : res.status >= 500
                  ? { kind: "server", message }
                  : { kind: "refused", message };
          }
        } catch (e) {
          if (isAbort(e)) throw e;
          attempt = { kind: "lost", message: "the connection dropped" };
        }

        if (attempt.kind === "lost") {
          lost = true;
          continue;
        }
        // Any real answer settles the attempt.
        inFlight = null;
        if (attempt.kind === "ok") {
          auditRecorded++;
          const out = attempt.outcome;
          for (const e of out.errors ?? []) {
            const line = toSend[e.index]?.line;
            noteError(line ? `Line ${line.toLocaleString()}: ${e.message}` : e.message);
          }
          return {
            ok: true,
            inserted: out.inserted,
            failed: out.failed,
            withoutLabels: countWithoutLabels(out.insertedWithoutLabels),
          };
        }
        if (attempt.kind === "refused") {
          auditRecorded++;
          return { ok: false, reason: attempt.message };
        }
        if (attempt.kind === "server") auditRecorded++;
        // busy or server: nothing was stored, so the same batch goes again.
        if (attempts >= RETRY_DELAYS_MS.length) {
          return {
            ok: false,
            reason: `${attempt.message} (gave up after ${attempts} retries)`,
          };
        }
        const wait = RETRY_DELAYS_MS[attempts++];
        showProgress(`${attempt.message} Trying again in ${Math.round(wait / 1000)} s…`);
        await sleep(wait, signal);
      }
    };

    // The batch being assembled.
    let batch: PendingMessage[] = [];
    let batchBytes = 0;

    /** Send `batch`, which holds every line up to `lastLine`, and commit it. */
    const flush = async (lastLine: number): Promise<boolean> => {
      if (batch.length > 0) {
        if (!alive.current) return false;
        const r = await deliverBatch(batch, lastLine);
        if (!r.ok) {
          stopReason = r.reason;
          const doubt = inFlight as { batch: PendingMessage[]; lastLine: number } | null;
          if (doubt) {
            uncertain = {
              from: doubt.batch[0].line,
              to: doubt.lastLine,
              count: doubt.batch.length,
            };
          }
          // Already looked into for as long as is useful: not again below.
          inFlight = null;
          saveState(uncertain);
          return false;
        }
        committedInserted += r.inserted;
        committedWithoutLabels += r.withoutLabels;
        committedFailed += r.failed;
      }
      committedFailed += badSinceCommit;
      badSinceCommit = 0;
      doneThrough = lastLine;
      skipLines = skipLines.filter((l) => l > doneThrough);
      saveState(null);
      showProgress();
      batch = [];
      batchBytes = 0;
      return true;
    };

    try {
      // Step 1: recreate labels in the target mailbox and get the id map.
      // Labels are matched by name, so asking again is always safe.
      let labelMap: Record<string, string> | null = null;
      for (let attempt = 0; labelMap === null; attempt++) {
        let failure: string;
        let retryable: boolean;
        try {
          const labelRes = await tfetch(
            "/api/admin/mailbox-import/labels",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // The label route also requires the typed confirmation: the
              // target address the operator confirmed in the dialog.
              body: JSON.stringify({
                user: p.target,
                labels: p.header.labels,
                confirm: p.target,
              }),
              signal,
            },
            pinnedTenantId
          );
          const labelData = await labelRes.json().catch((e: unknown) => {
            if (isAbort(e)) throw e;
            return null;
          });
          if (labelData?.success) {
            labelMap = labelData.data?.map ?? {};
            // Labels the target could not match or create: messages that
            // carry them arrive without them, which the summary must say.
            const list: unknown[] = Array.isArray(labelData.data?.unmapped)
              ? labelData.data.unmapped
              : [];
            const count =
              typeof labelData.data?.unmappedCount === "number"
                ? labelData.data.unmappedCount
                : list.length;
            if (count > 0) {
              unmapped = {
                count,
                names: list
                  .map((u) => (u as { name?: unknown })?.name)
                  .filter((n): n is string => typeof n === "string" && n.length > 0)
                  .slice(0, 5),
              };
            }
            break;
          }
          failure = labelData?.error || `Failed to prepare labels (HTTP ${labelRes.status})`;
          retryable = labelData === null || labelRes.status === 429 || labelRes.status >= 500;
        } catch (e) {
          if (isAbort(e)) throw e;
          failure = "Failed to connect to the API";
          retryable = true;
        }
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          stopReason = failure;
          break;
        }
        const wait = RETRY_DELAYS_MS[attempt];
        showProgress(`${failure} Trying again in ${Math.round(wait / 1000)} s…`);
        await sleep(wait, signal);
      }

      if (labelMap !== null) {
        try {
          auditBaseline = (
            await countBatchEntries({
              tenantId: pinnedTenantId,
              target: p.target,
              fromIso: auditFrom,
              signal,
            })
          ).count;
        } catch (e) {
          if (isAbort(e)) throw e;
          // Without it a lost batch can't be matched: the run says so then.
          auditBaseline = null;
        }

        // Step 2: stream the file and insert messages in size-bounded batches.
        const skip = new Set(skipLines);
        let lineNo = 0;
        let stopped = false;
        for await (const line of readLines(p.file, {
          signal,
          maxLineChars: MESSAGE_LINE_MAX_CHARS,
        })) {
          lineNo++;
          if (lineNo === 1) continue; // header line, already parsed
          if (lineNo < p.startLine) continue; // handled by an earlier run
          if (cancelRef.current || !alive.current) {
            stopped = true;
            break;
          }
          if (skip.has(lineNo)) continue; // already inserted by an earlier run
          let msg: { raw: string; labelIds?: string[] } | { error: string };
          if (line === LINE_TOO_LONG) {
            msg = { error: "longer than the largest message Gmail accepts" };
          } else {
            const trimmed = line.trim();
            if (!trimmed) continue;
            msg = parseMessageLine(trimmed);
          }
          if ("error" in msg) {
            // Counted as a failure rather than dropped silently, so the
            // summary stays honest.
            badSinceCommit++;
            noteError(`Line ${lineNo.toLocaleString()}: ${msg.error} — skipped`);
            showProgress();
            continue;
          }

          // Remap label IDs from the source mailbox to the target. IDs that
          // didn't resolve (a user label whose create failed) are dropped so
          // the server's retry path can't strip every label off the message —
          // system labels always resolve (mapped to themselves) and survive.
          const labelIds = msg.labelIds
            ?.map((id) => labelMap![id])
            .filter((id): id is string => typeof id === "string");

          // Flush BEFORE adding when this message would push the batch over a
          // limit, so a batch never exceeds the count cap or the byte budget
          // (a single oversized message is sent on its own).
          if (
            batch.length >= IMPORT_BATCH_COUNT ||
            (batch.length > 0 && batchBytes + msg.raw.length > IMPORT_BATCH_BYTES)
          ) {
            if (!(await flush(lineNo - 1))) {
              stopped = true;
              break;
            }
          }
          batch.push({ line: lineNo, raw: msg.raw, labelIds });
          batchBytes += msg.raw.length;
        }
        if (!stopped && !cancelRef.current && alive.current) {
          if (await flush(lineNo)) complete = true;
        }
      }
    } catch (e) {
      if (!isAbort(e)) stopReason = "Failed to read the file or reach the API";
    }

    // Cancel (or leaving the page) can interrupt a batch in flight. The
    // server stops between messages and records which ones it stored, so
    // look that up rather than guess.
    const interrupted = inFlight as { batch: PendingMessage[]; lastLine: number } | null;
    if (interrupted && alive.current && auditBaseline !== null) {
      showProgress("Cancelling — checking which messages of the last batch were stored…");
      const checkAc = new AbortController();
      abortRef.current = checkAc;
      try {
        for (const wait of CANCEL_CHECK_DELAYS_MS) {
          await sleep(wait, checkAc.signal);
          const check = await countBatchEntries({
            tenantId: pinnedTenantId,
            target: p.target,
            fromIso: auditFrom,
            signal: checkAc.signal,
          }).catch((e: unknown) => {
            if (isAbort(e)) throw e;
            return null;
          });
          if (!check || check.count - auditBaseline === auditRecorded) continue;
          const params = check.newest?.params ?? {};
          if (
            check.count - auditBaseline !== auditRecorded + 1 ||
            params.batchSize !== interrupted.batch.length
          ) {
            break;
          }
          if (typeof params.inserted !== "number") {
            // Refused before inserting anything.
          } else if (params.aborted === true && Array.isArray(params.insertedIndexes)) {
            commitStored(
              interrupted.batch,
              params.insertedIndexes,
              params.insertedWithoutLabels
            );
          } else {
            // The server finished the whole batch before it noticed.
            committedInserted += params.inserted;
            committedWithoutLabels += countWithoutLabels(params.insertedWithoutLabels);
            committedFailed +=
              (typeof params.failed === "number" ? params.failed : 0) + badSinceCommit;
            badSinceCommit = 0;
            doneThrough = interrupted.lastLine;
            skipLines = skipLines.filter((l) => l > doneThrough);
          }
          inFlight = null;
          break;
        }
      } catch {
        // Left the page while checking.
      }
    }
    const stillInDoubt = inFlight as { batch: PendingMessage[]; lastLine: number } | null;
    if (stillInDoubt && !uncertain) {
      uncertain = {
        from: stillInDoubt.batch[0].line,
        to: stillInDoubt.lastLine,
        count: stillInDoubt.batch.length,
      };
    }

    runningRef.current = false;
    if (complete) {
      persist({
        nextLine: doneThrough + 1,
        skipLines: [],
        inserted: committedInserted,
        failed: committedFailed,
        withoutLabels: committedWithoutLabels,
        inFlight: null,
        complete: true,
        updatedAt: new Date().toISOString(),
      });
    } else {
      saveState(uncertain);
    }
    if (!alive.current) return;

    const cancelled = !complete && !stopReason && cancelRef.current;
    setRunning(false);
    setProgress(null);
    setErrors(collectedErrors);
    if (stopReason && !uncertain) setError(`Import stopped: ${stopReason}.`);
    setSummary({
      target: p.target,
      tenantName: tenant?.name ?? null,
      inserted: committedInserted,
      failed: committedFailed + (complete ? 0 : badSinceCommit),
      withoutLabels: committedWithoutLabels,
      unmapped,
      priorInserted: p.priorInserted,
      complete,
      cancelled,
      stopReason,
      doneThrough,
      uncertain,
    });
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const summaryWarn =
    !!summary &&
    (!summary.complete ||
      summary.failed > 0 ||
      summary.withoutLabels > 0 ||
      (summary.unmapped?.count ?? 0) > 0);
  const msgs = (n: number) => `${n.toLocaleString()} message${n === 1 ? "" : "s"}`;

  let summaryText = "";
  if (summary) {
    const into = ` into ${summary.target}${summary.tenantName ? ` (${summary.tenantName})` : ""}`;
    const counts = `inserted ${msgs(summary.inserted)}${
      summary.failed > 0 ? `, ${summary.failed.toLocaleString()} failed` : ""
    }${into}`;
    const earlier =
      summary.priorInserted > 0
        ? ` That includes ${msgs(summary.priorInserted)} from the earlier run.`
        : "";
    if (summary.complete) {
      summaryText =
        summary.failed > 0 && summary.inserted === 0
          ? `Import finished, but every message failed — ${counts}.${earlier}`
          : summary.failed > 0
            ? `Import finished with failures — ${counts}.${earlier}`
            : summary.inserted === 0
              ? `Import finished — the file had no messages to insert${into}.`
              : `Import complete — ${counts}.${earlier}`;
    } else {
      const how = summary.cancelled
        ? "Import cancelled"
        : summary.uncertain && summary.stopReason
          ? `Import stopped: ${summary.stopReason}`
          : "Import stopped";
      summaryText = `${how} — ${counts} so far.${earlier} Every line up to ${summary.doneThrough.toLocaleString()} is done.`;
      if (summary.uncertain) {
        summaryText += ` Lines ${summary.uncertain.from.toLocaleString()}–${summary.uncertain.to.toLocaleString()} (${msgs(summary.uncertain.count)}) were being sent when it stopped, so some of them may already be in the mailbox.`;
      }
    }
    if (summary.withoutLabels > 0) {
      const one = summary.withoutLabels === 1;
      summaryText += ` ${msgs(summary.withoutLabels)} ${one ? "was" : "were"} stored without any of ${one ? "its" : "their"} labels — not even Inbox or Unread — because Gmail refused ${one ? "it" : "them"} with labels.`;
    }
    if (summary.unmapped && summary.unmapped.count > 0) {
      const u = summary.unmapped;
      const one = u.count === 1;
      const names = u.names.map((n) => `"${n}"`).join(", ");
      summaryText += ` ${u.count.toLocaleString()} label${one ? "" : "s"} couldn't be created in ${summary.target}${names ? ` (${names}${u.count > u.names.length ? ", …" : ""})` : ""}, so messages that carry ${one ? "it" : "them"} arrived without ${one ? "it" : "them"}.`;
    }
  }

  const canStart = !!file && !!header && validTarget;

  return (
    <>
      <PageHeader
        title="Mailbox Import"
        description="Restore a mailbox export into another user's Gmail. Messages are inserted with their original dates and labels recreated by name."
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
          <AlertDescription>{summaryText}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
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
                onChange={(e) => {
                  void onPickFile(e.target.files?.[0] ?? null);
                  // Cleared so picking the same file again (after editing it,
                  // or to re-read it) fires a change event at all.
                  e.target.value = "";
                }}
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
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4 text-danger" />
                <AlertDescription>{parseError}</AlertDescription>
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
                  {header.badLabels > 0
                    ? ` (${header.badLabels} unreadable, will be skipped)`
                    : ""}
                </p>
              </div>
            )}

            {saved && !running && (
              <div
                className={`rounded-md border p-3 text-sm space-y-2 ${
                  saved.complete
                    ? "border-warning/30 bg-warning/8 text-warning-fg"
                    : "bg-muted/30"
                }`}
              >
                {saved.complete ? (
                  <p>
                    This file was already imported into {target} on{" "}
                    {new Date(saved.updatedAt).toLocaleString()} (
                    {msgs(saved.inserted)} inserted). Importing it again
                    inserts a second copy of every message.
                  </p>
                ) : (
                  <>
                    <p>
                      An earlier import of this file into {target} stopped
                      after line {(saved.nextLine - 1).toLocaleString()} (
                      {msgs(saved.inserted)} inserted
                      {saved.failed > 0 ? `, ${saved.failed.toLocaleString()} failed` : ""}
                      ). Resuming never sends those lines again.
                    </p>
                    {saved.inFlight && (
                      <p className="text-xs text-warning-fg">
                        Lines {saved.inFlight.from.toLocaleString()}–
                        {saved.inFlight.to.toLocaleString()} (
                        {msgs(saved.inFlight.count)}) were being sent when it
                        stopped, and Open Admin can&apos;t tell whether they
                        were stored. Resuming from line{" "}
                        {saved.nextLine.toLocaleString()} sends them again
                        (possible duplicates); skipping them may leave them
                        out.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => review("resume")}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Resume from line {saved.nextLine.toLocaleString()}
                      </Button>
                      {saved.inFlight && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => review("resume-skip")}
                        >
                          Resume from line{" "}
                          {(saved.inFlight.to + 1).toLocaleString()} (skip
                          them)
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription>
                Importing is not idempotent — running it twice inserts duplicate
                copies of every message. Import into a fresh or intended mailbox,
                and only once. If an import stops, resume it from where it
                stopped rather than starting over.
              </AlertDescription>
            </Alert>

            <div className="flex items-center gap-3">
              {!running ? (
                <Button
                  variant={saved && !saved.complete ? "outline" : "default"}
                  onClick={() => review("fresh")}
                  disabled={!canStart}
                >
                  <Upload className="h-4 w-4 mr-1.5" />
                  {saved ? "Review & import from the start" : "Review & Import"}
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
                  {progress.doneThrough > 1
                    ? ` · done through line ${progress.doneThrough.toLocaleString()}`
                    : ""}
                </p>
              )}
            </div>
            {running && (
              <p className="text-xs text-muted-foreground">
                {progress?.note ? `${progress.note} ` : ""}
                {runTenantName
                  ? `Importing into ${target || "the target"} in ${runTenantName}.`
                  : ""}
                {runTenantName && tenant && tenant.name !== runTenantName
                  ? ` You have since switched to ${tenant.name}; this import carries on against ${runTenantName}.`
                  : ""}
              </p>
            )}

            {errors.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/8 p-3 text-xs text-warning-fg space-y-1">
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

      {plan && (
        <ConfirmActionDialog
          open={!!plan}
          onOpenChange={(o) => {
            if (running || o) return;
            setPlan(null);
            setDialogError(null);
          }}
          title={plan.startLine > 2 ? "Resume mailbox import" : "Import mailbox into target"}
          summary={
            plan.startLine > 2
              ? `Insert the rest of ${plan.header.sourceUser}'s export into ${plan.target}, starting at line ${plan.startLine.toLocaleString()}.`
              : `Insert every message from ${plan.header.sourceUser}'s export into ${plan.target}.`
          }
          tenant={
            tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
          }
          severity="high"
          confirmPhrase={plan.target}
          confirmLabel={plan.startLine > 2 ? "Resume import" : "Import mailbox"}
          busy={running}
          changes={[
            { label: "Source export", after: plan.header.sourceUser },
            {
              label: "Target mailbox (messages inserted here)",
              after: plan.target,
              emphasis: true,
            },
            ...(plan.startLine > 2
              ? [
                  {
                    label: "Starts at",
                    after: `line ${plan.startLine.toLocaleString()} — ${msgs(plan.priorInserted)} already inserted are not sent again`,
                  },
                ]
              : []),
            ...(plan.skippedUncertain
              ? [
                  {
                    label: "Skipped",
                    after: `lines ${plan.skippedUncertain.from.toLocaleString()}–${plan.skippedUncertain.to.toLocaleString()}, which may or may not have been stored`,
                  },
                ]
              : []),
            { label: "Labels", after: `${plan.header.labels.length} recreated by name` },
            { label: "Message dates", after: "Preserved from each message's Date header" },
          ]}
          warnings={
            <span>
              This <strong>adds</strong> messages to {plan.target} — it never
              deletes existing mail, but importing the same lines twice creates
              duplicates.
              {plan.startLine <= 2 && saved
                ? " An earlier import of this file into this mailbox is on record: starting over sends every line again."
                : ""}{" "}
              Inserted messages are not re-delivered and won&apos;t notify
              anyone.
            </span>
          }
          error={dialogError}
          onConfirm={() => runImport(plan)}
        />
      )}
    </>
  );
}
