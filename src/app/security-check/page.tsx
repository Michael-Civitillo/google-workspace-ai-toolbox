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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock,
  Download,
  Forward,
  KeyRound,
  Loader2,
  Plug,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import {
  compareApps,
  INACTIVE_DEFAULT_DAYS,
  INACTIVE_THRESHOLDS,
  isInactiveAt,
  mergeAppGrants,
  summariseAccess,
  type AccessLevel,
  type AppGrant,
  type ForwardingFinding,
  type InactiveFinding,
  type SecurityCheckPage,
  type TwoStepFinding,
  type UnreadAccount,
} from "@/lib/security-check";

type CheckId = "twoStep" | "inactive" | "forwarding" | "apps";
type Status = "idle" | "running" | "good" | "warning" | "critical" | "incomplete";

interface Totals {
  accounts: number;
  skippedSuspended: number;
  activeAccounts: number;
  admins: number;
  mailboxesChecked: number;
  withoutMailbox: number;
  internalForwards: number;
  appsChecked: number;
  mailboxErrors: number;
  appErrors: number;
}

const NO_TOTALS: Totals = {
  accounts: 0,
  skippedSuspended: 0,
  activeAccounts: 0,
  admins: 0,
  mailboxesChecked: 0,
  withoutMailbox: 0,
  internalForwards: 0,
  appsChecked: 0,
  mailboxErrors: 0,
  appErrors: 0,
};

/** Rows shown per list until the operator asks for the rest. */
const ROW_LIMIT = 100;
/** Per-account failure details kept for display; the counts are exact. */
const UNREAD_DETAIL_LIMIT = 200;

const STATUS: Record<
  Status,
  { label: string; icon: typeof CheckCircle2; className: string; spin?: boolean }
> = {
  idle: { label: "Not checked yet", icon: CircleDashed, className: "text-muted-foreground" },
  running: { label: "Checking…", icon: Loader2, className: "text-muted-foreground", spin: true },
  good: { label: "Nothing found", icon: CheckCircle2, className: "text-success-fg" },
  warning: { label: "Worth a look", icon: AlertTriangle, className: "text-warning-fg" },
  critical: { label: "Needs attention", icon: ShieldAlert, className: "text-danger-fg" },
  incomplete: { label: "Incomplete", icon: CircleDashed, className: "text-muted-foreground" },
};

const ACCESS: Record<
  AccessLevel,
  { label: string; variant: "destructive" | "warning" | "outline" }
> = {
  high: { label: "Broad access", variant: "destructive" },
  medium: { label: "Some access", variant: "warning" },
  low: { label: "Sign-in only", variant: "outline" },
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatIdle(days: number): string {
  if (days < 60) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30.44)} months`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days - years * 365) / 30.44);
  const y = `${years} year${years === 1 ? "" : "s"}`;
  return months > 0 ? `${y} ${months} month${months === 1 ? "" : "s"}` : y;
}

function csvCell(c: string): string {
  let v = c ?? "";
  // Guard against spreadsheet formula injection: app names, filter criteria
  // and forwarding addresses are all text somebody else chose.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.replace(/"/g, '""');
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

function toCsv(
  twoStep: TwoStepFinding[],
  inactive: InactiveFinding[],
  forwarding: ForwardingFinding[],
  apps: AppGrant[]
): string {
  const rows: string[][] = [
    ["check", "account", "name", "administrator", "finding", "target", "detail"],
  ];
  for (const f of twoStep) {
    rows.push([
      "No 2-Step Verification",
      f.user,
      f.name,
      f.admin ? "yes" : "no",
      "Not enrolled in 2-Step Verification",
      "",
      f.orgUnitPath,
    ]);
  }
  for (const f of inactive) {
    rows.push([
      "Inactive account",
      f.user,
      f.name,
      f.admin ? "yes" : "no",
      f.lastLoginTime ? `Last sign-in ${f.lastLoginTime}` : "Never signed in",
      "",
      f.idleDays === null ? "age unknown" : `${f.idleDays} days idle`,
    ]);
  }
  for (const f of forwarding) {
    rows.push([
      "Mail forwarded outside",
      f.user,
      f.name,
      "",
      f.kind === "auto-forward" ? "Mailbox forwarding" : "Forwarding filter",
      f.target,
      f.detail,
    ]);
  }
  for (const app of apps) {
    const access = summariseAccess(app.scopes);
    for (const user of app.users) {
      rows.push([
        "Connected app",
        user,
        "",
        "",
        `${app.name || "(unnamed app)"}: ${ACCESS[access.level].label}`,
        app.clientId,
        app.scopes.join(" "),
      ]);
    }
  }
  return rows.map((r) => r.map((c) => `"${csvCell(c)}"`).join(",")).join("\n");
}

function Tile({
  icon: Icon,
  label,
  value,
  note,
  status,
  selected,
  onSelect,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  note: string;
  status: Status;
  selected: boolean;
  onSelect: () => void;
}) {
  const s = STATUS[status];
  const StatusIcon = s.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors outline-none",
        "hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        selected ? "border-primary ring-1 ring-primary" : "border-border"
      )}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className="text-3xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
      <span className={cn("flex items-center gap-1.5 text-xs font-medium", s.className)}>
        <StatusIcon className={cn("h-3.5 w-3.5", s.spin && "animate-spin")} />
        {s.label}
      </span>
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>
  );
}

function Person({ name, user }: { name: string; user: string }) {
  return (
    <p className="truncate text-sm font-medium">{name ? `${name} · ${user}` : user}</p>
  );
}

export default function SecurityCheck() {
  const { id: tenantId } = useCurrentTenant();

  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  // Why a finished scan does not cover the whole tenant, if it doesn't.
  const [stopped, setStopped] = useState<"cancelled" | "failed" | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [twoStep, setTwoStep] = useState<TwoStepFinding[]>([]);
  const [inactive, setInactive] = useState<InactiveFinding[]>([]);
  const [forwarding, setForwarding] = useState<ForwardingFinding[]>([]);
  const [apps, setApps] = useState<AppGrant[]>([]);
  const [mailboxErrors, setMailboxErrors] = useState<UnreadAccount[]>([]);
  const [appErrors, setAppErrors] = useState<UnreadAccount[]>([]);
  const [message, setMessage] = useState<Feedback | null>(null);

  const [selected, setSelected] = useState<CheckId>("twoStep");
  const [threshold, setThreshold] = useState<number>(INACTIVE_DEFAULT_DAYS);
  const [showAll, setShowAll] = useState(false);
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [showUnread, setShowUnread] = useState(false);

  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  const reset = () => {
    setDone(false);
    setStopped(null);
    setTotals(null);
    setTwoStep([]);
    setInactive([]);
    setForwarding([]);
    setApps([]);
    setMailboxErrors([]);
    setAppErrors([]);
    setShowAll(false);
    setOpenApp(null);
    setShowUnread(false);
  };

  // Findings from tenant A must never be read as tenant B's: stop any scan in
  // flight and clear the page when the tenant changes.
  useEffect(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setScanning(false);
    setMessage(null);
    reset();
  }, [tenantId]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const runCheck = async () => {
    cancelRef.current = false;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const pinnedTenantId = tenantId;

    setMessage(null);
    reset();
    setTotals(NO_TOTALS);
    setScanning(true);

    const allApps = new Map<string, AppGrant>();
    let pageToken: string | null = null;
    let pages = 0;

    try {
      while (true) {
        const qs = new URLSearchParams();
        if (pageToken) qs.set("pageToken", pageToken);
        const res = await tfetch(
          `/api/admin/security-check?${qs.toString()}`,
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;
        if (!result.success) {
          setMessage({
            type: "error",
            text:
              pages === 0
                ? result.error || "Security check failed"
                : `The check stopped part-way: ${result.error || "request failed"}. What was found before that is shown below.`,
          });
          if (pages > 0) {
            setStopped("failed");
            setDone(true);
          } else {
            setTotals(null);
          }
          return;
        }

        const page = result.data as SecurityCheckPage;
        pages++;
        setTotals((t) => {
          const prev = t ?? NO_TOTALS;
          return {
            accounts: prev.accounts + page.accounts,
            skippedSuspended: prev.skippedSuspended + page.skippedSuspended,
            activeAccounts: prev.activeAccounts + page.activeAccounts,
            admins: prev.admins + page.admins,
            mailboxesChecked: prev.mailboxesChecked + page.mailboxesChecked,
            withoutMailbox: prev.withoutMailbox + page.withoutMailbox,
            internalForwards: prev.internalForwards + page.internalForwards,
            appsChecked: prev.appsChecked + page.appsChecked,
            mailboxErrors: prev.mailboxErrors + page.mailboxErrors.length,
            appErrors: prev.appErrors + page.appErrors.length,
          };
        });
        if (page.withoutTwoStep.length > 0) {
          setTwoStep((prev) => [...prev, ...page.withoutTwoStep]);
        }
        if (page.inactive.length > 0) {
          setInactive((prev) => [...prev, ...page.inactive]);
        }
        if (page.externalForwarding.length > 0) {
          setForwarding((prev) => [...prev, ...page.externalForwarding]);
        }
        if (page.apps.length > 0) {
          mergeAppGrants(allApps, page.apps);
          setApps([...allApps.values()].map((a) => ({ ...a })).sort(compareApps));
        }
        if (page.mailboxErrors.length > 0) {
          setMailboxErrors((prev) =>
            [...prev, ...page.mailboxErrors].slice(0, UNREAD_DETAIL_LIMIT)
          );
        }
        if (page.appErrors.length > 0) {
          setAppErrors((prev) =>
            [...prev, ...page.appErrors].slice(0, UNREAD_DETAIL_LIMIT)
          );
        }

        pageToken = page.nextPageToken;
        if (cancelRef.current || !pageToken) break;
      }
      if (cancelRef.current) setStopped("cancelled");
      setDone(true);
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (ac.signal.aborted) {
        if (cancelRef.current) {
          setStopped("cancelled");
          setDone(true);
        }
      } else {
        setMessage({
          type: "error",
          text:
            pages === 0
              ? "Failed to connect to the API"
              : "The connection dropped part-way through. What was found before that is shown below.",
        });
        if (pages > 0) {
          setStopped("failed");
          setDone(true);
        } else {
          setTotals(null);
        }
      }
    } finally {
      if (tenantIdRef.current === pinnedTenantId) setScanning(false);
    }
  };

  const cancelCheck = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const twoStepSorted = useMemo(
    () =>
      [...twoStep].sort(
        (a, b) => Number(b.admin) - Number(a.admin) || a.user.localeCompare(b.user)
      ),
    [twoStep]
  );
  const inactiveShown = useMemo(
    () =>
      inactive
        .filter((f) => isInactiveAt(f, threshold))
        // Longest idle first; unknown age leads because it is the least certain.
        .sort(
          (a, b) =>
            (b.idleDays ?? Number.MAX_SAFE_INTEGER) - (a.idleDays ?? Number.MAX_SAFE_INTEGER) ||
            a.user.localeCompare(b.user)
        ),
    [inactive, threshold]
  );
  const appRows = useMemo(
    () => apps.map((app) => ({ app, access: summariseAccess(app.scopes) })),
    [apps]
  );

  const adminsWithoutTwoStep = twoStep.filter((f) => f.admin).length;
  const forwardingMailboxes = new Set(forwarding.map((f) => f.user)).size;
  const hiddenForwards = forwarding.filter((f) => f.hidesOriginal).length;
  const broadApps = appRows.filter((r) => r.access.level === "high").length;
  const hasResults = totals !== null;
  const partial = stopped !== null;

  /**
   * "Nothing found" is a claim about the whole tenant. It is only made when the
   * scan finished and every account that check depends on could be read.
   */
  const statusFor = (
    findings: number,
    severity: "warning" | "critical",
    unread: number
  ): Status => {
    if (!hasResults) return "idle";
    if (findings > 0) return severity;
    if (scanning) return "running";
    if (partial || unread > 0) return "incomplete";
    return "good";
  };

  const status: Record<CheckId, Status> = {
    twoStep: statusFor(twoStep.length, adminsWithoutTwoStep > 0 ? "critical" : "warning", 0),
    inactive: statusFor(inactiveShown.length, "warning", 0),
    forwarding: statusFor(
      forwarding.length,
      hiddenForwards > 0 ? "critical" : "warning",
      totals?.mailboxErrors ?? 0
    ),
    apps: statusFor(broadApps, "warning", totals?.appErrors ?? 0),
  };

  const progressLine = () => {
    if (!totals) return "";
    const parts = [plural(totals.activeAccounts, "active account") + " checked"];
    if (totals.skippedSuspended > 0) {
      parts.push(`${totals.skippedSuspended.toLocaleString()} suspended or archived skipped`);
    }
    const state = scanning
      ? "Checking…"
      : stopped === "cancelled"
        ? "Cancelled: results cover only part of the tenant."
        : stopped === "failed"
          ? "Stopped early: results cover only part of the tenant."
          : done
            ? "Complete."
            : "";
    return `${state} ${parts.join(" · ")}`.trim();
  };

  const exportCsv = () => {
    downloadCsv(
      `security-check-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(twoStepSorted, inactiveShown, forwarding, apps)
    );
  };

  const select = (id: CheckId) => {
    setSelected(id);
    setShowAll(false);
    setOpenApp(null);
  };

  const limited = <T,>(rows: T[]): T[] => (showAll ? rows : rows.slice(0, ROW_LIMIT));
  const more = (count: number) =>
    !showAll && count > ROW_LIMIT ? (
      <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAll(true)}>
        Show all {count.toLocaleString()}
      </Button>
    ) : null;

  const emptyText = (clean: string) =>
    !hasResults
      ? "Run the check to see results."
      : scanning
        ? "Nothing found yet…"
        : partial
          ? "Nothing found in the part of the tenant that was checked."
          : clean;

  const anythingFound =
    twoStep.length + inactive.length + forwarding.length + apps.length > 0;
  const unreadTotal = (totals?.mailboxErrors ?? 0) + (totals?.appErrors ?? 0);

  return (
    <>
      <PageHeader
        title="Security Check"
        description="One pass over the tenant for the four things that most often lead to trouble: accounts without 2-Step Verification, accounts nobody uses, mail forwarded outside the organisation, and outside apps holding access to your data. It only reads; nothing is changed."
        badge="Audit"
        actions={
          <>
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={scanning || !anythingFound}
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            {scanning ? (
              <Button variant="secondary" onClick={cancelCheck}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            ) : (
              <Button onClick={() => void runCheck()}>
                <ShieldCheck className="h-4 w-4" />
                {hasResults ? "Run again" : "Run check"}
              </Button>
            )}
          </>
        }
      />

      <FeedbackAlert message={message} className="mb-6" />

      {totals && (
        <div
          className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          {scanning && <Loader2 className="h-4 w-4 animate-spin" />}
          <span>{progressLine()}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          icon={KeyRound}
          label="No 2-Step Verification"
          value={hasResults ? twoStep.length.toLocaleString() : "–"}
          note={
            !hasResults
              ? "Accounts protected by a password alone"
              : adminsWithoutTwoStep > 0
                ? `including ${plural(adminsWithoutTwoStep, "administrator")}`
                : `of ${plural(totals.activeAccounts, "active account")}`
          }
          status={status.twoStep}
          selected={selected === "twoStep"}
          onSelect={() => select("twoStep")}
        />
        <Tile
          icon={Clock}
          label="Inactive accounts"
          value={hasResults ? inactiveShown.length.toLocaleString() : "–"}
          note={`No sign-in for ${threshold} days or more`}
          status={status.inactive}
          selected={selected === "inactive"}
          onSelect={() => select("inactive")}
        />
        <Tile
          icon={Forward}
          label="Mail forwarded outside"
          value={hasResults ? forwardingMailboxes.toLocaleString() : "–"}
          note={
            !hasResults
              ? "Mailboxes sending mail to outside addresses"
              : hiddenForwards > 0
                ? `${plural(hiddenForwards, "forward")} hiding the original`
                : `of ${plural(totals.mailboxesChecked, "mailbox", "mailboxes")} read`
          }
          status={status.forwarding}
          selected={selected === "forwarding"}
          onSelect={() => select("forwarding")}
        />
        <Tile
          icon={Plug}
          label="Apps with broad access"
          value={hasResults ? broadApps.toLocaleString() : "–"}
          note={
            !hasResults
              ? "Outside apps that can read mail or files"
              : `of ${plural(apps.length, "connected app")}`
          }
          status={status.apps}
          selected={selected === "apps"}
          onSelect={() => select("apps")}
        />
      </div>

      <Card className="mt-6">
        {selected === "twoStep" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Accounts without 2-Step Verification
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  A password is all that protects these accounts, so a guessed
                  or stolen one is enough to get in. Administrators matter
                  most. To require a second step, use the Google Admin console:
                  Security → Authentication → 2-Step Verification.
                </span>
                <span className="block">
                  If people sign in through another identity provider (Okta,
                  Microsoft Entra ID and the like), the second step happens
                  there and Google reports everyone as not enrolled. In that
                  case this list doesn&apos;t tell you anything.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {twoStepSorted.length === 0 ? (
                <Empty>
                  {emptyText("Every active account is enrolled in 2-Step Verification.")}
                </Empty>
              ) : (
                <>
                  {limited(twoStepSorted).map((f) => (
                    <div
                      key={f.user}
                      className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3"
                    >
                      <div className="min-w-0">
                        <Person name={f.name} user={f.user} />
                        {f.orgUnitPath !== "/" && (
                          <p className="text-xs text-muted-foreground">
                            Organisational unit {f.orgUnitPath}
                          </p>
                        )}
                      </div>
                      {f.admin && <Badge variant="destructive">administrator</Badge>}
                    </div>
                  ))}
                  {more(twoStepSorted.length)}
                </>
              )}
            </CardContent>
          </>
        )}

        {selected === "inactive" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Inactive accounts
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  Accounts that are still active but that nobody has signed in
                  to. An unused account keeps its password and its licence, and
                  nobody would notice it being used. If the person has left,{" "}
                  <Link href="/offboarding" className="underline underline-offset-2">
                    Offboarding
                  </Link>{" "}
                  closes the account down properly.
                </span>
                <span className="block">
                  This goes by the last sign-in Google recorded. A shared or
                  service mailbox that is only reached through delegation or a
                  mail client can look idle while still in use, so check before
                  suspending.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">No sign-in for at least</span>
                {INACTIVE_THRESHOLDS.map((days) => (
                  <Button
                    key={days}
                    size="xs"
                    variant={threshold === days ? "default" : "outline"}
                    aria-pressed={threshold === days}
                    onClick={() => {
                      setThreshold(days);
                      setShowAll(false);
                    }}
                  >
                    {days === 365 ? "1 year" : `${days} days`}
                  </Button>
                ))}
              </div>
              {inactiveShown.length === 0 ? (
                <Empty>
                  {emptyText(
                    `Every active account has been signed in to within the last ${threshold} days.`
                  )}
                </Empty>
              ) : (
                <>
                  {limited(inactiveShown).map((f) => (
                    <div
                      key={f.user}
                      className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3"
                    >
                      <div className="min-w-0">
                        <Person name={f.name} user={f.user} />
                        <p className="text-xs text-muted-foreground">
                          {f.lastLoginTime
                            ? `Last signed in ${formatDate(f.lastLoginTime)}`
                            : f.creationTime
                              ? `Never signed in · created ${formatDate(f.creationTime)}`
                              : "Never signed in · creation date unknown"}
                          {f.idleDays !== null && (
                            <>
                              {" · "}
                              <span className="font-medium text-foreground">
                                {formatIdle(f.idleDays)}
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                      {f.admin && <Badge variant="warning">administrator</Badge>}
                    </div>
                  ))}
                  {more(inactiveShown.length)}
                </>
              )}
            </CardContent>
          </>
        )}

        {selected === "forwarding" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Forward className="h-5 w-5" />
                Mail forwarded outside the organisation
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  Mailboxes that send incoming mail to an address outside your
                  verified domains, through the mailbox&apos;s forwarding
                  setting or through a filter. Sometimes that is deliberate. It
                  is also the first thing an intruder sets up after getting
                  into a mailbox, usually with the original deleted so the
                  owner never sees it.
                </span>
                <span className="block">
                  Ask the owner about anything you don&apos;t recognise.{" "}
                  <Link href="/audit" className="underline underline-offset-2">
                    User Audit
                  </Link>{" "}
                  shows everything else that has access to a mailbox.
                  {totals && totals.internalForwards > 0
                    ? ` ${plural(totals.internalForwards, "forward")} to addresses inside the organisation ${
                        totals.internalForwards === 1 ? "is" : "are"
                      } not listed.`
                    : ""}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {forwarding.length === 0 ? (
                <Empty>{emptyText("No mailbox forwards mail outside the organisation.")}</Empty>
              ) : (
                <>
                  {limited(forwarding).map((f, i) => (
                    <div
                      key={`${f.user}|${f.kind}|${f.target}|${i}`}
                      className="space-y-1 rounded-lg border bg-muted/30 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Person name={f.name} user={f.user} />
                        <Badge variant="outline">
                          {f.kind === "auto-forward" ? "all mail" : "filter"}
                        </Badge>
                        {f.hidesOriginal && (
                          <Badge variant="destructive">hides the original</Badge>
                        )}
                      </div>
                      <p className="text-sm">
                        <span className="text-muted-foreground">to </span>
                        <span className="font-medium break-all">{f.target}</span>
                      </p>
                      <p className="text-xs text-muted-foreground break-words">{f.detail}</p>
                    </div>
                  ))}
                  {more(forwarding.length)}
                </>
              )}
            </CardContent>
          </>
        )}

        {selected === "apps" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-5 w-5" />
                Connected apps
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  Apps that people have let into their Google account.{" "}
                  <span className="font-medium text-foreground">Broad access</span>{" "}
                  means the app can read mail, every file in Drive, or admin
                  settings: worth knowing who made each one and why it needs
                  that. To block an app for everyone, use the Google Admin
                  console: Security → Access and data control → API controls.
                </span>
                <span className="block">
                  Names are whatever the app calls itself and are not verified;
                  the client ID is what identifies it. Google&apos;s own apps
                  (Chrome, and Android and iOS account access) are listed too
                  and normally hold broad access.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {appRows.length === 0 ? (
                <Empty>{emptyText("Nobody has connected an outside app.")}</Empty>
              ) : (
                <>
                  {limited(appRows).map(({ app, access }) => {
                    const open = openApp === app.clientId;
                    return (
                      <div key={app.clientId} className="rounded-lg border bg-muted/30">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenApp(open ? null : app.clientId)}
                          className="flex w-full items-start justify-between gap-3 p-3 text-left"
                        >
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {app.name || "(unnamed app)"}
                              </p>
                              <Badge variant={ACCESS[access.level].variant}>
                                {ACCESS[access.level].label}
                              </Badge>
                              {app.anonymous && <Badge variant="warning">anonymous</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {access.areas.length > 0
                                ? access.areas.map((a) => a.area).join(" · ")
                                : "No permissions listed"}
                            </p>
                          </div>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                            {plural(app.users.length, "person", "people")}
                            {open ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </span>
                        </button>
                        {open && (
                          <div className="space-y-3 border-t px-3 py-3 text-xs">
                            <div>
                              <p className="font-medium">Client ID</p>
                              <p className="font-mono text-muted-foreground break-all">
                                {app.clientId}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium">Granted by</p>
                              <p className="text-muted-foreground break-words">
                                {app.users.slice(0, 50).join(", ")}
                                {app.users.length > 50
                                  ? `, and ${(app.users.length - 50).toLocaleString()} more (all in the CSV export)`
                                  : ""}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium">Permissions</p>
                              <ul className="font-mono text-muted-foreground">
                                {app.scopes.map((scope) => (
                                  <li key={scope} className="break-all">
                                    {scope}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {more(appRows.length)}
                </>
              )}
            </CardContent>
          </>
        )}
      </Card>

      {totals && unreadTotal > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning-fg" />
              Some accounts couldn&apos;t be read
            </CardTitle>
            <CardDescription>
              {[
                totals.mailboxErrors > 0
                  ? `Forwarding settings for ${plural(totals.mailboxErrors, "mailbox", "mailboxes")}`
                  : null,
                totals.appErrors > 0
                  ? `connected apps for ${plural(totals.appErrors, "account")}`
                  : null,
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              could not be read, so the results above don&apos;t cover them. If
              it is every account, the service account is probably missing a
              permission: check Setup.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setShowUnread((v) => !v)}
              >
                {showUnread ? "Hide details" : "Show details"}
              </button>
            </CardDescription>
          </CardHeader>
          {showUnread && (
            <CardContent>
              <ul className="space-y-1 text-xs">
                {[
                  ...mailboxErrors.map((e) => ({ ...e, what: "mailbox" })),
                  ...appErrors.map((e) => ({ ...e, what: "apps" })),
                ].map((e, i) => (
                  <li key={`${e.what}|${e.user}|${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{e.user}</span>
                    <span className="text-muted-foreground">
                      {e.what}: {e.error}
                    </span>
                  </li>
                ))}
              </ul>
              {unreadTotal > mailboxErrors.length + appErrors.length && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the first {(mailboxErrors.length + appErrors.length).toLocaleString()}.
                </p>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {totals && totals.withoutMailbox > 0 && !scanning && (
        <p className="mt-4 text-xs text-muted-foreground">
          {plural(totals.withoutMailbox, "active account")}{" "}
          {totals.withoutMailbox === 1 ? "has" : "have"} no Gmail mailbox, so
          there was no forwarding to check.
        </p>
      )}
    </>
  );
}
