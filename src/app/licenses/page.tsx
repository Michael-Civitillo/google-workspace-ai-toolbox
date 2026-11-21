"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import { CopyButton } from "@/components/copy-button";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import {
  AlertTriangle,
  Download,
  Loader2,
  PlayCircle,
  Ticket,
  UserPlus,
  X,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { isValidEmail } from "@/lib/validate-email";
import {
  LICENSE_IDLE_DAYS,
  LICENSE_PRODUCTS,
  reclaimReasonText,
  summariseLicenses,
  type LicenseAssignment,
  type ReclaimableLicense,
  type SkuSummary,
} from "@/lib/licenses";
import type { DirectoryAccount } from "@/lib/security-check";

type Phase = "idle" | "reading" | "done" | "cancelled" | "failed";

interface SetupProblem {
  code: "scope_missing" | "api_disabled";
  scope: string;
  detail: string | null;
}

interface Scan {
  assignments: LicenseAssignment[];
  accounts: DirectoryAccount[];
  /** Products Google answered for (including with nothing). */
  productsRead: number;
  /** Products that failed for a reason other than "you don't have this". */
  failedProducts: Array<{ name: string; error: string }>;
  /** When the directory was read: the "now" idle time is measured from. */
  readAt: number;
}

type Change =
  | { kind: "remove"; target: LicenseAssignment }
  | { kind: "assign"; user: string; sku: SkuSummary };

/** How many rows of a long list are drawn. The export always has them all. */
const MAX_ROWS_SHOWN = 200;

const skuValue = (s: { productId: string; skuId: string }) => `${s.productId}/${s.skuId}`;

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

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function Licenses() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupProblem | null>(null);
  const [message, setMessage] = useState<Feedback | null>(null);

  const [assignUser, setAssignUser] = useState("");
  const [assignSku, setAssignSku] = useState("");
  const [change, setChange] = useState<Change | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const abortRef = useRef<AbortController | null>(null);
  const assignCardRef = useRef<HTMLDivElement>(null);

  // What was read belongs to one tenant. A switch starts clean.
  useEffect(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setProgress("");
    setScan(null);
    setFailure(null);
    setSetup(null);
    setMessage(null);
    setAssignUser("");
    setAssignSku("");
    setChange(null);
    setChangeError(null);
    return () => abortRef.current?.abort();
  }, [tenantId]);

  const report = useMemo(
    () =>
      scan
        ? summariseLicenses(scan.assignments, scan.accounts, {
            now: scan.readAt,
            allProductsRead: scan.failedProducts.length === 0,
          })
        : null,
    [scan]
  );

  async function check() {
    const pinnedTenantId = tenantId;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const live = () => !ac.signal.aborted && tenantIdRef.current === pinnedTenantId;

    setPhase("reading");
    setScan(null);
    setFailure(null);
    setSetup(null);
    setMessage(null);
    setProgress("Reading licences...");

    const assignments: LicenseAssignment[] = [];
    const failedProducts: Scan["failedProducts"] = [];
    let productsRead = 0;

    try {
      for (const product of LICENSE_PRODUCTS) {
        let pageToken: string | null = null;
        do {
          const query = new URLSearchParams({ product: product.id });
          if (pageToken) query.set("pageToken", pageToken);
          const res = await tfetch(
            `/api/admin/licenses?${query}`,
            { signal: ac.signal },
            pinnedTenantId
          );
          const result = await res.json();
          if (!live()) return;
          if (!result.success) {
            if (result.code === "scope_missing" || result.code === "api_disabled") {
              // Nothing else will work until this is fixed, so stop here.
              setSetup({ code: result.code, scope: result.scope, detail: result.detail ?? null });
              setPhase("failed");
              return;
            }
            failedProducts.push({
              name: product.name,
              error: result.error || `The server answered ${res.status}`,
            });
            break;
          }
          if (result.data.unavailable) break;
          if (!pageToken) productsRead++;
          assignments.push(...(result.data.assignments as LicenseAssignment[]));
          setProgress(`Reading licences... ${assignments.length.toLocaleString()} so far`);
          pageToken = result.data.nextPageToken;
        } while (pageToken);
      }

      if (productsRead === 0) {
        setFailure(
          failedProducts.length > 0
            ? `Licences could not be read: ${failedProducts[0].error}`
            : "Google didn't recognise any licence product for this organisation."
        );
        setPhase("failed");
        return;
      }

      const accounts: DirectoryAccount[] = [];
      let pageToken: string | null = null;
      do {
        setProgress(`Reading accounts... ${accounts.length.toLocaleString()} so far`);
        const query: string = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await tfetch(
          `/api/admin/licenses/accounts${query}`,
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (!live()) return;
        if (!result.success) {
          setFailure(`Accounts could not be read: ${result.error || res.status}`);
          setPhase("failed");
          return;
        }
        accounts.push(...(result.data.accounts as DirectoryAccount[]));
        pageToken = result.data.nextPageToken;
      } while (pageToken);

      setScan({ assignments, accounts, productsRead, failedProducts, readAt: Date.now() });
      setProgress(
        `Complete. ${plural(assignments.length, "licence", "licences")} across ${plural(accounts.length, "account", "accounts")}.`
      );
      setPhase("done");
    } catch {
      if (ac.signal.aborted) {
        if (tenantIdRef.current === pinnedTenantId) {
          setPhase("cancelled");
          setProgress("Cancelled. Nothing was changed.");
        }
        return;
      }
      setFailure("Could not reach the server.");
      setPhase("failed");
    }
  }

  async function applyChange() {
    if (!change) return;
    const pinnedTenantId = tenantId;
    const target =
      change.kind === "remove"
        ? change.target
        : {
            user: change.user,
            productId: change.sku.productId,
            productName: change.sku.productName,
            skuId: change.sku.skuId,
            skuName: change.sku.skuName,
          };
    setChanging(true);
    setChangeError(null);
    try {
      const res = await tfetch(
        "/api/admin/licenses",
        {
          method: change.kind === "remove" ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: target.user,
            productId: target.productId,
            skuId: target.skuId,
            confirm: target.user,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (!result.success) {
        setChangeError(result.error || "Google refused the change.");
        return;
      }
      // Keep what's on screen true without reading everything again.
      const same = (a: LicenseAssignment) =>
        a.user === target.user && a.productId === target.productId && a.skuId === target.skuId;
      setScan((prev) =>
        prev
          ? {
              ...prev,
              assignments:
                change.kind === "remove"
                  ? prev.assignments.filter((a) => !same(a))
                  : [...prev.assignments.filter((a) => !same(a)), target],
            }
          : prev
      );
      setMessage({
        type: "success",
        text:
          change.kind === "remove"
            ? `Removed ${target.skuName} from ${target.user}.`
            : `Assigned ${target.skuName} to ${target.user}.`,
      });
      setChange(null);
      if (change.kind === "assign") setAssignUser("");
    } catch {
      if (tenantIdRef.current === pinnedTenantId) {
        setChangeError("Could not reach the server. Check licences again to see whether it went through.");
      }
    } finally {
      setChanging(false);
    }
  }

  function exportCsv() {
    if (!scan || !report) return;
    const byUser = new Map(scan.accounts.map((a) => [a.primaryEmail, a]));
    const flagged = new Map(report.reclaimable.map((r) => [`${r.user}|${skuValue(r)}`, r]));
    const rows = scan.assignments.map((a) => {
      const account = byUser.get(a.user);
      const flag = flagged.get(`${a.user}|${skuValue(a)}`);
      return [
        a.user,
        account?.fullName ?? "",
        a.skuName,
        a.productName,
        !account
          ? "not in directory"
          : account.suspended
            ? "suspended"
            : account.archived
              ? "archived"
              : "active",
        account?.lastLoginTime ?? "",
        flag ? reclaimReasonText(flag) : "",
      ];
    });
    downloadCsv(`licences-${new Date().toISOString().slice(0, 10)}.csv`, [
      ["user", "name", "licence", "product", "account", "last_sign_in", "may_be_unused"],
      ...rows,
    ]);
  }

  const reading = phase === "reading";
  const assignTarget = assignUser.trim().toLowerCase();
  const chosenSku = report?.skus.find((s) => skuValue(s) === assignSku) ?? null;
  const skuLabels = useMemo(
    () => Object.fromEntries((report?.skus ?? []).map((s) => [skuValue(s), s.skuName])),
    [report]
  );
  const changeTarget =
    change?.kind === "remove" ? change.target.user : change?.kind === "assign" ? change.user : "";

  return (
    <div>
      <PageHeader
        title="Licences"
        badge="Directory"
        description="See who holds each licence, find the ones sitting on suspended or long-idle accounts, and assign or remove them."
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="space-y-6">
        <Card data-testid="licenses-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ticket className="h-5 w-5" />
              Check licences
            </CardTitle>
            <CardDescription>
              Reads who holds each licence and sets it next to the directory.
              Nothing is changed by checking.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void check()} disabled={reading}>
                {reading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlayCircle className="h-4 w-4" />
                )}
                {scan || phase === "failed" || phase === "cancelled" ? "Check again" : "Check licences"}
              </Button>
              {reading && (
                <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                  <X className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              {scan && (
                <Button variant="secondary" onClick={exportCsv}>
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
              )}
            </div>
            {progress && phase !== "failed" && (
              <p role="status" data-testid="licenses-status" className="text-sm text-muted-foreground">
                {progress}
              </p>
            )}
            <FeedbackAlert message={failure ? { type: "error", text: failure } : null} />

            {setup && (
              <div
                data-testid="licenses-setup"
                className="space-y-3 rounded-lg border border-warning/30 bg-warning/8 p-4 text-sm"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p className="font-medium">
                    {setup.code === "scope_missing"
                      ? "Open Admin hasn't been allowed to manage licences yet"
                      : "The licensing API is switched off for Open Admin's key"}
                  </p>
                </div>
                {setup.code === "scope_missing" ? (
                  <>
                    <p>
                      This is a one-time step in the Google Admin console. Go to
                      Security, then Access and data control, then API controls,
                      then Manage Domain Wide Delegation. Edit Open Admin&apos;s
                      entry and add this to its list of scopes:
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded-md border bg-background px-2 py-1 font-mono text-xs break-all">
                        {setup.scope}
                      </code>
                      <CopyButton value={setup.scope} label="Copy scope" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The{" "}
                      <Link href="/setup" className="underline underline-offset-2">
                        Setup page
                      </Link>{" "}
                      checks every permission and shows which are still missing.
                      Google can take a few minutes to apply the change.
                    </p>
                  </>
                ) : (
                  <p>
                    This is a one-time step in the Google Cloud console. Open the
                    project Open Admin&apos;s key belongs to, go to APIs &amp;
                    Services, then Library, search for{" "}
                    <strong>Enterprise License Manager API</strong> and press
                    Enable. Google can take a few minutes to apply it.
                  </p>
                )}
                {setup.detail && (
                  <p className="text-xs text-muted-foreground break-words">
                    Google said: {setup.detail}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {scan && report && (
          <>
            <Card data-testid="licenses-skus">
              <CardHeader>
                <CardTitle>Licences in use</CardTitle>
                <CardDescription>
                  Google reports who holds each licence, not how many your
                  organisation has bought. For what is spare, see Billing, then
                  Subscriptions, in the Admin console.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {report.skus.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No account holds a licence of any product that was read.
                  </p>
                ) : (
                  report.skus.map((s) => (
                    <div
                      key={skuValue(s)}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{s.skuName}</p>
                        <p className="text-xs text-muted-foreground">{s.productName}</p>
                      </div>
                      {s.reclaimable > 0 && (
                        <Badge variant="warning">{`${s.reclaimable.toLocaleString()} may be unused`}</Badge>
                      )}
                      <span className="text-sm tabular-nums">
                        {`${s.assigned.toLocaleString()} assigned`}
                      </span>
                    </div>
                  ))
                )}
                {scan.failedProducts.length > 0 && (
                  <p className="text-xs text-danger-fg" data-testid="licenses-failed-products">
                    Could not be read, so not shown:{" "}
                    {scan.failedProducts.map((f) => `${f.name} (${f.error})`).join("; ")}
                  </p>
                )}
                {report.unknownHolders > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {`${plural(report.unknownHolders, "licence is", "licences are")} held by an address that isn't in the directory listing, usually because it changed while this was being read. Check again to clear it.`}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card data-testid="licenses-reclaimable">
              <CardHeader>
                <CardTitle>Probably paid for and not used</CardTitle>
                <CardDescription>
                  {report.reclaimable.length === 0
                    ? `No licence is on a suspended account, or on one nobody has signed in to for ${LICENSE_IDLE_DAYS} days.`
                    : `${plural(report.reclaimable.length, "licence", "licences")} on accounts that are suspended, or that nobody has signed in to for ${LICENSE_IDLE_DAYS} days. A suspended account still uses its licence.`}
                </CardDescription>
              </CardHeader>
              {report.reclaimable.length > 0 && (
                <CardContent className="space-y-2">
                  {report.reclaimable.slice(0, MAX_ROWS_SHOWN).map((r: ReclaimableLicense) => (
                    <div
                      key={`${r.user}|${skuValue(r)}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium break-all">{r.user}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.name ? `${r.name} · ${r.skuName}` : r.skuName}
                        </p>
                      </div>
                      <Badge variant={r.reason === "suspended" ? "destructive" : "warning"}>
                        {reclaimReasonText(r)}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setChangeError(null);
                          setChange({ kind: "remove", target: r });
                        }}
                      >
                        Remove licence
                      </Button>
                    </div>
                  ))}
                  {report.reclaimable.length > MAX_ROWS_SHOWN && (
                    <p className="text-xs text-muted-foreground">
                      {`Showing the first ${MAX_ROWS_SHOWN} of ${report.reclaimable.length.toLocaleString()}. The CSV export has them all.`}
                    </p>
                  )}
                </CardContent>
              )}
            </Card>

            {scan.failedProducts.length === 0 && report.unlicensed.length > 0 && (
              <Card data-testid="licenses-unlicensed">
                <CardHeader>
                  <CardTitle>Active accounts with no licence</CardTitle>
                  <CardDescription>
                    {`${plural(report.unlicensed.length, "account", "accounts")} can sign in but can't use mail, files or calendar until a licence is assigned.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {report.unlicensed.slice(0, MAX_ROWS_SHOWN).map((u) => (
                    <div
                      key={u.user}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium break-all">{u.user}</p>
                        {u.name && <p className="text-xs text-muted-foreground">{u.name}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAssignUser(u.user);
                          assignCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        Assign a licence
                      </Button>
                    </div>
                  ))}
                  {report.unlicensed.length > MAX_ROWS_SHOWN && (
                    <p className="text-xs text-muted-foreground">
                      {`Showing the first ${MAX_ROWS_SHOWN} of ${report.unlicensed.length.toLocaleString()}.`}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            <Card ref={assignCardRef} data-testid="licenses-assign">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserPlus className="h-5 w-5" />
                  Assign a licence
                </CardTitle>
                <CardDescription>
                  Choose from the licence types your organisation already uses.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {report.skus.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No licence type was found to choose from. Assign the first
                    one in the Google Admin console.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="assignUser">User email</Label>
                        <Input
                          id="assignUser"
                          value={assignUser}
                          onChange={(e) => setAssignUser(e.target.value)}
                          placeholder="jane@yourdomain.com"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Licence</Label>
                        <Select
                          value={assignSku}
                          onValueChange={(v) => v && setAssignSku(v)}
                          items={skuLabels}
                        >
                          <SelectTrigger className="w-full" aria-label="Licence to assign">
                            <SelectValue placeholder="Pick a licence..." />
                          </SelectTrigger>
                          <SelectContent>
                            {report.skus.map((s) => (
                              <SelectItem key={skuValue(s)} value={skuValue(s)}>
                                {s.skuName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={!isValidEmail(assignTarget) || !chosenSku}
                      onClick={() => {
                        if (!chosenSku) return;
                        setChangeError(null);
                        setChange({ kind: "assign", user: assignTarget, sku: chosenSku });
                      }}
                    >
                      <UserPlus className="h-4 w-4" />
                      Review &amp; assign
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <ConfirmActionDialog
        open={change !== null}
        onOpenChange={(open) => {
          if (!open && !changing) setChange(null);
        }}
        title={change?.kind === "assign" ? "Assign this licence" : "Remove this licence"}
        summary={
          change?.kind === "assign"
            ? "This account starts using one of your organisation's licences."
            : "This account stops using this licence, and what the licence gave it."
        }
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        confirmPhrase={changeTarget}
        confirmLabel={change?.kind === "assign" ? "Assign licence" : "Remove licence"}
        busy={changing}
        error={changeError}
        onConfirm={applyChange}
        changes={
          change?.kind === "assign"
            ? [
                { label: "Account", after: change.user, emphasis: true },
                { label: "Licence", after: change.sku.skuName },
              ]
            : change?.kind === "remove"
              ? [
                  { label: "Account", after: change.target.user, emphasis: true },
                  { label: "Licence", before: change.target.skuName, after: "None" },
                ]
              : []
        }
        warnings={
          change?.kind === "assign" ? (
            <p>
              If none of this type is spare, Google either refuses or adds one to
              your subscription and bills for it, depending on your plan.
            </p>
          ) : (
            <p>
              Google warns that removing a licence can lose the data the account
              has in the services it covered: mail, files, calendar. If the
              person has left, move what matters first (Offboarding does this),
              or archive the account in the Admin console to keep its data on a
              cheaper licence.
            </p>
          )
        }
      />
    </div>
  );
}
