"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import {
  CheckCircle2,
  Circle,
  Download,
  Eye,
  Loader2,
  Play,
  Signature,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { isValidEmail } from "@/lib/validate-email";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  SIGNATURE_FIELDS,
  SIGNATURE_TEMPLATE_MAX,
  signatureToText,
  templateProblem,
  type RenderedSignature,
  type SignaturePart,
  type SignatureProfile,
} from "@/lib/signatures";
import type { DirectoryAccount } from "@/lib/security-check";

interface Preview {
  profile: SignatureProfile;
  rendered: RenderedSignature;
  current: string;
}

type RowStatus = "pending" | "running" | "changed" | "unchanged" | "error";

interface Row {
  user: string;
  status: RowStatus;
  error?: string;
  /** The signature that was there before, as HTML. Kept so it can be exported. */
  previous?: string;
}

/** The most mailboxes one run takes. A run can be cancelled part-way. */
const MAX_RECIPIENTS = 2000;

const JSON_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
} as const;

function parseRecipients(text: string): { users: string[]; bad: string[] } {
  const users: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const line = raw.trim().toLowerCase();
    if (!line) continue;
    if (!isValidEmail(line)) bad.push(raw.trim());
    else if (!users.includes(line)) users.push(line);
  }
  return { users, bad };
}

function csvCell(c: string): string {
  let v = c;
  // Stop a spreadsheet treating a cell as a formula when the export is opened.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: string[][]) {
  const content = rows.map((r) => r.map(csvCell).join(",")).join("\n");
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

/**
 * A rendered signature, drawn from its parts. Never from its HTML: the page
 * shows exactly what the rules produced without trusting any markup.
 */
function SignatureView({ lines }: { lines: SignaturePart[][] }) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">(empty)</p>;
  }
  return (
    <div className="text-sm leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className="min-h-5 break-words">
          {line.map((part, j) => (
            <span
              key={j}
              className={
                (part.bold ? "font-semibold " : "") +
                (part.href ? "text-primary underline underline-offset-2" : "")
              }
            >
              {part.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Signatures() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [template, setTemplate] = useState(DEFAULT_SIGNATURE_TEMPLATE);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  const [previewUser, setPreviewUser] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [recipientsText, setRecipientsText] = useState("");
  const [loadingEveryone, setLoadingEveryone] = useState(false);
  const [recipientsNote, setRecipientsNote] = useState<Feedback | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const abortRef = useRef<AbortController | null>(null);
  const previewSeq = useRef(0);

  // People, previews and results all belong to one tenant. The template is
  // only text, so it is kept across a switch.
  useEffect(() => {
    abortRef.current?.abort();
    previewSeq.current++;
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
    setRecipientsText("");
    setRecipientsNote(null);
    setRows([]);
    setRan(false);
    setRunning(false);
    setConfirmOpen(false);
    setLoadingEveryone(false);
    return () => abortRef.current?.abort();
  }, [tenantId]);

  const problem = useMemo(() => templateProblem(template), [template]);
  const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);
  const recipientsProblem =
    recipients.bad.length > 0
      ? `Not an email address: ${recipients.bad.slice(0, 3).join(", ")}`
      : recipients.users.length > MAX_RECIPIENTS
        ? `${recipients.users.length.toLocaleString()} mailboxes is more than one run takes (${MAX_RECIPIENTS.toLocaleString()}). Apply in batches.`
        : null;

  function insertField(key: string) {
    const el = templateRef.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    // Put the cursor after what was inserted, once React has written it.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function runPreview() {
    const user = previewUser.trim().toLowerCase();
    if (!isValidEmail(user)) {
      setPreviewError(`${user || "That"} isn't a valid email address.`);
      return;
    }
    const seq = ++previewSeq.current;
    const pinnedTenantId = tenantId;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const res = await tfetch(
        "/api/admin/signatures/preview",
        { ...JSON_POST, body: JSON.stringify({ user, template }) },
        pinnedTenantId
      );
      const result = await res.json();
      if (seq !== previewSeq.current || tenantIdRef.current !== pinnedTenantId) return;
      if (result.success) setPreview(result.data as Preview);
      else setPreviewError(result.error || "The preview could not be made.");
    } catch {
      if (seq === previewSeq.current) setPreviewError("Could not reach the server.");
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }

  async function addEveryone() {
    const pinnedTenantId = tenantId;
    setLoadingEveryone(true);
    setRecipientsNote(null);
    try {
      const found: string[] = [];
      let skipped = 0;
      let pageToken: string | null = null;
      do {
        const query: string = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await tfetch(`/api/admin/accounts${query}`, {}, pinnedTenantId);
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;
        if (!result.success) {
          setRecipientsNote({
            type: "error",
            text: `The directory could not be read: ${result.error || res.status}`,
          });
          return;
        }
        for (const a of result.data.accounts as DirectoryAccount[]) {
          // Only accounts that have a mailbox Google will open.
          if (a.suspended || a.archived || !a.mailboxSetup) skipped++;
          else found.push(a.primaryEmail);
        }
        pageToken = result.data.nextPageToken;
      } while (pageToken);
      setRecipientsText(found.join("\n"));
      setRows([]);
      setRan(false);
      setRecipientsNote({
        type: "info",
        text: `Added ${found.length.toLocaleString()} ${found.length === 1 ? "mailbox" : "mailboxes"}.${
          skipped > 0
            ? ` Left out ${skipped.toLocaleString()} that ${skipped === 1 ? "is" : "are"} suspended, archived or without Gmail.`
            : ""
        }`,
      });
    } catch {
      if (tenantIdRef.current === pinnedTenantId) {
        setRecipientsNote({ type: "error", text: "Could not reach the server." });
      }
    } finally {
      setLoadingEveryone(false);
    }
  }

  async function run() {
    const pinnedTenantId = tenantId;
    const pinnedTemplate = template;
    const users = recipients.users;
    const ac = new AbortController();
    abortRef.current = ac;
    setConfirmOpen(false);
    setRunning(true);
    setRan(false);
    setRows(users.map((user) => ({ user, status: "pending" })));
    const set = (i: number, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    try {
      for (let i = 0; i < users.length; i++) {
        if (ac.signal.aborted || tenantIdRef.current !== pinnedTenantId) break;
        set(i, { status: "running" });
        try {
          const res = await tfetch(
            "/api/admin/signatures",
            {
              ...JSON_POST,
              body: JSON.stringify({
                user: users[i],
                template: pinnedTemplate,
                confirm: users[i],
              }),
              signal: ac.signal,
            },
            pinnedTenantId
          );
          const result = await res.json();
          if (tenantIdRef.current !== pinnedTenantId) return;
          if (result.success) {
            set(i, {
              status: result.data.changed ? "changed" : "unchanged",
              previous: result.data.previous ?? "",
            });
          } else {
            set(i, { status: "error", error: result.error || `The server answered ${res.status}` });
          }
        } catch {
          if (ac.signal.aborted) {
            // It never ran: put it back so the count of what's left is right.
            set(i, { status: "pending" });
            break;
          }
          set(i, { status: "error", error: "Could not reach the server." });
        }
      }
      if (tenantIdRef.current === pinnedTenantId) setRan(true);
    } finally {
      setRunning(false);
    }
  }

  function exportResults() {
    downloadCsv(`signatures-${new Date().toISOString().slice(0, 10)}.csv`, [
      ["user", "result", "error", "previous_signature_html"],
      ...rows.map((r) => [
        r.user,
        r.status === "changed"
          ? "replaced"
          : r.status === "unchanged"
            ? "already had it"
            : r.status === "error"
              ? "failed"
              : "not run",
        r.error ?? "",
        r.previous ?? "",
      ]),
    ]);
  }

  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const n = recipients.users.length;
  const canApply = !problem && !recipientsProblem && n > 0 && !running && !loadingEveryone;

  const statusIcon = (s: RowStatus) => {
    switch (s) {
      case "changed":
      case "unchanged":
        return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
      case "running":
        return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />;
      default:
        return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />;
    }
  };

  return (
    <div>
      <PageHeader
        title="Email Signatures"
        badge="Gmail"
        description="Write one signature template and give it to everyone, each filled in with that person's own name, job title and phone number from the directory."
      />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card data-testid="signature-template-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Signature className="h-5 w-5" />
                Template
              </CardTitle>
              <CardDescription>
                Plain lines. A field in double braces is replaced with each
                person&apos;s own details.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                id="signature-template"
                ref={templateRef}
                rows={7}
                value={template}
                maxLength={SIGNATURE_TEMPLATE_MAX}
                onChange={(e) => setTemplate(e.target.value)}
                disabled={running}
                className="font-mono text-xs"
                spellCheck={false}
                aria-label="Signature template"
                aria-invalid={!!problem}
              />
              <div className="flex flex-wrap gap-1.5">
                {SIGNATURE_FIELDS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    disabled={running}
                    onClick={() => insertField(f.key)}
                    className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    title={`Insert {{${f.key}}}`}
                  >
                    + {f.label}
                  </button>
                ))}
              </div>
              {problem ? (
                <p className="text-xs text-danger-fg" data-testid="signature-template-problem">
                  {problem}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A line is left out for anyone who has nothing for it, so a
                  person with no phone number gets no empty line. Put{" "}
                  <code className="font-mono">**</code> either side of text to
                  make it bold. Web and email addresses become links. Job title,
                  department and phone come from each person&apos;s directory
                  profile in the Admin console.
                </p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="signature-preview-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Try it on one person
              </CardTitle>
              <CardDescription>
                Shows what they would get next to what they have. Changes
                nothing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  id="previewUser"
                  value={previewUser}
                  onChange={(e) => setPreviewUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !previewing && !problem && void runPreview()}
                  placeholder="jane@yourdomain.com"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Person to preview"
                />
                <Button
                  variant="secondary"
                  onClick={() => void runPreview()}
                  disabled={previewing || !!problem || !previewUser.trim()}
                >
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                  Preview
                </Button>
              </div>
              <FeedbackAlert message={previewError ? { type: "error", text: previewError } : null} />
              {preview && (
                <div className="grid gap-3 sm:grid-cols-2" data-testid="signature-preview">
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      New signature
                    </p>
                    <div className="rounded-lg border bg-background p-3" data-testid="signature-new">
                      <SignatureView lines={preview.rendered.lines} />
                    </div>
                    {preview.rendered.missing.length > 0 && (
                      <p className="text-xs text-muted-foreground" data-testid="signature-missing">
                        {`${preview.profile.email} has no ${preview.rendered.missing
                          .map((key) => SIGNATURE_FIELDS.find((f) => f.key === key)?.label.toLowerCase() ?? key)
                          .join(", ")} in the directory.`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      What they have now
                    </p>
                    <div
                      className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words"
                      data-testid="signature-current"
                    >
                      {signatureToText(preview.current) || (
                        <span className="text-muted-foreground">(no signature)</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Shown as plain text, without its formatting or images.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card data-testid="signature-apply-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Apply it
            </CardTitle>
            <CardDescription>
              Replaces the signature on the address each person normally sends
              from. They can still change it themselves afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signature-recipients">Mailboxes</Label>
              <Textarea
                id="signature-recipients"
                rows={5}
                value={recipientsText}
                onChange={(e) => {
                  setRecipientsText(e.target.value);
                  setRecipientsNote(null);
                }}
                disabled={running || loadingEveryone}
                placeholder={"jane@yourdomain.com\nsam@yourdomain.com"}
                className="font-mono text-xs"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void addEveryone()}
                  disabled={running || loadingEveryone}
                >
                  {loadingEveryone ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Users className="h-4 w-4" />
                  )}
                  Use everyone with a mailbox
                </Button>
                <p className="text-xs text-muted-foreground">
                  One address per line.{" "}
                  {n > 0 && `${n.toLocaleString()} ${n === 1 ? "mailbox" : "mailboxes"} listed.`}
                </p>
              </div>
              <FeedbackAlert message={recipientsNote} />
              {recipientsProblem && (
                <p className="text-xs text-danger-fg" data-testid="signature-recipients-problem">
                  {recipientsProblem}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirmOpen(true)} disabled={!canApply}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {`Review & apply to ${n.toLocaleString()} ${n === 1 ? "mailbox" : "mailboxes"}`}
              </Button>
              {running && (
                <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                  <X className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              {rows.some((r) => r.status !== "pending") && !running && (
                <Button variant="secondary" onClick={exportResults}>
                  <Download className="h-4 w-4" />
                  Export results CSV
                </Button>
              )}
            </div>

            {rows.length > 0 && (
              <div className="space-y-2" data-testid="signature-results">
                <p role="status" className="text-sm text-muted-foreground" data-testid="signature-status">
                  {running
                    ? `Working... ${(rows.length - count("pending") - count("running")).toLocaleString()} of ${rows.length.toLocaleString()}`
                    : ran
                      ? `${count("pending") > 0 ? "Stopped early. " : "Done. "}${count("changed")} replaced · ${count("unchanged")} already had it · ${count("error")} failed${
                          count("pending") > 0 ? ` · ${count("pending")} not run` : ""
                        }`
                      : ""}
                </p>
                {ran && rows.some((r) => r.status === "changed") && (
                  <p className="text-xs text-muted-foreground">
                    The export includes each signature that was replaced, in
                    case one needs putting back. It is only kept until you leave
                    this page.
                  </p>
                )}
                <div className="space-y-1.5">
                  {rows.map((r) => (
                    <div
                      key={r.user}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      {statusIcon(r.status)}
                      <span className="min-w-0 flex-1 text-sm break-all">{r.user}</span>
                      {r.status === "changed" && <Badge variant="success">Replaced</Badge>}
                      {r.status === "unchanged" && <Badge variant="secondary">Already had it</Badge>}
                      {r.status === "error" && <Badge variant="destructive">Failed</Badge>}
                      {r.error && (
                        <span className="basis-full pl-7 text-xs text-danger break-words">
                          {r.error}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={(open) => !running && setConfirmOpen(open)}
        title="Replace these signatures"
        summary={`Set the signature of ${n.toLocaleString()} ${n === 1 ? "mailbox" : "mailboxes"} from the template. They are done one at a time and can be cancelled part-way.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        confirmPhrase={`APPLY ${n}`}
        confirmLabel="Replace signatures"
        busy={running}
        onConfirm={run}
        changes={[
          { label: "Mailboxes", after: n.toLocaleString(), emphasis: true },
          {
            label: "Signature",
            before: "Whatever each person has now",
            after: "The template, filled in from their directory profile",
          },
        ]}
        warnings={
          <p>
            Each person&apos;s own signature is overwritten, including any logo
            or formatting they added. The results keep what was there, so
            export them before leaving this page if you might want one back.
          </p>
        }
      />
    </div>
  );
}
