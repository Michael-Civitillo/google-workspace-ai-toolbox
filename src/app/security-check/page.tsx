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
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
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
  MailCheck,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import {
  compareApps,
  delegationNeedsReview,
  emailAuthKeys,
  findingKey,
  INACTIVE_DEFAULT_DAYS,
  INACTIVE_THRESHOLDS,
  isInactiveAt,
  mergeAppGrants,
  REVOKE_APP_BATCH,
  SNAPSHOT_MAX_KEYS,
  snapshotKeys,
  summariseAccess,
  type AccessLevel,
  type AppGrant,
  type CheckName,
  type DelegatedClient,
  type DelegationReport,
  type ForwardingFinding,
  type InactiveFinding,
  type SecurityCheckPage,
  type TwoStepFinding,
  type UnreadAccount,
} from "@/lib/security-check";
import {
  emailAuthIncomplete,
  emailAuthNeedsReview,
  type DomainEmailAuth,
  type EmailAuthReport,
  type RecordCheck,
  type Verdict,
} from "@/lib/email-auth";

type CheckId = CheckName;
type Status =
  | "idle"
  | "running"
  | "good"
  | "warning"
  | "critical"
  | "incomplete"
  | "quiet";

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

/** A finding the operator has chosen to fix, awaiting their confirmation. */
type Fix =
  | { type: "forwarding"; finding: ForwardingFinding }
  | { type: "app-user"; app: AppGrant; user: string }
  | { type: "app-all"; app: AppGrant };

/** People listed individually (each with its own Revoke) under an app. */
const APP_USERS_SHOWN = 50;

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
  // For a check that can only see recent history: nothing to act on, which is
  // not the same as a clean bill of health.
  quiet: {
    label: "Nothing recent to review",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
};

const VERDICT: Record<
  Verdict,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  ok: { label: "In place", icon: CheckCircle2, className: "text-success-fg" },
  warn: { label: "Weak", icon: AlertTriangle, className: "text-warning-fg" },
  bad: { label: "Missing or broken", icon: ShieldAlert, className: "text-danger-fg" },
  unknown: { label: "Can't tell", icon: CircleDashed, className: "text-muted-foreground" },
  error: { label: "Not checked", icon: CircleDashed, className: "text-muted-foreground" },
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
  apps: AppGrant[],
  delegated: DelegatedClient[],
  domains: DomainEmailAuth[]
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
  for (const client of delegated) {
    rows.push([
      "Domain-wide delegation",
      client.lastActor,
      "",
      "",
      `${client.status === "authorized" ? "Delegation granted" : "Delegation removed"}${
        client.ownApp ? " (Open Admin's own service account)" : ""
      } on ${client.lastChange}`,
      client.clientId,
      client.scopes.join(" "),
    ]);
  }
  for (const d of domains) {
    for (const [name, check] of [
      ["SPF", d.spf],
      ["DKIM", d.dkim],
      ["DMARC", d.dmarc],
    ] as Array<[string, RecordCheck]>) {
      if (check.verdict === "ok") continue;
      rows.push([
        "Email authentication",
        d.domain,
        "",
        "",
        `${name}: ${VERDICT[check.verdict].label}`,
        check.record ?? "",
        check.summary,
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
  fresh = 0,
  selected,
  onSelect,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  note: string;
  status: Status;
  /** Findings in this check that the previous scan did not have. */
  fresh?: number;
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
      <span className="flex min-h-10 items-start gap-2 text-sm text-muted-foreground xl:min-h-0">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        {label}
      </span>
      <span className="flex items-center gap-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight">{value}</span>
        {fresh > 0 && <Badge variant="accent">{fresh.toLocaleString()} new</Badge>}
      </span>
      <span className="text-xs text-muted-foreground">{note}</span>
      <span
        className={cn("mt-auto flex items-center gap-1.5 text-xs font-medium", s.className)}
      >
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
  const { tenant, id: tenantId } = useCurrentTenant();

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
  // Domain-wide delegation is tenant-wide, so it is one request beside the
  // account scan rather than part of each page of it.
  const [delegation, setDelegation] = useState<DelegationReport | null>(null);
  const [delegationError, setDelegationError] = useState<string | null>(null);
  const [delegationLoading, setDelegationLoading] = useState(false);
  // Email authentication is tenant-wide too: one request, public DNS.
  const [emailAuth, setEmailAuth] = useState<EmailAuthReport | null>(null);
  const [emailAuthError, setEmailAuthError] = useState<string | null>(null);
  const [emailAuthLoading, setEmailAuthLoading] = useState(false);
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [message, setMessage] = useState<Feedback | null>(null);

  const [selected, setSelected] = useState<CheckId>("twoStep");
  const [threshold, setThreshold] = useState<number>(INACTIVE_DEFAULT_DAYS);
  const [showAll, setShowAll] = useState(false);
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [openClient, setOpenClient] = useState<string | null>(null);
  const [showUnread, setShowUnread] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  // The scan before this one, read when a scan starts: what "new" is measured
  // against. null means there is nothing to compare with.
  const [baseline, setBaseline] = useState<{
    completedAt: string;
    keys: Set<string>;
    covered: Set<string>;
  } | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);

  const cancelRef = useRef(false);
  // The run whose result has been stored as the next baseline, so a finished
  // scan is remembered once however often the page re-renders afterwards.
  const savedRunRef = useRef<AbortController | null>(null);
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
    setDelegation(null);
    setDelegationError(null);
    setDelegationLoading(false);
    setEmailAuth(null);
    setEmailAuthError(null);
    setEmailAuthLoading(false);
    setOpenDomain(null);
    setShowAll(false);
    setOpenApp(null);
    setOpenClient(null);
    setShowUnread(false);
    setFix(null);
    setFixBusy(false);
    setFixError(null);
    setBaseline(null);
    setOnlyNew(false);
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

    // Not awaited: the admin log is read while the accounts are scanned. The
    // `abortRef.current === ac` checks keep a slow answer from an earlier run
    // from landing in this one.
    const current = () =>
      tenantIdRef.current === pinnedTenantId && abortRef.current === ac;
    const tenantWide = async <T,>(
      url: string,
      onData: (data: T) => void,
      onError: (error: string) => void,
      setLoading: (loading: boolean) => void,
      fallback: string
    ) => {
      setLoading(true);
      try {
        const res = await tfetch(url, { signal: ac.signal }, pinnedTenantId);
        const result = await res.json();
        if (!current()) return;
        if (result.success) onData(result.data as T);
        else onError(result.error || fallback);
      } catch {
        if (current() && !ac.signal.aborted) onError("Failed to connect to the API");
      } finally {
        if (current()) setLoading(false);
      }
    };
    void tenantWide<DelegationReport>(
      "/api/admin/security-check/delegation",
      setDelegation,
      setDelegationError,
      setDelegationLoading,
      "The admin log could not be read"
    );
    void tenantWide<EmailAuthReport>(
      "/api/admin/security-check/email-auth",
      setEmailAuth,
      setEmailAuthError,
      setEmailAuthLoading,
      "The domains could not be checked"
    );

    const allApps = new Map<string, AppGrant>();
    let pageToken: string | null = null;
    let pages = 0;

    try {
      // What the last finished scan found, so this one can mark what is new.
      // Local and quick; if it can't be read the scan simply has no markers.
      try {
        const res = await tfetch(
          "/api/admin/security-check/history",
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;
        if (result.success && result.data) {
          setBaseline({
            completedAt: result.data.completedAt,
            keys: new Set<string>(result.data.keys),
            covered: new Set<string>(result.data.covered),
          });
        }
      } catch {
        if (ac.signal.aborted) throw new Error("aborted");
      }

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

  const postJson = (url: string, body: unknown) =>
    tfetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      tenantId
    );

  const openFix = (next: Fix) => {
    setMessage(null);
    setFixError(null);
    setFix(next);
  };

  const fixForwarding = async (f: ForwardingFinding) => {
    setFixBusy(true);
    setFixError(null);
    try {
      const res = await postJson("/api/admin/security-check/forwarding", {
        user: f.user,
        kind: f.kind,
        filterId: f.filterId ?? undefined,
        target: f.target,
        // The dialog only enables Confirm once this exact address was typed.
        confirm: f.user,
      });
      const result = await res.json();
      if (!result.success) {
        // Stay in the dialog: that is where the operator is looking.
        setFixError(result.error || "The change could not be made");
        return;
      }
      setForwarding((prev) => prev.filter((x) => x !== f));
      setFix(null);
      setMessage({
        type: "success",
        text: !result.data?.changed
          ? `${f.user} was already no longer forwarding to ${f.target}`
          : f.kind === "filter"
            ? `Deleted the filter that forwarded ${f.user}'s mail to ${f.target}`
            : `Turned off forwarding from ${f.user} to ${f.target}`,
      });
    } catch {
      setFixError("Failed to connect to the API");
    } finally {
      setFixBusy(false);
    }
  };

  const revokeApp = async (app: AppGrant, users: string[]) => {
    if (users.length === 0) {
      setFix(null);
      return;
    }
    setFixBusy(true);
    setFixError(null);
    const single = users.length === 1;
    const revoked: string[] = [];
    let firstError: string | null = null;
    let failed = 0;
    try {
      for (let i = 0; i < users.length; i += REVOKE_APP_BATCH) {
        const batch = users.slice(i, i + REVOKE_APP_BATCH);
        const res = await postJson("/api/admin/security-check/revoke-app", {
          clientId: app.clientId,
          users: batch,
          batchOf: users.length,
          confirm: single ? users[0] : "REVOKE",
        });
        const result = await res.json();
        if (!result.success) {
          failed += users.length - i;
          firstError ??= result.error || "The request was refused";
          break;
        }
        for (const r of result.data.results as Array<{ user: string; error?: string }>) {
          if (r.error) {
            failed++;
            firstError ??= `${r.user}: ${r.error}`;
          } else {
            revoked.push(r.user);
          }
        }
      }
    } catch {
      failed += users.length - revoked.length - failed;
      firstError ??= "Failed to connect to the API";
    } finally {
      setFixBusy(false);
    }

    if (revoked.length > 0) {
      const gone = new Set(revoked);
      setApps((prev) =>
        prev
          .map((a) =>
            a.clientId === app.clientId
              ? { ...a, users: a.users.filter((u) => !gone.has(u)) }
              : a
          )
          .filter((a) => a.users.length > 0)
      );
    }
    const name = app.name || app.clientId;
    if (failed > 0) {
      setFixError(
        `${revoked.length > 0 ? `Revoked for ${plural(revoked.length, "account")}. ` : ""}${plural(failed, "account")} could not be revoked. ${firstError ?? ""}`
      );
      return;
    }
    setFix(null);
    setMessage({
      type: "success",
      text: single
        ? `Revoked ${name}'s access to ${users[0]}`
        : `Revoked ${name}'s access for ${plural(revoked.length, "account")}`,
    });
  };

  const confirmFix = () => {
    if (!fix) return;
    if (fix.type === "forwarding") return fixForwarding(fix.finding);
    if (fix.type === "app-user") return revokeApp(fix.app, [fix.user]);
    // Whoever still has it connected now, not when the dialog opened: a retry
    // after a partial failure must not re-send the accounts already done.
    const current = apps.find((a) => a.clientId === fix.app.clientId);
    return revokeApp(fix.app, current?.users ?? []);
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

  const delegatedAll = useMemo(() => delegation?.clients ?? [], [delegation]);
  const domainsAll = useMemo(() => emailAuth?.domains ?? [], [emailAuth]);

  // Remember a scan that covered the whole tenant as the baseline for the next
  // one. Waits for the delegation request, which runs beside the account scan.
  useEffect(() => {
    if (!done || scanning || stopped !== null || delegationLoading || emailAuthLoading) {
      return;
    }
    const run = abortRef.current;
    if (!run || savedRunRef.current === run) return;
    savedRunRef.current = run;
    const keys = snapshotKeys({
      twoStep,
      inactive,
      forwarding,
      apps,
      delegated: delegatedAll,
      domains: domainsAll,
    });
    if (keys.length > SNAPSHOT_MAX_KEYS) return;
    const covered: CheckName[] = ["twoStep", "inactive", "forwarding", "apps"];
    if (delegation) covered.push("delegation");
    // Only a run where every lookup was answered is a baseline: a record
    // that could not be looked up then must not look new when it can be.
    if (emailAuth && !domainsAll.some(emailAuthIncomplete)) covered.push("emailAuth");
    tfetch(
      "/api/admin/security-check/history",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedAt: new Date().toISOString(), keys, covered }),
      },
      tenantId
    ).catch(() => {
      // Losing the baseline costs the next scan its "new" markers, nothing more.
    });
  }, [
    done,
    scanning,
    stopped,
    delegationLoading,
    delegation,
    delegatedAll,
    emailAuthLoading,
    emailAuth,
    domainsAll,
    twoStep,
    inactive,
    forwarding,
    apps,
    tenantId,
  ]);

  /** New since the previous scan, for a check that scan actually covered. */
  const isNew = (check: CheckName, key: string) =>
    baseline !== null && baseline.covered.has(check) && !baseline.keys.has(key);
  const newTwoStep = (f: TwoStepFinding) => isNew("twoStep", findingKey.twoStep(f));
  const newInactive = (f: InactiveFinding) =>
    isNew("inactive", findingKey.inactive(f, threshold));
  const newForwarding = (f: ForwardingFinding) =>
    isNew("forwarding", findingKey.forwarding(f));
  const newApp = (app: AppGrant) => isNew("apps", findingKey.app(app));
  const newClient = (client: DelegatedClient) =>
    isNew("delegation", findingKey.delegation(client));
  const newDomain = (d: DomainEmailAuth) =>
    emailAuthKeys(d).some((key) => isNew("emailAuth", key));

  const adminsWithoutTwoStep = twoStep.filter((f) => f.admin).length;
  const forwardingMailboxes = new Set(forwarding.map((f) => f.user)).size;
  const hiddenForwards = forwarding.filter((f) => f.hidesOriginal).length;
  const broadApps = appRows.filter((r) => r.access.level === "high").length;
  const delegationToReview = delegatedAll.filter(delegationNeedsReview).length;

  // The lists as shown: everything, or only what the last scan didn't have.
  const twoStepList = onlyNew ? twoStepSorted.filter(newTwoStep) : twoStepSorted;
  const inactiveList = onlyNew ? inactiveShown.filter(newInactive) : inactiveShown;
  const forwardingList = onlyNew ? forwarding.filter(newForwarding) : forwarding;
  const appList = onlyNew ? appRows.filter((r) => newApp(r.app)) : appRows;
  const delegatedClients = onlyNew ? delegatedAll.filter(newClient) : delegatedAll;
  const domainList = onlyNew ? domainsAll.filter(newDomain) : domainsAll;
  const domainsToReview = domainsAll.filter(emailAuthNeedsReview).length;
  const domainsUnchecked = domainsAll.filter(emailAuthIncomplete).length;
  const domainsBroken = domainsAll.some((d) =>
    [d.spf, d.dkim, d.dmarc].some((c) => c.verdict === "bad")
  );
  const freshCount = {
    twoStep: twoStepSorted.filter(newTwoStep).length,
    inactive: inactiveShown.filter(newInactive).length,
    forwarding: new Set(forwarding.filter(newForwarding).map((f) => f.user)).size,
    apps: appRows.filter((r) => r.access.level === "high" && newApp(r.app)).length,
    delegation: delegatedAll.filter((c) => delegationNeedsReview(c) && newClient(c)).length,
    emailAuth: domainsAll.filter((d) => emailAuthNeedsReview(d) && newDomain(d)).length,
  };
  const anythingNew =
    twoStepSorted.some(newTwoStep) ||
    inactiveShown.some(newInactive) ||
    forwarding.some(newForwarding) ||
    apps.some(newApp) ||
    delegatedAll.some(newClient) ||
    domainsAll.some(newDomain);
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
    // Never "Nothing found": the log only reaches back six months, so an empty
    // answer is not evidence that no app holds delegation.
    delegation: !hasResults
      ? "idle"
      : delegationLoading
        ? "running"
        : !delegation
          ? "incomplete"
          : delegationToReview > 0
            ? "warning"
            : "quiet",
    // DNS answers are complete answers, so this check can say "Nothing found",
    // but only when every lookup for every domain was actually answered.
    emailAuth: !hasResults
      ? "idle"
      : emailAuthLoading
        ? "running"
        : !emailAuth
          ? "incomplete"
          : domainsToReview > 0
            ? domainsBroken
              ? "critical"
              : "warning"
            : domainsUnchecked > 0
              ? "incomplete"
              : "good",
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
      toCsv(twoStepSorted, inactiveShown, forwarding, apps, delegatedAll, domainsAll)
    );
  };

  const select = (id: CheckId) => {
    setSelected(id);
    setShowAll(false);
    setOpenApp(null);
    setOpenClient(null);
    setOpenDomain(null);
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
      : onlyNew
        ? "Nothing new here since the last scan."
        : scanning
        ? "Nothing found yet…"
        : partial
          ? "Nothing found in the part of the tenant that was checked."
          : clean;

  const anythingFound =
    twoStep.length +
      inactive.length +
      forwarding.length +
      apps.length +
      delegatedAll.length +
      domainsToReview >
    0;
  const unreadTotal = (totals?.mailboxErrors ?? 0) + (totals?.appErrors ?? 0);

  return (
    <>
      <PageHeader
        title="Security Check"
        description="One pass over the tenant for the things that most often lead to trouble: accounts without 2-Step Verification, accounts nobody uses, mail forwarded outside the organisation, outside apps holding access to your data, apps granted domain-wide delegation, and domains other people could send mail as. Scanning only reads; nothing changes unless you press a fix button and confirm it."
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
          fresh={freshCount.twoStep}
          selected={selected === "twoStep"}
          onSelect={() => select("twoStep")}
        />
        <Tile
          icon={Clock}
          label="Inactive accounts"
          value={hasResults ? inactiveShown.length.toLocaleString() : "–"}
          note={`No sign-in for ${threshold} days or more`}
          status={status.inactive}
          fresh={freshCount.inactive}
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
          fresh={freshCount.forwarding}
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
          fresh={freshCount.apps}
          selected={selected === "apps"}
          onSelect={() => select("apps")}
        />
        <Tile
          icon={Waypoints}
          label="Domain-wide delegation"
          value={hasResults && delegation ? delegationToReview.toLocaleString() : "–"}
          note={
            !hasResults
              ? "Apps allowed to act as any user"
              : delegationError
                ? "The admin log couldn't be read"
                : "Granted or changed in the last 6 months"
          }
          status={status.delegation}
          fresh={freshCount.delegation}
          selected={selected === "delegation"}
          onSelect={() => select("delegation")}
        />
        <Tile
          icon={MailCheck}
          label="Email spoofing protection"
          value={hasResults && emailAuth ? domainsToReview.toLocaleString() : "–"}
          note={
            !hasResults
              ? "Domains missing SPF, DKIM or DMARC"
              : emailAuthError
                ? "The domains couldn't be checked"
                : `of ${plural(domainsAll.length, "domain")}`
          }
          status={status.emailAuth}
          fresh={freshCount.emailAuth}
          selected={selected === "emailAuth"}
          onSelect={() => select("emailAuth")}
        />
      </div>

      {hasResults && (baseline || (done && !partial)) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          {baseline ? (
            <>
              <span>
                Compared with the scan on {formatDate(baseline.completedAt)}:{" "}
                {anythingNew
                  ? "what it didn't have is marked new."
                  : scanning
                    ? "nothing new so far."
                    : "nothing new."}
              </span>
              {(anythingNew || onlyNew) && (
                <Button
                  size="xs"
                  variant={onlyNew ? "default" : "outline"}
                  aria-pressed={onlyNew}
                  onClick={() => {
                    setOnlyNew((v) => !v);
                    setShowAll(false);
                  }}
                >
                  Only show what&apos;s new
                </Button>
              )}
            </>
          ) : (
            <span>
              First scan on this install. The next one will mark what has
              changed since today.
            </span>
          )}
        </div>
      )}

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
              {twoStepList.length === 0 ? (
                <Empty>
                  {emptyText("Every active account is enrolled in 2-Step Verification.")}
                </Empty>
              ) : (
                <>
                  {limited(twoStepList).map((f) => (
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
                      <div className="flex shrink-0 items-center gap-2">
                        {newTwoStep(f) && <Badge variant="accent">new</Badge>}
                        {f.admin && <Badge variant="destructive">administrator</Badge>}
                      </div>
                    </div>
                  ))}
                  {more(twoStepList.length)}
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
              {inactiveList.length === 0 ? (
                <Empty>
                  {emptyText(
                    `Every active account has been signed in to within the last ${threshold} days.`
                  )}
                </Empty>
              ) : (
                <>
                  {limited(inactiveList).map((f) => (
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
                      <div className="flex shrink-0 items-center gap-2">
                        {newInactive(f) && <Badge variant="accent">new</Badge>}
                        {f.admin && <Badge variant="warning">administrator</Badge>}
                        <Link
                          href={`/offboarding?user=${encodeURIComponent(f.user)}`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          Offboard…
                        </Link>
                      </div>
                    </div>
                  ))}
                  {more(inactiveList.length)}
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
              {forwardingList.length === 0 ? (
                <Empty>{emptyText("No mailbox forwards mail outside the organisation.")}</Empty>
              ) : (
                <>
                  {limited(forwardingList).map((f, i) => (
                    <div
                      key={`${f.user}|${f.kind}|${f.target}|${i}`}
                      className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Person name={f.name} user={f.user} />
                          <Badge variant="outline">
                            {f.kind === "auto-forward" ? "all mail" : "filter"}
                          </Badge>
                          {f.hidesOriginal && (
                            <Badge variant="destructive">hides the original</Badge>
                          )}
                          {newForwarding(f) && <Badge variant="accent">new</Badge>}
                        </div>
                        <p className="text-sm">
                          <span className="text-muted-foreground">to </span>
                          <span className="font-medium break-all">{f.target}</span>
                        </p>
                        <p className="text-xs text-muted-foreground break-words">{f.detail}</p>
                      </div>
                      {(f.kind === "auto-forward" || f.filterId) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          disabled={scanning}
                          onClick={() => openFix({ type: "forwarding", finding: f })}
                        >
                          {f.kind === "auto-forward" ? "Turn off…" : "Delete filter…"}
                        </Button>
                      )}
                    </div>
                  ))}
                  {more(forwardingList.length)}
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
              {appList.length === 0 ? (
                <Empty>{emptyText("Nobody has connected an outside app.")}</Empty>
              ) : (
                <>
                  {limited(appList).map(({ app, access }) => {
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
                              {newApp(app) && <Badge variant="accent">new</Badge>}
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
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium">Granted by</p>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  disabled={scanning}
                                  onClick={() => openFix({ type: "app-all", app })}
                                >
                                  {app.users.length === 1
                                    ? "Revoke access…"
                                    : `Revoke for all ${app.users.length.toLocaleString()}…`}
                                </Button>
                              </div>
                              <ul className="mt-1 text-muted-foreground">
                                {app.users.slice(0, APP_USERS_SHOWN).map((user) => (
                                  <li
                                    key={user}
                                    className="flex items-center justify-between gap-2 py-0.5"
                                  >
                                    <span className="break-all">{user}</span>
                                    {app.users.length > 1 && (
                                      <button
                                        type="button"
                                        className="shrink-0 underline underline-offset-2 disabled:opacity-50"
                                        disabled={scanning}
                                        onClick={() => openFix({ type: "app-user", app, user })}
                                      >
                                        Revoke
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {app.users.length > APP_USERS_SHOWN && (
                                <p className="mt-1 text-muted-foreground">
                                  and {(app.users.length - APP_USERS_SHOWN).toLocaleString()} more
                                  (all in the CSV export)
                                </p>
                              )}
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
                  {more(appList.length)}
                </>
              )}
            </CardContent>
          </>
        )}
        {selected === "delegation" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Waypoints className="h-5 w-5" />
                Domain-wide delegation
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  Domain-wide delegation lets an app act as any user in the
                  organisation: read their mail, their files and their
                  calendar, with no password and no consent screen. Whoever
                  holds that app&apos;s key has the same reach, so every entry
                  should be one you recognise and still need.
                </span>
                <span className="block">
                  <span className="font-medium text-foreground">
                    This is not the full list.
                  </span>{" "}
                  Google keeps that in the Admin console (Security → Access and
                  data control → API controls → Manage Domain Wide Delegation)
                  and gives apps no way to read it. What is shown here comes
                  from the admin log: each time delegation was granted, changed
                  or removed in about the last six months. An app granted
                  earlier and untouched since will not appear, so check the
                  list in the Admin console as well.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!hasResults ? (
                <Empty>Run the check to see results.</Empty>
              ) : delegationLoading ? (
                <Empty>Reading the admin log…</Empty>
              ) : delegationError ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                  <p className="font-medium">The admin log could not be read.</p>
                  <p className="mt-1 text-xs text-muted-foreground break-words">
                    {delegationError}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    This check needs the service account to be granted the
                    reports permission (admin.reports.audit.readonly).{" "}
                    <Link href="/tenants" className="underline underline-offset-2">
                      Tenants
                    </Link>{" "}
                    → Test scopes shows whether it is.
                  </p>
                </div>
              ) : !delegation ? (
                <Empty>The check was stopped before the admin log was read.</Empty>
              ) : delegatedClients.length === 0 ? (
                <Empty>
                  {onlyNew
                    ? "Nothing new here since the last scan."
                    : "No delegation was granted, changed or removed in the last six months. That says nothing about older entries."}
                </Empty>
              ) : (
                <>
                  {limited(delegatedClients).map((client) => {
                    const open = openClient === client.clientId;
                    const access = summariseAccess(client.scopes);
                    const authorized = client.status === "authorized";
                    return (
                      <div key={client.clientId} className="rounded-lg border bg-muted/30">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenClient(open ? null : client.clientId)}
                          className="flex w-full items-start justify-between gap-3 p-3 text-left"
                        >
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-mono text-sm font-medium break-all">
                                {client.clientId}
                              </p>
                              {client.ownApp && <Badge variant="accent">Open Admin</Badge>}
                              {authorized ? (
                                <Badge variant={ACCESS[access.level].variant}>
                                  {ACCESS[access.level].label}
                                </Badge>
                              ) : (
                                <Badge variant="outline">removed</Badge>
                              )}
                              {newClient(client) && <Badge variant="accent">new</Badge>}
                              {client.unusedScopes.length > 0 && (
                                <Badge variant="warning">
                                  {`${plural(client.unusedScopes.length, "permission")} it doesn't use`}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {authorized ? "Granted" : "Removed"} by {client.lastActor} on{" "}
                              {formatDate(client.lastChange)}
                              {authorized && access.areas.length > 0
                                ? ` · ${access.areas.map((a) => a.area).join(" · ")}`
                                : ""}
                            </p>
                          </div>
                          <span className="flex shrink-0 items-center text-muted-foreground">
                            {open ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </span>
                        </button>
                        {open && (
                          <div className="space-y-3 border-t px-3 py-3 text-xs">
                            {client.ownApp && (
                              <p className="text-muted-foreground">
                                This is the service account Open Admin itself runs as.
                                {client.unusedScopes.length > 0
                                  ? " The permissions marked unused can be removed from its entry in the Admin console without affecting anything here."
                                  : ""}
                              </p>
                            )}
                            <div>
                              <p className="font-medium">
                                {authorized ? "Permissions" : "Permissions it had"}
                              </p>
                              {client.scopes.length === 0 ? (
                                <p className="text-muted-foreground">Not recorded in the log</p>
                              ) : (
                                <ul className="font-mono text-muted-foreground">
                                  {client.scopes.map((scope) => (
                                    <li key={scope} className="break-all">
                                      {scope}
                                      {client.unusedScopes.includes(scope) && (
                                        <span className="ml-2 font-sans font-medium text-warning-fg">
                                          unused
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div>
                              <p className="font-medium">Changes in the last six months</p>
                              <ul className="text-muted-foreground">
                                {client.history.map((event, i) => (
                                  <li key={`${event.time}|${event.kind}|${i}`}>
                                    {formatDate(event.time)}:{" "}
                                    {event.kind === "authorize" ? "granted" : "removed"} by{" "}
                                    {event.actor}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {more(delegatedClients.length)}
                  {delegation.truncated && (
                    <p className="text-xs text-muted-foreground">
                      The admin log held more changes than were read, so older
                      ones in this period may be missing.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </>
        )}
        {selected === "emailAuth" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MailCheck className="h-5 w-5" />
                Email spoofing protection
              </CardTitle>
              <CardDescription className="space-y-2">
                <span className="block">
                  Three public DNS records tell other mail systems which mail
                  really comes from you. Without them anyone can send mail that
                  appears to come from your domain, and more of your own mail
                  lands in spam. SPF lists the servers allowed to send, DKIM
                  lets receivers check a signature on each message, and DMARC
                  says what to do with mail that fails both.
                </span>
                <span className="block">
                  SPF and DMARC are records you add with whoever hosts your
                  DNS. DKIM is switched on in the Google Admin console (Apps →
                  Google Workspace → Gmail → Authenticate email), which also
                  gives you the record to publish. DKIM is looked for under
                  Google&apos;s default name only; one set up under another
                  name can&apos;t be found from outside.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!hasResults ? (
                <Empty>Run the check to see results.</Empty>
              ) : emailAuthLoading ? (
                <Empty>Looking up DNS records…</Empty>
              ) : emailAuthError ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                  <p className="font-medium">The domains could not be checked.</p>
                  <p className="mt-1 text-xs text-muted-foreground break-words">
                    {emailAuthError}
                  </p>
                </div>
              ) : !emailAuth ? (
                <Empty>The check was stopped before the domains were looked up.</Empty>
              ) : domainList.length === 0 ? (
                <Empty>
                  {onlyNew
                    ? "Nothing new here since the last scan."
                    : "This tenant has no verified domains to check."}
                </Empty>
              ) : (
                <>
                  {limited(domainList).map((d) => {
                    const open = openDomain === d.domain;
                    return (
                      <div key={d.domain} className="rounded-lg border bg-muted/30 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium break-all">{d.domain}</p>
                            {d.primary && <Badge variant="outline">primary</Badge>}
                            {newDomain(d) && <Badge variant="accent">new</Badge>}
                          </div>
                          <button
                            type="button"
                            aria-expanded={open}
                            className="text-xs text-muted-foreground underline underline-offset-2"
                            onClick={() => setOpenDomain(open ? null : d.domain)}
                          >
                            {open ? "Hide records" : "Show records"}
                          </button>
                        </div>
                        <dl className="mt-2 space-y-2">
                          {(
                            [
                              ["SPF", d.spf],
                              ["DKIM", d.dkim],
                              ["DMARC", d.dmarc],
                            ] as Array<[string, RecordCheck]>
                          ).map(([name, check]) => {
                            const v = VERDICT[check.verdict];
                            const VerdictIcon = v.icon;
                            return (
                              <div key={name} className="grid grid-cols-[4rem_1fr] gap-x-3 text-xs">
                                <dt className="font-medium">{name}</dt>
                                <dd className="min-w-0">
                                  <span
                                    className={cn(
                                      "flex items-center gap-1.5 font-medium",
                                      v.className
                                    )}
                                  >
                                    <VerdictIcon className="h-3.5 w-3.5 shrink-0" />
                                    {v.label}
                                  </span>
                                  <span className="mt-0.5 block text-muted-foreground">
                                    {check.summary}
                                  </span>
                                  {open && (
                                    <span className="mt-1 block font-mono text-muted-foreground break-all">
                                      {check.record ?? "(no single record to show)"}
                                    </span>
                                  )}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </div>
                    );
                  })}
                  {more(domainList.length)}
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

      <ConfirmActionDialog
        open={!!fix}
        onOpenChange={(o) => {
          if (fixBusy) return;
          if (!o) {
            setFixError(null);
            setFix(null);
          }
        }}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        busy={fixBusy}
        error={fixError}
        onConfirm={() => void confirmFix()}
        {...(fix?.type === "forwarding"
          ? {
              title:
                fix.finding.kind === "filter"
                  ? "Delete forwarding filter"
                  : "Turn off forwarding",
              summary: `Mail arriving in ${fix.finding.user} will no longer be sent to ${fix.finding.target}.`,
              confirmPhrase: fix.finding.user,
              confirmLabel: fixError
                ? "Try again"
                : fix.finding.kind === "filter"
                  ? "Delete filter"
                  : "Turn off forwarding",
              changes: [
                { label: "Mailbox", after: fix.finding.user },
                {
                  label: fix.finding.kind === "filter" ? "Filter" : "Forwarding",
                  before: `to ${fix.finding.target}`,
                  after: fix.finding.kind === "filter" ? "deleted" : "off",
                  emphasis: true,
                },
              ],
              warnings:
                fix.finding.kind === "filter"
                  ? `The whole filter is deleted, including anything else it did (labels, archiving). ${fix.finding.detail}.`
                  : "Mail that has already been forwarded is not recalled.",
            }
          : fix?.type === "app-user"
            ? {
                title: "Revoke app access",
                summary: `${fix.app.name || "This app"} will lose its access to ${fix.user}'s account.`,
                confirmPhrase: fix.user,
                confirmLabel: fixError ? "Try again" : "Revoke access",
                changes: [
                  {
                    label: "App",
                    after: `${fix.app.name || "(unnamed app)"} · ${fix.app.clientId}`,
                  },
                  {
                    label: "Account",
                    before: fix.user,
                    after: "access revoked",
                    emphasis: true,
                  },
                ],
                warnings:
                  "They can connect the app again unless it is blocked in the Google Admin console (Security → Access and data control → API controls).",
              }
            : {
                title: "Revoke app access for everyone",
                summary: `${fix?.app.name || "This app"} will lose its access to every account that granted it.`,
                confirmPhrase: "REVOKE",
                confirmLabel: fixError ? "Try again" : "Revoke for everyone",
                changes: [
                  {
                    label: "App",
                    after: `${fix?.app.name || "(unnamed app)"} · ${fix?.app.clientId ?? ""}`,
                  },
                  {
                    label: "Accounts",
                    before: plural(
                      apps.find((a) => a.clientId === fix?.app.clientId)?.users.length ?? 0,
                      "account"
                    ),
                    after: "access revoked",
                    emphasis: true,
                  },
                ],
                warnings:
                  "People can connect the app again unless it is blocked in the Google Admin console (Security → Access and data control → API controls).",
              })}
      />

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
