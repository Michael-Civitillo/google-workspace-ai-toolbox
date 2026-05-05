"use client";

import { useState } from "react";
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
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
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
  tokenCount: number;
  tokens: Array<{ clientId: string; displayText: string }>;
}

type StepId =
  | "vacation"
  | "forward"
  | "calendar"
  | "drive"
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
    id: "revokeTokens",
    title: "Revoke all OAuth tokens",
    description:
      "Disconnects every third-party app the user authorised (Slack, Zoom, etc.).",
    order: 5,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "signOut",
    title: "Sign out of all sessions",
    description:
      "Invalidates the user's active web/mobile sessions. They'll be forced to log in again — and they won't be able to, after suspension.",
    order: 6,
    needsSuccessor: false,
    defaultEnabled: true,
  },
  {
    id: "suspend",
    title: "Suspend the account",
    description:
      "Final step. The user can no longer sign in. Mail still arrives (for forwarding). Reversible by an admin if needed.",
    order: 7,
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
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<StepId, { status: StepStatus; message?: string }>>(
    {} as Record<StepId, { status: StepStatus; message?: string }>
  );
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    if (!email.trim()) return;
    setLookingUp(true);
    setError(null);
    setPreflight(null);
    setResults({} as Record<StepId, { status: StepStatus; message?: string }>);
    try {
      const res = await tfetch(
        `/api/offboarding/preflight?user=${encodeURIComponent(email)}`
      );
      const data = await res.json();
      if (data.success) {
        setPreflight(data.data);
      } else {
        setError(data.error || "Failed to look up user");
      }
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setLookingUp(false);
    }
  };

  const selectedSteps = STEPS.filter((s) => enabled[s.id]);
  const needsSuccessor = selectedSteps.some((s) => s.needsSuccessor);
  const successorOk =
    !needsSuccessor ||
    (/^\S+@\S+\.\S+$/.test(successor.trim()) &&
      successor.trim().toLowerCase() !== email.trim().toLowerCase());

  const canReview =
    !!preflight &&
    selectedSteps.length > 0 &&
    successorOk &&
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
        detail = `Revoke ${preflight?.tokenCount ?? 0} OAuth token${preflight?.tokenCount === 1 ? "" : "s"}`;
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
    if (!preflight) return;
    const pinnedTenantId = tenantId;
    const pinnedSuccessor = successor.trim();
    setRunning(true);
    setError(null);
    const newResults: Record<StepId, { status: StepStatus; message?: string }> =
      {} as Record<StepId, { status: StepStatus; message?: string }>;

    for (const id of RUN_ORDER) {
      if (!enabled[id]) {
        newResults[id] = { status: "skipped" };
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
              user: preflight.user.primaryEmail,
              successor: pinnedSuccessor,
              vacationSubject,
              vacationMessage,
            }),
          },
          pinnedTenantId
        );
        const data = await res.json();
        newResults[id] = {
          status: data.success ? "success" : "error",
          message: data.success
            ? data.data?.message ||
              data.data?.note ||
              "Done"
            : data.error || "Failed",
        };
      } catch {
        newResults[id] = { status: "error", message: "Request failed" };
      }
      setResults({ ...newResults });
    }

    setRunning(false);
    setConfirmOpen(false);
  };

  const statusIcon = (s: StepStatus) => {
    switch (s) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "running":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
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
        <Alert className="mb-6 border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
          <AlertDescription className="text-red-800 dark:text-red-300">{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
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
                  onKeyDown={(e) => e.key === "Enter" && lookup()}
                />
                <Button
                  variant="secondary"
                  onClick={lookup}
                  disabled={!email.trim() || lookingUp}
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
                        className="bg-violet-50 text-violet-700 border-violet-200 text-xs"
                      >
                        Super admin
                      </Badge>
                    )}
                    {preflight.user.suspended && (
                      <Badge
                        variant="outline"
                        className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900/50 text-xs"
                      >
                        Already suspended
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className="bg-zinc-100 text-zinc-700 border-zinc-200 text-xs"
                    >
                      {preflight.tokenCount} OAuth token
                      {preflight.tokenCount === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </div>

                {preflight.user.isAdmin && (
                  <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                      This user is a <strong>super admin</strong>. Demote their
                      admin role in the Google Admin Console first — the
                      toolbox refuses to suspend an admin.
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
                      onChange={(e) => setSuccessor(e.target.value)}
                    />
                    {successor &&
                      successor.trim().toLowerCase() ===
                        email.trim().toLowerCase() && (
                        <p className="text-xs text-red-600">
                          Successor must be different from the leaver.
                        </p>
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
                                className="text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50"
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
                      />
                    </div>
                  </div>
                )}

                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => setConfirmOpen(true)}
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
            <CardTitle className="text-lg">What this does</CardTitle>
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
          onOpenChange={(o) => !running && setConfirmOpen(o)}
          title={`Offboard ${preflight.user.primaryEmail}`}
          summary="Sequential, audited offboarding. Each step runs server-side; failures don't block later steps unless you say so."
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity="high"
          confirmPhrase={preflight.user.primaryEmail}
          confirmLabel={`Run ${selectedSteps.length} step${selectedSteps.length === 1 ? "" : "s"}`}
          busy={running}
          changes={buildDiff()}
          warnings={
            <>
              <strong>Drive transfer is irreversible without admin support.</strong>{" "}
              Suspending the account is reversible (un-suspend), but revoked
              OAuth tokens and forced sign-outs are not — the user would
              re-authorise apps after un-suspension.
            </>
          }
          onConfirm={runAll}
        />
      )}
    </>
  );
}
