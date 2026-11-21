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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert, type Feedback } from "@/components/feedback-alert";
import { CopyButton } from "@/components/copy-button";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  RotateCcw,
  UserPlus,
  XCircle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { isValidEmail } from "@/lib/validate-email";

interface DomainInfo {
  domainName: string;
  isPrimary: boolean;
  verified: boolean;
  isAlias?: boolean;
}

interface Created {
  primaryEmail: string;
  orgUnitPath: string;
  temporaryPassword: string;
}

interface ResetResult {
  primaryEmail: string;
  temporaryPassword: string;
  /** null when signing out wasn't asked for. */
  signedOut: boolean | null;
  signOutError: string | null;
}

type GroupStatus = "waiting" | "adding" | "added" | "already" | "failed";

interface GroupRow {
  group: string;
  status: GroupStatus;
  error?: string;
}

const MAX_GROUPS = 20;
/** A brand-new account can take a few seconds to be addable to a group. */
const GROUP_RETRY_DELAY_MS = 3000;
const GROUP_ATTEMPTS = 3;

const JSON_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "Zoë Müller-Smith" → "zoe.mullersmith". Only a suggestion; it stays editable. */
function suggestUsername(first: string, last: string): string {
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const f = clean(first);
  const l = clean(last);
  return f && l ? `${f}.${l}` : f || l;
}

/**
 * One group per line. A bare name ("sales") is taken to be on the new
 * account's domain. Returns the addresses and the lines that aren't one.
 */
function parseGroups(text: string, domain: string): { groups: string[]; bad: string[] } {
  const groups: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const line = raw.trim().toLowerCase();
    if (!line) continue;
    const address = line.includes("@") ? line : domain ? `${line}@${domain}` : line;
    if (!isValidEmail(address)) bad.push(raw.trim());
    else if (!groups.includes(address)) groups.push(address);
  }
  return { groups, bad };
}

/**
 * The temporary password, shown once. It exists only in this page's memory:
 * the server doesn't keep it and neither does the audit log, so leaving the
 * page loses it for good (the fix is another reset).
 */
function TemporaryPassword({
  email,
  password,
  testId,
}: {
  email: string;
  password: string;
  testId: string;
}) {
  const details = `Email: ${email}\nTemporary password: ${password}\nSign in at https://accounts.google.com`;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Temporary password
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          data-testid={testId}
          className="rounded-md border bg-background px-3 py-1.5 font-mono text-sm tracking-wide select-all"
        >
          {password}
        </code>
        <CopyButton value={password} label="Copy password" />
        <CopyButton value={details} label="Copy sign-in details" />
      </div>
      <p className="text-xs text-muted-foreground">
        Copy it now. It is shown this once and isn&apos;t saved anywhere, not even in
        the audit log. They will be asked to choose their own password the first
        time they sign in with it.
      </p>
    </div>
  );
}

export default function NewUser() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);

  // Create
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [domain, setDomain] = useState("");
  const [orgUnitPath, setOrgUnitPath] = useState("/");
  const [groupsText, setGroupsText] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [groupRows, setGroupRows] = useState<GroupRow[]>([]);

  // Reset
  const [resetEmail, setResetEmail] = useState("");
  const [resetSignOut, setResetSignOut] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [resetMessage, setResetMessage] = useState<Feedback | null>(null);

  // Live tenant id, and a counter that invalidates group adds still in flight
  // when the result they belong to is dismissed or replaced.
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const runRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Everything on this page belongs to one tenant, passwords included. A
    // tenant switch starts it clean.
    runRef.current++;
    setLoadingDomains(true);
    setDomainsError(null);
    setDomains([]);
    setDomain("");
    setCreated(null);
    setGroupRows([]);
    setCreateOpen(false);
    setCreateError(null);
    setResetOpen(false);
    setResetError(null);
    setResetResult(null);
    setResetMessage(null);
    tfetch("/api/admin/domains", {}, tenantId)
      .then((res) => res.json())
      .then((result) => {
        if (cancelled) return;
        if (result.success && Array.isArray(result.data)) {
          // Accounts live on full, verified domains. An alias only mirrors one.
          const usable = (result.data as DomainInfo[]).filter(
            (d) => d.verified && !d.isAlias
          );
          setDomains(usable);
          setDomain((usable.find((d) => d.isPrimary) ?? usable[0])?.domainName ?? "");
        } else {
          setDomainsError(result.error || "Could not load this tenant's domains.");
        }
      })
      .catch(() => {
        if (!cancelled) setDomainsError("Could not reach the server.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const cleanUsername = username.trim().toLowerCase();
  const newEmail = cleanUsername && domain ? `${cleanUsername}@${domain}` : "";
  const parsedGroups = useMemo(() => parseGroups(groupsText, domain), [groupsText, domain]);
  const orgUnit = orgUnitPath.trim() || "/";

  const formProblem = !givenName.trim()
    ? "Enter a first name."
    : !familyName.trim()
      ? "Enter a last name."
      : !newEmail
        ? "Enter a username."
        : !isValidEmail(newEmail)
          ? `${newEmail} isn't a valid email address.`
          : !orgUnit.startsWith("/")
            ? 'The organisational unit must start with "/".'
            : parsedGroups.bad.length > 0
              ? `Not a group address: ${parsedGroups.bad.slice(0, 3).join(", ")}`
              : parsedGroups.groups.length > MAX_GROUPS
                ? `At most ${MAX_GROUPS} groups here. Add the rest from the Groups page.`
                : null;

  function onNameChange(first: string, last: string) {
    setGivenName(first);
    setFamilyName(last);
    if (!usernameEdited) setUsername(suggestUsername(first, last));
  }

  function setRow(run: number, index: number, patch: Partial<GroupRow>) {
    if (runRef.current !== run) return;
    setGroupRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  }

  /** Add the new account to its groups one at a time, showing each result. */
  async function addToGroups(
    member: string,
    groups: string[],
    pinnedTenantId: string | null,
    run: number,
    only?: number
  ) {
    const live = () => runRef.current === run && tenantIdRef.current === pinnedTenantId;
    for (let i = 0; i < groups.length; i++) {
      if (only !== undefined && i !== only) continue;
      if (!live()) return;
      setRow(run, i, { status: "adding", error: undefined });
      let error = "";
      let done = false;
      for (let attempt = 0; attempt < GROUP_ATTEMPTS && !done; attempt++) {
        if (attempt > 0) await sleep(GROUP_RETRY_DELAY_MS);
        if (!live()) return;
        try {
          const res = await tfetch(
            "/api/admin/groups/members",
            { ...JSON_POST, body: JSON.stringify({ group: groups[i], member }) },
            pinnedTenantId
          );
          const result = await res.json();
          if (result.success) {
            setRow(run, i, { status: result.data?.alreadyMember ? "already" : "added" });
            done = true;
          } else {
            error = result.error || `The server answered ${res.status}`;
            // A group that doesn't exist won't start existing; only the new
            // account itself is worth waiting for.
            if (/groupKey/i.test(error)) break;
          }
        } catch {
          error = "Could not reach the server.";
        }
      }
      if (!done) setRow(run, i, { status: "failed", error });
    }
  }

  async function create() {
    const pinnedTenantId = tenantId;
    const groups = parsedGroups.groups;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await tfetch(
        "/api/admin/user/create",
        {
          ...JSON_POST,
          body: JSON.stringify({
            givenName: givenName.trim(),
            familyName: familyName.trim(),
            primaryEmail: newEmail,
            orgUnitPath: orgUnit,
            confirm: newEmail,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (!result.success || !result.data) {
        setCreateError(result.error || "The account could not be created.");
        return;
      }
      const run = ++runRef.current;
      setCreated(result.data as Created);
      setGroupRows(groups.map((group) => ({ group, status: "waiting" })));
      setCreateOpen(false);
      // The form is done with: a second click must not try to create it again.
      setGivenName("");
      setFamilyName("");
      setUsername("");
      setUsernameEdited(false);
      setGroupsText("");
      void addToGroups(result.data.primaryEmail, groups, pinnedTenantId, run);
    } catch {
      if (tenantIdRef.current === pinnedTenantId) {
        setCreateError(
          "Could not reach the server. Check whether the account exists before trying again."
        );
      }
    } finally {
      setCreating(false);
    }
  }

  const resetTarget = resetEmail.trim().toLowerCase();

  async function resetPassword() {
    const pinnedTenantId = tenantId;
    setResetting(true);
    setResetError(null);
    try {
      const res = await tfetch(
        "/api/admin/user/password-reset",
        {
          ...JSON_POST,
          body: JSON.stringify({
            user: resetTarget,
            confirm: resetTarget,
            signOut: resetSignOut,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (!result.success || !result.data) {
        setResetError(result.error || "The password could not be reset.");
        return;
      }
      setResetResult(result.data as ResetResult);
      setResetOpen(false);
      setResetEmail("");
      setResetSignOut(false);
    } catch {
      if (tenantIdRef.current === pinnedTenantId) {
        setResetError(
          "Could not reach the server. The password may or may not have changed; reset it again to be sure."
        );
      }
    } finally {
      setResetting(false);
    }
  }

  const groupsBusy = groupRows.some((r) => r.status === "adding" || r.status === "waiting");

  return (
    <div>
      <PageHeader
        title="New User"
        badge="Directory"
        description="Create an account for someone joining, add them to their groups, and hand over a temporary password. Or reset the password of someone who can't sign in."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" data-testid="new-user-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Create an account
            </CardTitle>
            <CardDescription>
              Uses one licence. Nothing is created until you confirm on the next
              screen.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {created && (
              <div
                data-testid="new-user-result"
                className="space-y-4 rounded-lg border border-success/25 bg-success/8 p-4"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <div className="min-w-0">
                    <p className="font-medium break-all">{created.primaryEmail} was created</p>
                    <p className="text-xs text-muted-foreground">
                      In {created.orgUnitPath === "/" ? "the top-level organisation" : created.orgUnitPath}
                    </p>
                  </div>
                </div>

                <TemporaryPassword
                  email={created.primaryEmail}
                  password={created.temporaryPassword}
                  testId="new-user-password"
                />

                {groupRows.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Groups
                    </p>
                    <ul className="space-y-1.5" data-testid="new-user-groups">
                      {groupRows.map((row, i) => (
                        <li
                          key={row.group}
                          className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 break-all">{row.group}</span>
                          {row.status === "waiting" && <Badge variant="secondary">Waiting</Badge>}
                          {row.status === "adding" && (
                            <Badge variant="secondary">
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              Adding
                            </Badge>
                          )}
                          {row.status === "added" && <Badge variant="success">Added</Badge>}
                          {row.status === "already" && (
                            <Badge variant="success">Already a member</Badge>
                          )}
                          {row.status === "failed" && (
                            <>
                              <Badge variant="destructive">Not added</Badge>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={groupsBusy}
                                onClick={() =>
                                  void addToGroups(
                                    created.primaryEmail,
                                    groupRows.map((r) => r.group),
                                    tenantId,
                                    runRef.current,
                                    i
                                  )
                                }
                              >
                                <RotateCcw className="mr-1 h-3 w-3" />
                                Try again
                              </Button>
                              <p className="basis-full text-xs text-danger-fg break-words">
                                {row.error}
                              </p>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    runRef.current++;
                    setCreated(null);
                    setGroupRows([]);
                  }}
                >
                  I&apos;ve copied it, clear this
                </Button>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="givenName">First name</Label>
                <Input
                  id="givenName"
                  value={givenName}
                  maxLength={60}
                  onChange={(e) => onNameChange(e.target.value, familyName)}
                  placeholder="Jane"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="familyName">Last name</Label>
                <Input
                  id="familyName"
                  value={familyName}
                  maxLength={60}
                  onChange={(e) => onNameChange(givenName, e.target.value)}
                  placeholder="Doe"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Email address</Label>
              {loadingDomains ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading domains...
                </div>
              ) : domainsError ? (
                <FeedbackAlert message={{ type: "error", text: domainsError }} />
              ) : domains.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This tenant has no verified domain to create an account on.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="username"
                    className="min-w-40 flex-1"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setUsernameEdited(e.target.value !== "");
                    }}
                    placeholder="jane.doe"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="text-muted-foreground">@</span>
                  {domains.length === 1 ? (
                    <span className="text-sm font-medium" data-testid="new-user-domain">
                      {domain}
                    </span>
                  ) : (
                    <Select value={domain} onValueChange={(v) => v && setDomain(v)}>
                      <SelectTrigger className="w-auto min-w-44" data-testid="new-user-domain">
                        <SelectValue placeholder="Pick a domain..." />
                      </SelectTrigger>
                      <SelectContent>
                        {domains.map((d) => (
                          <SelectItem key={d.domainName} value={d.domainName}>
                            {d.domainName}
                            {d.isPrimary ? " (primary)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="orgUnitPath">
                Organisational unit{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="orgUnitPath"
                value={orgUnitPath}
                onChange={(e) => setOrgUnitPath(e.target.value)}
                placeholder="/"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Leave it as <code className="font-mono">/</code> for the top level, or
                type a path exactly as the Admin console shows it, like{" "}
                <code className="font-mono">/Sales/EMEA</code>. It decides which
                settings and licences the account gets.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="groups">
                Groups to join{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="groups"
                value={groupsText}
                onChange={(e) => setGroupsText(e.target.value)}
                placeholder={`all-staff${domain ? `@${domain}` : ""}\nsales`}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                One per line. A name without @ is taken to be on{" "}
                {domain || "the account's domain"}. They join as ordinary members,
                right after the account is created.
              </p>
            </div>

            {formProblem && (givenName || familyName || username) && (
              <p className="text-xs text-muted-foreground" data-testid="new-user-problem">
                {formProblem}
              </p>
            )}

            <Button
              className="w-full"
              size="lg"
              disabled={!!formProblem || loadingDomains || domains.length === 0}
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Review &amp; create account
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 self-start" data-testid="password-reset-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Reset a password
            </CardTitle>
            <CardDescription>
              For someone who is locked out. They get a temporary password and
              choose their own at the next sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {resetResult && (
              <div
                data-testid="password-reset-result"
                className="space-y-4 rounded-lg border border-success/25 bg-success/8 p-4"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <p className="min-w-0 font-medium break-all">
                    Password reset for {resetResult.primaryEmail}
                  </p>
                </div>
                <TemporaryPassword
                  email={resetResult.primaryEmail}
                  password={resetResult.temporaryPassword}
                  testId="password-reset-password"
                />
                {resetResult.signedOut === true && (
                  <p className="text-xs text-muted-foreground">
                    They were also signed out everywhere. Google can take up to an
                    hour to end a Gmail session that is already open.
                  </p>
                )}
                {resetResult.signedOut === false && (
                  <div className="flex items-start gap-2 text-xs text-danger-fg">
                    <XCircle className="mt-px h-4 w-4 shrink-0" />
                    <p className="min-w-0 break-words">
                      The password was changed, but signing them out failed:{" "}
                      {resetResult.signOutError}. Devices already signed in still
                      are.
                    </p>
                  </div>
                )}
                <Button size="sm" variant="outline" onClick={() => setResetResult(null)}>
                  I&apos;ve copied it, clear this
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="resetEmail">User email</Label>
              <Input
                id="resetEmail"
                value={resetEmail}
                onChange={(e) => {
                  setResetEmail(e.target.value);
                  setResetMessage(null);
                }}
                placeholder="jane@yourdomain.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={resetSignOut}
                onChange={(e) => setResetSignOut(e.target.checked)}
                data-testid="password-reset-signout"
              />
              <span>
                Also sign them out everywhere
                <span className="block text-xs text-muted-foreground">
                  A new password doesn&apos;t sign anyone out. Tick this when someone
                  else may have got into the account.
                </span>
              </span>
            </label>

            <FeedbackAlert message={resetMessage} />

            <Button
              className="w-full"
              variant="secondary"
              disabled={!resetTarget}
              onClick={() => {
                if (!isValidEmail(resetTarget)) {
                  setResetMessage({
                    type: "error",
                    text: `${resetTarget} isn't a valid email address.`,
                  });
                  return;
                }
                setResetError(null);
                setResetOpen(true);
              }}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              Review &amp; reset password
            </Button>

            <p className="text-xs text-muted-foreground">
              Someone leaving? Use{" "}
              <Link href="/offboarding" className="underline underline-offset-2">
                Offboarding
              </Link>{" "}
              instead: it signs them out and suspends the account.
            </p>
          </CardContent>
        </Card>
      </div>

      <ConfirmActionDialog
        open={createOpen}
        onOpenChange={(open) => !creating && setCreateOpen(open)}
        title="Create this account"
        summary="A new person will be able to sign in to your organisation."
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        confirmPhrase={newEmail}
        confirmLabel="Create account"
        busy={creating}
        error={createError}
        onConfirm={create}
        changes={[
          { label: "New account", after: newEmail, emphasis: true },
          { label: "Name", after: `${givenName.trim()} ${familyName.trim()}` },
          {
            label: "Organisational unit",
            after: orgUnit === "/" ? "/ (top level)" : orgUnit,
          },
          {
            label: "Password",
            after: "A random temporary one, to be changed at first sign-in",
          },
          ...(parsedGroups.groups.length > 0
            ? [{ label: "Joins these groups", after: parsedGroups.groups.join(", ") }]
            : []),
        ]}
        warnings={
          <p>
            The account takes a licence if your organisation assigns them
            automatically. Open Admin can&apos;t delete accounts, so a mistake here
            is undone in the Google Admin console.
          </p>
        }
      />

      <ConfirmActionDialog
        open={resetOpen}
        onOpenChange={(open) => !resetting && setResetOpen(open)}
        title="Reset this password"
        summary="Their current password stops working straight away."
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        confirmPhrase={resetTarget}
        confirmLabel="Reset password"
        busy={resetting}
        error={resetError}
        onConfirm={resetPassword}
        changes={[
          { label: "Account", after: resetTarget, emphasis: true },
          {
            label: "Password",
            before: "Their current one",
            after: "A random temporary one, to be changed at next sign-in",
          },
          {
            label: "Devices already signed in",
            after: resetSignOut ? "Signed out everywhere" : "Stay signed in",
          },
        ]}
        warnings={
          <p>
            Only you will see the new password, once. Have a way to get it to them
            that isn&apos;t the mailbox they&apos;re locked out of.
          </p>
        }
      />
    </div>
  );
}
