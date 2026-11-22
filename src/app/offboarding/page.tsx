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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import {
  UserMinus,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  AlertTriangle,
} from "lucide-react";
import {
  tfetch,
  useCurrentTenant,
  tenantPinProblem,
} from "@/lib/tenant-client";
import {
  ConfirmActionDialog,
  type DiffRow,
} from "@/components/confirm-action-dialog";

interface PreflightUser {
  primaryEmail: string;
  name: { fullName: string };
  isAdmin: boolean;
  suspended: boolean;
  orgUnitPath: string;
}
interface Preflight {
  user: PreflightUser;
  /** Null when the token listing failed — the count is unknown, not zero. */
  tokenCount: number | null;
  tokens: Array<{ clientId: string; displayText: string }>;
  tokensError?: string | null;
}

type StepId =
  | "vacation"
  | "forward"
  | "calendar"
  | "drive"
  | "groups"
  | "revokeTokens"
  | "signOut"
  | "suspend";

type StepStatus = "pending" | "running" | "success" | "error" | "skipped";

interface StepDefinition {
  id: StepId;
  title: string;
  description: string;
  /** Lower number = earlier. Determines run order. */
  order: number;
  /** Whether this step needs a successor user to be set. */
  needsSuccessor: boolean;
  /** Default-on for typical offboarding. */
  defaultEnabled: boolean;
  /**
   * Severity hint for the diff dialog row — high gets the red emphasis
   * styling, "drive" and "suspend" especially.
   */
  emphasis?: boolean;
}

const STEPS: StepDefinition[] = [
  {
    id: "vacation",
    title: "Set vacation responder",
    description:
      "Auto-reply on incoming mail letting senders know the user has left.",
    order: 1,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "forward",
    title: "Forward email to successor",
    description:
      "Auto-forward all new mail. Originals are archived in the source mailbox.",
    order: 2,
    needsSuccessor: true,
    defaultEnabled: true,
  },
  {
    id: "calendar",
    title: "Grant calendar ownership to successor",
    description:
      "Adds the successor as an owner on the user's primary calendar (does NOT remove the source user's access — suspending later does that).",
    order: 3,
    needsSuccessor: true,
    defaultEnabled: true,
  },
  {
    id: "drive",
    title: "Transfer Drive ownership to successor",
    description:
      "Hands every Drive item the user owns to the successor via Google's Data Transfer API. Asynchronous — can take minutes to hours.",
    order: 4,
    needsSuccessor: true,
    defaultEnabled: true,
    emphasis: true,
  },
  {
    id: "groups",
    title: "Remove from all groups",
    description:
      "Removes the user from every group they belong to — mailing lists, access-control groups, and shared resources.",
    order: 5,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "revokeTokens",
    title: "Revoke all OAuth tokens",
    description:
      "Disconnects every third-party app the user authorised (Slack, Zoom, etc.).",
    order: 6,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "signOut",
    title: "Sign out of all sessions",
    description:
      "Invalidates the user's active web/mobile sessions. They'll be forced to log in again — and they won't be able to, after suspension.",
    order: 7,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "suspend",
    title: "Suspend the account",
    description:
      "Final step. The user can no longer sign in. Mail still arrives (for forwarding). Reversible by an admin if needed.",
    order: 8,
    needsSuccessor: false,
    defaultEnabled: true,
    emphasis: true,
  },
];

/**
 * The fixed run order. Settings + transfers BEFORE we cut access — once a
 * user is suspended/signed-out/revoked, admin operations on their account
 * sometimes get flaky, and we don't want to discover that mid-flow.
 */
const RUN_ORDER: StepId[] = STEPS
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((s) => s.id);

type StepResults = Record<StepId, { status: StepStatus; message?: string }>;


export default function Offboarding() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [email, setEmail] = useState("");
  const [successor, setSuccessor] = useState("");
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [enabled, setEnabled] = useState<Record<StepId, boolean>>(
    () =>
      Object.fromEntries(STEPS.map((s) => [s.id, s.defaultEnabled])) as Record<
        StepId,
        boolean
      >
  );
  const [vacationSubject, setVacationSubject] = useState("Out of office");
  const [vacationMessage, setVacationMessage] = useState(
    "I'm no longer with the company. Please reach out to my team for any open items."
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Mirrors `running` for the tenant effect: a run in flight keeps its panel.
  const runningRef = useRef(false);
  const [results, setResults] = useState<StepResults>({} as StepResults);
  // The tenant the looked-up user belongs to. A lookup made in one tenant
  // must never drive a run in another, so Review needs this to match the
  // tenant the page is on now.
  const [preflightTenant, setPreflightTenant] = useState<{
    id: string | null;
    name: string | null;
  } | null>(null);
  // What the current (or last) run was pinned to, for its panel.
  const [runInfo, setRunInfo] = useState<{
    user: string;
    tenantName: string | null;
  } | null>(null);
  // The successor's address typed a second time when it is outside the
  // tenant's verified domains: the server's confirmExternal comes from this,
  // never from the successor field itself.
  const [externalConfirm, setExternalConfirm] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Verified domains for detecting an external successor. null = unknown
  // (not loaded / lookup failed) → treat as external, fail-safe, matching the
  // server guard on the forward/calendar steps.
  const [verifiedDomains, setVerifiedDomains] = useState<string[] | null>(null);

  // Stop the multi-step run and skip post-unmount state updates if the user
  // navigates away — the destructive steps must not keep firing invisibly.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  // Security Check links here with the account already chosen
  // (/offboarding?user=...). Only the field is filled in: nothing is looked up
  // or run until the operator presses the buttons themselves. Read from the
  // location in an effect rather than through useSearchParams, which would
  // force the whole page behind a Suspense boundary for one optional value.
  useEffect(() => {
    const user = new URLSearchParams(window.location.search).get("user")?.trim();
    if (user && user.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
      setEmail(user);
    }
  }, []);

  // Effect-run marker for the lookup staleness guard below.
  const lookupSeq = useRef(0);

  useEffect(() => {
    // Cancelled flag: a tenant switch must not let the previous tenant's
    // in-flight domains response land afterwards and misclassify successors.
    let cancelled = false;
    setVerifiedDomains(null);
    // A confirmation opened under the previous tenant must not survive the
    // switch: left open, it would confirm a run against the new tenant, and
    // left "open" behind an unmounted dialog, the next lookup popped it
    // straight up.
    setConfirmOpen(false);
    setDialogError(null);
    setExternalConfirm("");
    // The looked-up user and step results are tenant-scoped too: keeping them
    // across a switch pairs tenant B's confirmation dialog with tenant A's
    // user, burning a fully-confirmed run on guaranteed server-side failures.
    lookupSeq.current++;
    // The seq bump above means any in-flight lookup's `finally` will skip its
    // own setLookingUp(false) (it's guarded to the latest seq) — clear the
    // spinner here or it stays on forever and blocks all future lookups.
    setLookingUp(false);
    // A run in flight is left alone: its requests are pinned to its tenant,
    // and blanking the page would hide steps that are still firing. Its
    // panel names the tenant, and Review stays off until the user is looked
    // up again here (preflightTenant no longer matches).
    if (!runningRef.current) {
      setPreflight(null);
      setPreflightTenant(null);
      setResults({} as StepResults);
      setRunInfo(null);
    }
    tfetch("/api/admin/domains", {}, tenantId)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.success && Array.isArray(d.data)) {
          setVerifiedDomains(
            d.data
              .filter((x: { verified?: boolean }) => x.verified)
              .map((x: { domainName: string }) => x.domainName.toLowerCase())
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const successorDomain = successor.includes("@")
    ? successor.slice(successor.indexOf("@") + 1).trim().toLowerCase()
    : "";
  const successorIsExternal =
    !!successorDomain &&
    (verifiedDomains === null || !verifiedDomains.includes(successorDomain));

  const lookup = async () => {
    // The Enter-key handler can fire while a lookup is already in flight; two
    // racing lookups could otherwise resolve out of order and leave the
    // preflight card (and the typed confirmation it feeds) showing a DIFFERENT
    // user than the input — the run would then target the wrong real account.
    if (!email.trim() || lookingUp || running) return;
    const seq = ++lookupSeq.current;
    const pinnedTenantId = tenantId;
    const pinnedTenantName = tenant?.name ?? null;
    setLookingUp(true);
    setError(null);
    setConfirmOpen(false);
    setPreflight(null);
    setPreflightTenant(null);
    setResults({} as StepResults);
    setRunInfo(null);
    try {
      const res = await tfetch(
        `/api/offboarding/preflight?user=${encodeURIComponent(email)}`,
        {},
        pinnedTenantId
      );
      const data = await res.json();
      if (seq !== lookupSeq.current) return;
      if (data.success) {
        setPreflight(data.data);
        setPreflightTenant({ id: pinnedTenantId, name: pinnedTenantName });
      } else {
        setError(data.error || "Failed to look up user");
      }
    } catch {
      if (seq !== lookupSeq.current) return;
      setError("Failed to connect to the API");
    } finally {
      if (seq === lookupSeq.current) setLookingUp(false);
    }
  };

  const selectedSteps = STEPS.filter((s) => enabled[s.id]);
  const needsSuccessor = selectedSteps.some((s) => s.needsSuccessor);
  // Compared with the account the lookup found, not with what was typed in
  // the Leaver box: that may be an alias, or edited since the lookup.
  const leaverAddress = preflight?.user.primaryEmail.toLowerCase() ?? "";
  const successorIsLeaver =
    !!successor.trim() &&
    !!leaverAddress &&
    successor.trim().toLowerCase() === leaverAddress;
  const successorOk =
    !needsSuccessor ||
    (/^\S+@\S+\.\S+$/.test(successor.trim()) && !successorIsLeaver);
  // An outside successor gets this user's mail, calendar and Drive: the
  // operator types its address a second time to say they mean it.
  const externalConfirmNeeded = needsSuccessor && successorIsExternal;
  const externalConfirmOk =
    !externalConfirmNeeded ||
    externalConfirm.trim().toLowerCase() === successor.trim().toLowerCase();
  const preflightIsCurrent = !!preflightTenant && preflightTenant.id === tenantId;

  const canReview =
    !!preflight &&
    preflightIsCurrent &&
    selectedSteps.length > 0 &&
    successorOk &&
    externalConfirmOk &&
    !preflight.user.isAdmin && // we'll display a warning if admin
    !running;

  /**
   * Build the diff rows for the confirmation dialog. Order matches RUN_ORDER
   * so the user sees what will happen first → last.
   */
  function buildDiff(): DiffRow[] {
    const rows: DiffRow[] = [
      { label: "User to offboard", after: preflight?.user.primaryEmail ?? "" },
    ];
    if (needsSuccessor) {
      rows.push({
        label: "Successor (mail/calendar/Drive)",
        after: successor.trim(),
      });
    }
    rows.push({
      label: "Steps to run",
      after: `${selectedSteps.length} (in fixed safe order)`,
    });
    for (const id of RUN_ORDER) {
      if (!enabled[id]) continue;
      const def = STEPS.find((s) => s.id === id)!;
      let detail = def.title;
      if (id === "vacation") {
        detail = `Vacation responder ON — subject: ${JSON.stringify(vacationSubject.slice(0, 60))}`;
      } else if (id === "forward") {
        detail = `Forward all incoming mail to ${successor}, archive originals`;
      } else if (id === "calendar") {
        detail = `Grant ${successor} owner role on primary calendar`;
      } else if (id === "drive") {
        detail = `Transfer ALL Drive items to ${successor}`;
      } else if (id === "revokeTokens") {
        detail =
          preflight?.tokenCount == null
            ? "Revoke all OAuth tokens (count unknown — listing failed during lookup)"
            : `Revoke ${preflight.tokenCount} OAuth token${preflight.tokenCount === 1 ? "" : "s"}`;
      } else if (id === "signOut") {
        detail = `Sign out all active sessions`;
      } else if (id === "suspend") {
        detail = `Suspend the account (account can no longer sign in)`;
      }
      rows.push({
        label: def.title,
        after: detail,
        emphasis: def.emphasis,
      });
    }
    return rows;
  }

  const runAll = async () => {
    if (!preflight || runningRef.current) return;
    const pinnedTenantId = tenantId;
    const problem = await tenantPinProblem(pinnedTenantId);
    if (problem) {
      setDialogError(problem);
      return;
    }
    if (!alive.current) return;
    if (
      tenantIdRef.current !== pinnedTenantId ||
      preflightTenant?.id !== pinnedTenantId
    ) {
      setDialogError("The tenant changed — look the user up again.");
      return;
    }
    // Everything the run sends is pinned here, so nothing edited on the page
    // while it runs (or a tenant switch) changes what the later steps do.
    const pinnedUser = preflight.user.primaryEmail;
    const pinnedSuccessor = successor.trim();
    const pinnedEnabled = { ...enabled };
    const pinnedVacationSubject = vacationSubject;
    const pinnedVacationMessage = vacationMessage;
    // Sent only when the page judged the successor external, and only as the
    // operator typed it: the server compares it with the successor.
    const pinnedConfirmExternal = externalConfirmNeeded
      ? externalConfirm.trim()
      : undefined;
    runningRef.current = true;
    setRunning(true);
    setRunInfo({ user: pinnedUser, tenantName: preflightTenant?.name ?? null });
    setError(null);
    setDialogError(null);
    // The step list behind the dialog is where the run shows its progress.
    setConfirmOpen(false);
    const newResults: StepResults = {} as StepResults;

    // Once any step fails, do NOT run the irreversible account-cutoff steps
    // (sign-out, suspend). Suspending after a failed forward/calendar step would
    // strand the leaver — mail unforwarded and, once suspended, Gmail-settings
    // retries rejected. Holding these back keeps the run re-runnable: fix the
    // failure and re-run only what's left.
    let hadFailure = false;
    const TERMINAL_STEPS: ReadonlySet<StepId> = new Set(["signOut", "suspend"]);

    for (const id of RUN_ORDER) {
      if (!alive.current) return;
      if (!pinnedEnabled[id]) {
        newResults[id] = { status: "skipped" };
        setResults({ ...newResults });
        continue;
      }
      if (hadFailure && TERMINAL_STEPS.has(id)) {
        newResults[id] = {
          status: "skipped",
          message: "Not run — an earlier step failed. Resolve it and re-run.",
        };
        setResults({ ...newResults });
        continue;
      }
      newResults[id] = { status: "running" };
      setResults({ ...newResults });

      try {
        const res = await tfetch(
          "/api/offboarding/step",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              step: id,
              user: pinnedUser,
              // Every step requires the typed confirmation server-side too —
              // send the pinned preflight address the dialog just confirmed.
              confirm: pinnedUser,
              successor: pinnedSuccessor,
              vacationSubject: pinnedVacationSubject,
              vacationMessage: pinnedVacationMessage,
              confirmExternal: pinnedConfirmExternal,
            }),
          },
          pinnedTenantId
        );
        const data = await res.json();
        const ok = !!data.success;
        if (!ok) hadFailure = true;
        newResults[id] = {
          status: ok ? "success" : "error",
          message: ok
            ? data.data?.message ||
              data.data?.note ||
              "Done"
            : data.error || "Failed",
        };
      } catch {
        hadFailure = true;
        newResults[id] = { status: "error", message: "Request failed" };
      }
      if (!alive.current) return;
      setResults({ ...newResults });
    }

    runningRef.current = false;
    if (!alive.current) return;
    setRunning(false);
  };

  const statusIcon = (s: StepStatus) => {
    switch (s) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 text-danger" />;
      case "running":
        return <Loader2 className="h-4 w-4 text-info animate-spin" />;
      case "skipped":
        return <Circle className="h-4 w-4 text-muted-foreground" />;
      default:
        return <Circle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <>
      <PageHeader
        title="Offboarding"
        description="Run the full offboarding sequence in one go: vacation responder, forwarding, calendar/Drive transfer, revoke tokens, sign out, suspend."
        badge="Workflow"
      />

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserMinus className="h-5 w-5" />
              Plan the offboarding
            </CardTitle>
            <CardDescription>
              Look up the leaver, set their successor, then pick which steps to
              run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Lookup */}
            <div className="space-y-2">
              <Label htmlFor="user">Leaver</Label>
              <div className="flex gap-2">
                <Input
                  id="user"
                  placeholder="leaver@yourdomain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && !lookingUp && !running && lookup()
                  }
                  disabled={running}
                />
                <Button
                  variant="secondary"
                  onClick={lookup}
                  disabled={!email.trim() || lookingUp || running}
                >
                  {lookingUp ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {preflight && (
              <>
                <div className="p-4 rounded-lg border bg-muted/30 space-y-2">
                  <p className="font-medium text-sm">{preflight.user.name.fullName}</p>
                  <p className="text-xs text-muted-foreground">
                    {preflight.user.primaryEmail} · {preflight.user.orgUnitPath}
                  </p>
                  <div className="flex gap-1.5 flex-wrap">
                    {preflight.user.isAdmin && (
                      <Badge
                        variant="outline"
                        className="border-primary/20 bg-primary/10 text-primary text-xs"
                      >
                        Super admin
                      </Badge>
                    )}
                    {preflight.user.suspended && (
                      <Badge
                        variant="outline"
                        className="border-danger/25 bg-danger/10 text-danger-fg text-xs"
                      >
                        Already suspended
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className="border-border bg-muted text-muted-foreground text-xs"
                    >
                      {preflight.tokenCount == null
                        ? "OAuth tokens: count unavailable"
                        : `${preflight.tokenCount} OAuth token${
                            preflight.tokenCount === 1 ? "" : "s"
                          }`}
                    </Badge>
                  </div>
                </div>

                {preflight.user.isAdmin && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4 text-danger" />
                    <AlertDescription>
                      This user is a <strong>super admin</strong>. Demote their
                      admin role in the Google Admin Console first —
                      Open Admin refuses to suspend an admin.
                    </AlertDescription>
                  </Alert>
                )}

                {/* Successor */}
                {needsSuccessor && (
                  <div className="space-y-2">
                    <Label htmlFor="successor">
                      Successor (mail / calendar / Drive land here)
                    </Label>
                    <Input
                      id="successor"
                      placeholder="manager@yourdomain.com"
                      value={successor}
                      onChange={(e) => {
                        setSuccessor(e.target.value);
                        // A confirmation typed for one address must not
                        // carry over to another.
                        setExternalConfirm("");
                      }}
                      disabled={running}
                    />
                    {successorIsLeaver && (
                      <p className="text-xs text-danger">
                        Successor must be different from the leaver (
                        {preflight.user.primaryEmail}).
                      </p>
                    )}
                    {externalConfirmNeeded && !successorIsLeaver && (
                      <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/8 p-3">
                        <p className="text-xs text-warning-fg">
                          <strong>{successor.trim()}</strong> is outside your
                          organisation
                          {verifiedDomains === null
                            ? " (or the tenant's domains couldn't be checked)"
                            : ""}
                          . Forwarded mail, ownership of the primary calendar
                          and every Drive file this user owns would go to an
                          account your organisation doesn&apos;t control.
                        </p>
                        <Label htmlFor="externalConfirm" className="text-xs">
                          Type the successor&apos;s address to confirm
                        </Label>
                        <Input
                          id="externalConfirm"
                          value={externalConfirm}
                          onChange={(e) => setExternalConfirm(e.target.value)}
                          placeholder={successor.trim()}
                          className="font-mono text-sm"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={running}
                        />
                      </div>
                    )}
                  </div>
                )}

                <Separator />

                {/* Steps */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Steps to run</p>
                  <p className="text-xs text-muted-foreground">
                    Steps run in fixed order: settings → transfers → revoke →
                    sign-out → suspend last. So admin operations don&apos;t
                    fail on a suspended account.
                  </p>
                  <ul className="space-y-2">
                    {STEPS.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
                      >
                        <input
                          type="checkbox"
                          checked={enabled[s.id]}
                          onChange={(e) =>
                            setEnabled((prev) => ({
                              ...prev,
                              [s.id]: e.target.checked,
                            }))
                          }
                          className="mt-1"
                          disabled={running}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">
                              {s.title}
                            </span>
                            {s.emphasis && (
                              <Badge
                                variant="outline"
                                className="text-xs border-warning/30 bg-warning/10 text-warning-fg"
                              >
                                high impact
                              </Badge>
                            )}
                            {results[s.id] && (
                              <span className="ml-auto flex items-center gap-1.5 text-xs">
                                {statusIcon(results[s.id].status)}
                                {results[s.id].message}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {s.description}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {enabled.vacation && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-xs font-medium">Vacation responder</p>
                    <div className="space-y-1.5">
                      <Label htmlFor="vacSubject" className="text-xs">
                        Subject
                      </Label>
                      <Input
                        id="vacSubject"
                        value={vacationSubject}
                        onChange={(e) => setVacationSubject(e.target.value)}
                        disabled={running}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="vacBody" className="text-xs">
                        Message
                      </Label>
                      <Textarea
                        id="vacBody"
                        value={vacationMessage}
                        onChange={(e) => setVacationMessage(e.target.value)}
                        rows={4}
                        disabled={running}
                      />
                    </div>
                  </div>
                )}

                {runInfo && (running || Object.keys(results).length > 0) && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {running ? "Offboarding" : "Offboarded"} {runInfo.user}
                    {runInfo.tenantName ? ` in ${runInfo.tenantName}` : ""}
                    {running ? "…" : "."}
                    {runInfo.tenantName && tenant && tenant.name !== runInfo.tenantName
                      ? ` You have since switched to ${tenant.name}; ${running ? "this run carries on against" : "this ran against"} ${runInfo.tenantName}.`
                      : ""}
                  </p>
                )}
                {!preflightIsCurrent && !running && (
                  <p className="text-xs text-warning-fg">
                    This user was looked up in{" "}
                    {preflightTenant?.name ?? "another tenant"}. Look them up
                    again to offboard them in the tenant shown in the sidebar.
                  </p>
                )}

                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => {
                    setDialogError(null);
                    setConfirmOpen(true);
                  }}
                  disabled={!canReview}
                >
                  <UserMinus className="mr-2 h-4 w-4" />
                  Review &amp; Run Offboarding
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What this does</CardTitle>
            <CardDescription>Read this once, then trust it.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-3 text-muted-foreground">
            <p>
              Offboarding orchestrates seven primitives in the right order so a
              departing employee&apos;s mail keeps flowing, their calendar and
              files transfer cleanly, and their access is fully cut.
            </p>
            <p>
              Steps that change state on Google&apos;s side are audited
              individually — if step 4 fails, steps 1–3 stay applied and you
              can re-run only what&apos;s left.
            </p>
            <p>
              <strong>Drive transfer is asynchronous.</strong> The API call
              returns immediately; Google moves files in the background.
              Verify completion in the Admin Console &gt; Data &amp; Migration
              if the volume is large.
            </p>
            <p className="text-xs">
              Required scopes:{" "}
              <code className="bg-muted px-1 rounded">
                admin.directory.user
              </code>
              ,{" "}
              <code className="bg-muted px-1 rounded">
                admin.directory.user.security
              </code>
              ,{" "}
              <code className="bg-muted px-1 rounded">admin.datatransfer</code>
              , plus the existing Gmail and Calendar scopes.
            </p>
          </CardContent>
        </Card>
      </div>

      {preflight && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => {
            if (running) return;
            if (!o) setDialogError(null);
            setConfirmOpen(o);
          }}
          title={`Offboard ${preflight.user.primaryEmail}`}
          summary="Sequential, audited offboarding. Each step runs server-side; if any step fails, the account-cutoff steps (sign-out, suspend) are held back so you can fix it and re-run only what's left."
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity="high"
          confirmPhrase={preflight.user.primaryEmail}
          confirmLabel={`Run ${selectedSteps.length} step${selectedSteps.length === 1 ? "" : "s"}`}
          busy={running}
          changes={buildDiff()}
          warnings={
            <>
              {externalConfirmNeeded && successor.trim() && (
                <p className="mb-2">
                  <strong>{successor.trim()}</strong> is outside this
                  tenant&apos;s verified domains — forwarded mail, calendar
                  ownership and the user&apos;s Drive files will be handed to an
                  external account.
                </p>
              )}
              <strong>Drive transfer is irreversible without admin support.</strong>{" "}
              Suspending the account is reversible (un-suspend), but revoked
              OAuth tokens and forced sign-outs are not — the user would
              re-authorise apps after un-suspension.
            </>
          }
          error={dialogError}
          onConfirm={runAll}
        />
      )}
    </>
  );
}
