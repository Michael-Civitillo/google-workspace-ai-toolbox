"use client";

import { useEffect, useRef, useState } from "react";
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
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ReactivateAccountDialog } from "@/components/reactivate-account-dialog";
import {
  Loader2,
  Search,
  Trash2,
  UserSearch,
  Inbox,
  AlertTriangle,
  X,
  UserCheck,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

interface DelegateInfo {
  primaryEmail: string;
  fullName: string;
  suspended: boolean;
  aliases: string[];
}

interface Match {
  owner: string;
  ownerName: string;
  ownerSuspended: boolean;
  orgUnitPath: string;
  verificationStatus: string;
  delegateAddress: string;
}

interface PairHistory {
  owner: string;
  grantedAt: string | null;
  grantedBy: string | null;
  firstSeenAt: string | null;
}

interface Unscanned {
  owner: string;
  error: string;
}

interface Progress {
  scannedUsers: number;
  skippedSuspended: number;
}

const HISTORY_BATCH = 100;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "today", "3 days", "2 months", "1 year 4 months" — how long since `iso`. */
function formatAge(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "today";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days < 31) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  const rest = months - years * 12;
  const y = `${years} year${years === 1 ? "" : "s"}`;
  return rest > 0 ? `${y} ${rest} month${rest === 1 ? "" : "s"}` : y;
}

/** Was `iso` within the last few hours? Used to word a same-day sighting. */
function isJustNow(iso: string, now = Date.now()): boolean {
  const ms = now - Date.parse(iso);
  return !Number.isNaN(ms) && ms < 6 * 60 * 60 * 1000;
}

export default function DelegationLookup() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [delegate, setDelegate] = useState("");

  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [delegateInfo, setDelegateInfo] = useState<DelegateInfo | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [history, setHistory] = useState<Record<string, PairHistory>>({});
  const [historyFailed, setHistoryFailed] = useState(false);
  const [unscanned, setUnscanned] = useState<Unscanned[]>([]);
  const [showUnscanned, setShowUnscanned] = useState(false);
  const [message, setMessage] = useState<Feedback | null>(null);

  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemoveTarget, setConfirmRemoveTarget] = useState<Match | null>(
    null
  );
  // A failed removal, shown inside its dialog; `suspendedUser` is set when
  // the server says the owner is suspended and offers to re-enable it.
  const [removeError, setRemoveError] = useState<{
    message: string;
    suspendedUser?: string;
  } | null>(null);
  const [reactivateUser, setReactivateUser] = useState<string | null>(null);

  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  // A list fetched for tenant A must never drive removals against tenant B:
  // abort any in-flight scan and clear results when the tenant changes.
  useEffect(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setScanning(false);
    setDone(false);
    setCancelled(false);
    setProgress(null);
    setDelegateInfo(null);
    setMatches([]);
    setHistory({});
    setHistoryFailed(false);
    setUnscanned([]);
    setMessage(null);
  }, [tenantId]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const loadHistory = async (
    delegateEmail: string,
    owners: string[],
    signal: AbortSignal,
    pinnedTenantId: string | null
  ) => {
    for (let i = 0; i < owners.length; i += HISTORY_BATCH) {
      const batch = owners.slice(i, i + HISTORY_BATCH);
      try {
        const res = await tfetch(
          `/api/admin/delegation-lookup/history?delegate=${encodeURIComponent(
            delegateEmail
          )}&owners=${encodeURIComponent(batch.join(","))}`,
          { signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;
        if (result.success) {
          const rows = result.data.history as PairHistory[];
          setHistory((prev) => {
            const next = { ...prev };
            for (const r of rows) next[r.owner] = r;
            return next;
          });
        } else {
          setHistoryFailed(true);
        }
      } catch {
        if (!signal.aborted) setHistoryFailed(true);
      }
    }
  };

  const runLookup = async () => {
    const target = delegate.trim();
    if (!target) return;

    cancelRef.current = false;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const pinnedTenantId = tenantId;

    setScanning(true);
    setDone(false);
    setCancelled(false);
    setMessage(null);
    setProgress({ scannedUsers: 0, skippedSuspended: 0 });
    setDelegateInfo(null);
    setMatches([]);
    setHistory({});
    setHistoryFailed(false);
    setUnscanned([]);
    setShowUnscanned(false);

    let delegateEmail = target;
    let pageToken: string | null = null;
    const seenOwners = new Set<string>();

    try {
      while (true) {
        const qs = new URLSearchParams({ delegate: target });
        if (pageToken) qs.set("pageToken", pageToken);
        const res = await tfetch(
          `/api/admin/delegation-lookup?${qs.toString()}`,
          { signal: ac.signal },
          pinnedTenantId
        );
        const result = await res.json();
        if (tenantIdRef.current !== pinnedTenantId) return;
        if (!result.success) {
          setMessage({
            type: "error",
            text: result.error || "Delegation lookup failed",
          });
          return;
        }

        const data = result.data as {
          delegate: DelegateInfo;
          matches: Match[];
          scannedUsers: number;
          skippedSuspended: number;
          unscanned: Unscanned[];
          nextPageToken: string | null;
        };
        delegateEmail = data.delegate.primaryEmail;
        setDelegateInfo(data.delegate);
        setProgress((p) => ({
          scannedUsers: (p?.scannedUsers ?? 0) + data.scannedUsers,
          skippedSuspended: (p?.skippedSuspended ?? 0) + data.skippedSuspended,
        }));
        if (data.matches.length > 0) {
          setMatches((prev) => [...prev, ...data.matches]);
        }
        if (data.unscanned.length > 0) {
          setUnscanned((prev) => [...prev, ...data.unscanned]);
        }

        const newOwners = data.matches
          .map((m) => m.owner)
          .filter((o) => !seenOwners.has(o));
        for (const o of newOwners) seenOwners.add(o);
        if (newOwners.length > 0) {
          // Local-only call (audit log + sightings file): cheap enough to run
          // per page so "since" fills in as matches appear.
          await loadHistory(delegateEmail, newOwners, ac.signal, pinnedTenantId);
        }

        pageToken = data.nextPageToken;
        if (cancelRef.current || !pageToken) break;
      }
      if (cancelRef.current) setCancelled(true);
      setDone(true);
    } catch {
      if (!ac.signal.aborted) {
        setMessage({ type: "error", text: "Failed to connect to the API" });
      } else if (cancelRef.current && tenantIdRef.current === pinnedTenantId) {
        setCancelled(true);
        setDone(true);
      }
    } finally {
      if (tenantIdRef.current === pinnedTenantId) setScanning(false);
    }
  };

  const cancelLookup = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const removeDelegate = async (m: Match, reactivated?: string) => {
    if (!delegateInfo) return;
    setRemoving(m.owner);
    setMessage(null);
    setRemoveError(null);
    try {
      const res = await tfetch(
        "/api/gws/email-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // Name the address the mailbox actually stores — an alias grant
          // can't be deleted by the primary email.
          body: JSON.stringify({ user: m.owner, delegate: m.delegateAddress }),
        },
        tenantId
      );
      const result = await res.json();
      if (result.success) {
        setConfirmRemoveTarget(null);
        setMatches((prev) => prev.filter((x) => x.owner !== m.owner));
        setMessage({
          type: "success",
          text: reactivated
            ? `Re-enabled ${reactivated} and removed ${delegateInfo.primaryEmail}'s delegate access to ${m.owner}`
            : `Removed ${delegateInfo.primaryEmail}'s delegate access to ${m.owner}`,
        });
      } else {
        // Stay in the dialog: that is where the operator is looking.
        setRemoveError({
          message: result.error || "Failed to remove delegate",
          suspendedUser:
            typeof result.suspendedUser === "string" && result.suspendedUser
              ? result.suspendedUser
              : undefined,
        });
      }
    } catch {
      setRemoveError({ message: "Failed to connect to the API" });
    } finally {
      setRemoving(null);
    }
  };

  const renderSince = (m: Match) => {
    const h = history[m.owner];
    if (!h) {
      return (
        <p className="text-xs text-muted-foreground">
          {historyFailed ? "History unavailable" : "Checking history…"}
        </p>
      );
    }
    if (h.grantedAt) {
      return (
        <p className="text-xs text-muted-foreground">
          Granted {formatDate(h.grantedAt)}
          {h.grantedBy ? ` by ${h.grantedBy}` : ""} ·{" "}
          <span className="font-medium text-foreground">
            {formatAge(h.grantedAt)}
          </span>
        </p>
      );
    }
    if (h.firstSeenAt) {
      if (isJustNow(h.firstSeenAt)) {
        return (
          <p className="text-xs text-muted-foreground">
            Grant date unknown — first noticed by Open Admin today
          </p>
        );
      }
      return (
        <p className="text-xs text-muted-foreground">
          Grant date unknown · existed at least{" "}
          <span className="font-medium text-foreground">
            {formatAge(h.firstSeenAt)}
          </span>{" "}
          (first seen {formatDate(h.firstSeenAt)})
        </p>
      );
    }
    return <p className="text-xs text-muted-foreground">Grant date unknown</p>;
  };

  const summaryLine = () => {
    if (!progress) return "Search for a user to see the mailboxes they can access";
    const parts = [
      `${progress.scannedUsers.toLocaleString()} mailbox${
        progress.scannedUsers === 1 ? "" : "es"
      } checked`,
    ];
    if (progress.skippedSuspended > 0) {
      parts.push(
        `${progress.skippedSuspended.toLocaleString()} suspended skipped (Google won't read a suspended mailbox)`
      );
    }
    if (unscanned.length > 0) {
      parts.push(`${unscanned.length.toLocaleString()} unreadable`);
    }
    const state = scanning
      ? "Scanning…"
      : cancelled
        ? "Cancelled — results are partial."
        : done
          ? "Complete."
          : "";
    return `${state} ${parts.join(" · ")}`.trim();
  };

  return (
    <>
      <PageHeader
        title="Delegate Lookup"
        description="Find every mailbox a person has delegate access to, and how long they've had it. The reverse of Email Delegation: start from the delegate, not the mailbox."
        badge="Gmail"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserSearch className="h-5 w-5" />
              Look up a delegate
            </CardTitle>
            <CardDescription>
              Gmail only lists delegates per mailbox, so this checks every
              active mailbox in the tenant. It runs in pages and can be
              cancelled. Suspended accounts are skipped: Google won&apos;t read
              their settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delegate">Delegate</Label>
              <div className="flex gap-2">
                <Input
                  id="delegate"
                  placeholder="person@yourdomain.com"
                  value={delegate}
                  onChange={(e) => setDelegate(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && delegate && !scanning) {
                      void runLookup();
                    }
                  }}
                  disabled={scanning}
                />
                {scanning ? (
                  <Button variant="secondary" onClick={cancelLookup}>
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                ) : (
                  <Button onClick={() => void runLookup()} disabled={!delegate}>
                    <Search className="h-4 w-4" />
                    Search
                  </Button>
                )}
              </div>
            </div>

            {progress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {scanning && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{summaryLine()}</span>
              </div>
            )}

            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">How the dates work</p>
              <p>
                Google doesn&apos;t record when a delegate was added. Open
                Admin knows the exact date for delegations granted through it
                (from the{" "}
                <Link href="/audit-log" className="underline underline-offset-2">
                  audit log
                </Link>
                ). For everything else it remembers when it first noticed the
                delegation, so the longer you use this lookup the more useful
                the dates become.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Inbox className="h-5 w-5" />
              Delegated mailboxes
            </CardTitle>
            <CardDescription>
              {delegateInfo ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {delegateInfo.fullName
                      ? `${delegateInfo.fullName} · ${delegateInfo.primaryEmail}`
                      : delegateInfo.primaryEmail}
                  </span>
                  {delegateInfo.suspended && (
                    <Badge variant="warning">suspended</Badge>
                  )}
                  <span>
                    · {matches.length} mailbox{matches.length === 1 ? "" : "es"}
                  </span>
                </span>
              ) : (
                summaryLine()
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {matches.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                {scanning
                  ? "Nothing found yet…"
                  : done
                    ? cancelled
                      ? "No delegated mailboxes found before the scan was cancelled"
                      : "No mailboxes are delegated to this user"
                    : "No delegated mailboxes to display"}
              </div>
            ) : (
              <div className="space-y-3">
                {matches.map((m) => (
                  <div
                    key={m.owner}
                    className="flex items-start justify-between gap-3 p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {m.ownerName ? `${m.ownerName} · ${m.owner}` : m.owner}
                        </p>
                        <Badge
                          variant={
                            m.verificationStatus === "accepted"
                              ? "success"
                              : "warning"
                          }
                        >
                          {m.verificationStatus}
                        </Badge>
                        {m.ownerSuspended && (
                          <Badge variant="outline">suspended</Badge>
                        )}
                        {delegateInfo &&
                          m.delegateAddress !== delegateInfo.primaryEmail && (
                            <Badge variant="outline">
                              via alias {m.delegateAddress}
                            </Badge>
                          )}
                      </div>
                      {renderSince(m)}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove delegate access to ${m.owner}`}
                      onClick={() => {
                        setMessage(null);
                        setRemoveError(null);
                        setConfirmRemoveTarget(m);
                      }}
                      disabled={removing === m.owner || scanning}
                    >
                      {removing === m.owner ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-danger" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {unscanned.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning-fg" />
              {unscanned.length} mailbox{unscanned.length === 1 ? "" : "es"}{" "}
              couldn&apos;t be checked
            </CardTitle>
            <CardDescription>
              Usually accounts without a Gmail licence. Any delegation on these
              mailboxes is not reflected above.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setShowUnscanned((v) => !v)}
              >
                {showUnscanned ? "Hide details" : "Show details"}
              </button>
            </CardDescription>
          </CardHeader>
          {showUnscanned && (
            <CardContent>
              <ul className="space-y-1 text-xs">
                {unscanned.map((u) => (
                  <li key={u.owner} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{u.owner}</span>
                    <span className="text-muted-foreground">{u.error}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}

      <ConfirmActionDialog
        open={!!confirmRemoveTarget}
        onOpenChange={(o) => {
          if (removing) return;
          if (!o) {
            setRemoveError(null);
            setConfirmRemoveTarget(null);
          }
        }}
        title="Remove mailbox delegate"
        summary={`${delegateInfo?.primaryEmail ?? ""} will lose access to ${
          confirmRemoveTarget?.owner ?? ""
        }'s mailbox.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="medium"
        confirmLabel={removeError ? "Try again" : "Remove delegate"}
        busy={!!removing}
        changes={[
          { label: "Mailbox owner", after: confirmRemoveTarget?.owner ?? "" },
          {
            label: "Delegate to remove",
            before: confirmRemoveTarget?.delegateAddress ?? "",
            after: "no longer has access",
            emphasis: true,
          },
        ]}
        error={removeError?.message}
        errorActions={
          removeError?.suspendedUser ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReactivateUser(removeError.suspendedUser as string)}
            >
              <UserCheck className="h-3.5 w-3.5" />
              Re-enable {removeError.suspendedUser}…
            </Button>
          ) : null
        }
        onConfirm={() => {
          if (confirmRemoveTarget) void removeDelegate(confirmRemoveTarget);
        }}
      />

      <ReactivateAccountDialog
        user={reactivateUser}
        onOpenChange={(o) => {
          if (!o) setReactivateUser(null);
        }}
        thenLabel={`Remove ${delegateInfo?.primaryEmail ?? ""} as a delegate from ${
          confirmRemoveTarget?.owner ?? ""
        }`}
        onReactivated={async (reactivated) => {
          setReactivateUser(null);
          if (confirmRemoveTarget) await removeDelegate(confirmRemoveTarget, reactivated);
        }}
      />
    </>
  );
}
