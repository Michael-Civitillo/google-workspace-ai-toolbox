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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import { CalendarDays, Loader2, Trash2, UserPlus, Search } from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

interface AclRule {
  id: string;
  role: string;
  scope: {
    type: string;
    value: string;
  };
}

const roleDescriptions: Record<string, string> = {
  freeBusyReader: "See free/busy only",
  reader: "See all event details",
  writer: "Make changes to events",
  owner: "Full ownership and sharing control",
};

const roleBadgeColors: Record<string, string> = {
  freeBusyReader: "border-border bg-muted text-muted-foreground",
  reader: "border-info/25 bg-info/10 text-info-fg",
  writer: "border-warning/30 bg-warning/10 text-warning-fg",
  owner: "border-primary/20 bg-primary/10 text-primary",
};

/** A grant as it stood when its confirmation opened. */
interface PendingAdd {
  calendar: string;
  delegate: string;
  role: string;
  /** Outside the tenant's verified domains (or the domains are unknown). */
  external: boolean;
}

/** A removal as it stood when its confirmation opened. */
interface PendingRemove {
  calendar: string;
  rule: AclRule;
}

export default function CalendarDelegation() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [calendarId, setCalendarId] = useState("");
  const [delegateEmail, setDelegateEmail] = useState("");
  const [role, setRole] = useState("reader");
  const [aclRules, setAclRules] = useState<AclRule[]>([]);
  // The calendar the displayed rules were actually fetched for. Remove actions
  // target THIS, not the live input, so editing the field after searching can't
  // send a delete against a different calendar.
  const [listedCalendar, setListedCalendar] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // What each dialog acts on, pinned when it opens: a lookup that finishes
  // while a dialog is open must not change what its Confirm does.
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Tenant's verified domains (aliases included), for flagging an outside
  // grantee. null = not loaded / lookup failed → treated as outside, the same
  // fail-safe the server's gate uses.
  const [verifiedDomains, setVerifiedDomains] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Live tenant id for staleness checks inside async closures.
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  // Only the latest list request may fill the panel: a slow lookup of one
  // calendar must not land after a newer one, or after a tenant switch.
  const listSeq = useRef(0);

  // Clear everything tenant-scoped when the tenant changes — rules fetched
  // for tenant A must never drive removals against tenant B, and a dialog
  // opened under A must not confirm under B.
  useEffect(() => {
    let cancelled = false;
    listSeq.current++;
    setLoading(false);
    setAclRules([]);
    setListedCalendar("");
    setPendingAdd(null);
    setPendingRemove(null);
    setAddError(null);
    setRemoveError(null);
    setVerifiedDomains(null);
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

  const isExternal = (address: string) => {
    const at = address.lastIndexOf("@");
    const domain = at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
    return !!domain && (verifiedDomains === null || !verifiedDomains.includes(domain));
  };

  const listAcl = async (calendarOverride?: string) => {
    // calendarOverride lets refresh-after-change re-list the calendar the
    // change ran against — the live input may have been retyped since.
    const calendar = (calendarOverride ?? calendarId).trim();
    if (!calendar) return;
    const seq = ++listSeq.current;
    setLoading(true);
    setMessage(null);
    // Pin the tenant this list belongs to, and discard the response if the
    // tenant changed while it was in flight — otherwise a stale tenant-A list
    // repopulates the UI under tenant B and defeats the listedCalendar guard.
    const pinnedTenantId = tenantId;
    const isLatest = () =>
      listSeq.current === seq && tenantIdRef.current === pinnedTenantId;

    try {
      const res = await tfetch(
        `/api/gws/calendar-delegation?calendarId=${encodeURIComponent(calendar)}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (!isLatest()) return;

      if (result.success && result.data?.items) {
        setAclRules(result.data.items);
        setListedCalendar(calendar);
        if (result.data.nextPageToken) {
          // The server caps the walk at 1,000 rules and tells us more exist —
          // dropping that signal would present a partial ACL as the whole one.
          setMessage({
            type: "success",
            text: `Showing the first ${result.data.items.length} access rules — this calendar has more that are not listed here.`,
          });
        }
      } else if (result.success) {
        setAclRules([]);
        setListedCalendar(calendar);
        setMessage({ type: "success", text: "No ACL rules found." });
      } else {
        setMessage({ type: "error", text: result.error || "Failed to list ACL rules" });
      }
    } catch {
      if (!isLatest()) return;
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      if (listSeq.current === seq) setLoading(false);
    }
  };

  const openAdd = () => {
    const calendar = calendarId.trim();
    const delegate = delegateEmail.trim();
    if (!calendar || !delegate) return;
    setMessage(null);
    setAddError(null);
    setPendingAdd({ calendar, delegate, role, external: isExternal(delegate) });
  };

  const addAcl = async (p: PendingAdd) => {
    setAdding(true);
    setMessage(null);
    setAddError(null);
    const pinnedTenantId = tenantId;
    const isOwner = p.role === "owner";

    try {
      const res = await tfetch(
        "/api/gws/calendar-delegation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            calendarId: p.calendar,
            delegateEmail: p.delegate,
            role: p.role,
            // An owner grant needs the delegate's address typed in the dialog
            // (the server checks it), and the dialog only confirms once it
            // matches — so this is what the operator typed.
            confirm: isOwner ? p.delegate : undefined,
            // Only when this page judged the address external, from the same
            // typed phrase: the server's own check of outside owners then
            // sees an intentional grant rather than one the page assumed.
            confirmExternal: isOwner && p.external ? p.delegate : undefined,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setDelegateEmail("");
        setPendingAdd(null);
        // Refresh first, then set the message: listAcl clears messages in its
        // synchronous prologue, so setting it earlier batches a set+clear into
        // one render and the success feedback is never painted.
        await listAcl(p.calendar);
        if (tenantIdRef.current !== pinnedTenantId) return;
        setMessage({
          type: "success",
          text: `Granted ${p.role} access to ${p.delegate}`,
        });
      } else {
        // Stay in the dialog: that is where the operator is looking.
        setAddError(result.error || "Failed to add access");
      }
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      setAddError("Failed to connect to the API");
    } finally {
      setAdding(false);
    }
  };

  const removeAcl = async (p: PendingRemove) => {
    setRemoving(p.rule.id);
    setMessage(null);
    setRemoveError(null);
    const pinnedTenantId = tenantId;

    try {
      const res = await tfetch(
        "/api/gws/calendar-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // The calendar and rule the dialog was opened for, never the live
          // input or a list that loaded since. Removing an owner needs the
          // owner's address, which the dialog had the operator type.
          body: JSON.stringify({
            calendarId: p.calendar,
            ruleId: p.rule.id,
            confirm: p.rule.role === "owner" ? p.rule.scope?.value : undefined,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setPendingRemove(null);
        // Refresh the calendar the removal actually ran against. Refresh
        // before messaging — listAcl's prologue clears messages, which would
        // erase this success text in the same batched render.
        await listAcl(p.calendar);
        if (tenantIdRef.current !== pinnedTenantId) return;
        setMessage({ type: "success", text: "Access removed successfully" });
      } else {
        setRemoveError(result.error || "Failed to remove access");
      }
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      setRemoveError("Failed to connect to the API");
    } finally {
      setRemoving(null);
    }
  };

  const delegateLooksExternal = !!delegateEmail.trim() && isExternal(delegateEmail.trim());
  const addIsOwner = pendingAdd?.role === "owner";

  return (
    <>
      <PageHeader
        title="Calendar Delegation"
        description="Share calendar access with other users. Control what they can see and do."
        badge="Calendar"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Manage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Manage Calendar Access
            </CardTitle>
            <CardDescription>
              Look up current sharing rules or grant new access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="calendarId">Calendar (User Email)</Label>
              <div className="flex gap-2">
                <Input
                  id="calendarId"
                  placeholder="user@yourdomain.com"
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                />
                <Button
                  variant="secondary"
                  onClick={() => listAcl()}
                  disabled={!calendarId || loading}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="delegateEmail">Grant Access To</Label>
              <Input
                id="delegateEmail"
                placeholder="colleague@yourdomain.com"
                value={delegateEmail}
                onChange={(e) => setDelegateEmail(e.target.value)}
              />
              {delegateLooksExternal && (
                <p className="text-xs text-warning-fg">
                  This address is outside your organisation
                  {verifiedDomains === null
                    ? " (or the tenant's domains couldn't be checked)"
                    : ""}
                  .
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Permission Level</Label>
              <Select
                value={role}
                onValueChange={(v) => v && setRole(v)}
                items={{
                  freeBusyReader: "Free/Busy Only",
                  reader: "View All Details",
                  writer: "Edit Events",
                  owner: "Full Control (Owner)",
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="freeBusyReader">
                    Free/Busy Only
                  </SelectItem>
                  <SelectItem value="reader">View All Details</SelectItem>
                  <SelectItem value="writer">Edit Events</SelectItem>
                  <SelectItem value="owner">Full Control (Owner)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {roleDescriptions[role]}
              </p>
            </div>

            <Button
              className="w-full"
              onClick={openAdd}
              disabled={!calendarId.trim() || !delegateEmail.trim() || adding}
            >
              {adding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              Review &amp; Grant Access
            </Button>
          </CardContent>
        </Card>

        {/* Current ACL */}
        <Card>
          <CardHeader>
            <CardTitle>Current Access Rules</CardTitle>
            <CardDescription>
              {aclRules.length > 0
                ? `${aclRules.length} rule${aclRules.length > 1 ? "s" : ""} found for ${listedCalendar}`
                : "Search for a calendar to see access rules"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {aclRules.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No access rules to display
              </div>
            ) : (
              <div className="space-y-3">
                {aclRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-success/10 flex items-center justify-center">
                        <CalendarDays className="h-4 w-4 text-success" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {rule.scope?.value || rule.scope?.type}
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            roleBadgeColors[rule.role] ||
                            "bg-muted text-muted-foreground"
                          }
                        >
                          {rule.role}
                        </Badge>
                      </div>
                    </div>
                    {rule.scope?.type === "user" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!listedCalendar) return;
                          setMessage(null);
                          setRemoveError(null);
                          setPendingRemove({ calendar: listedCalendar, rule });
                        }}
                        disabled={removing === rule.id}
                      >
                        {removing === rule.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-danger" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmActionDialog
        open={!!pendingAdd}
        onOpenChange={(o) => {
          if (adding || o) return;
          setPendingAdd(null);
          setAddError(null);
        }}
        title="Grant calendar access"
        summary={`Give ${pendingAdd?.delegate ?? "—"} ${pendingAdd?.role ?? ""} access to ${pendingAdd?.calendar ?? "—"}'s calendar.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity={addIsOwner ? "high" : "medium"}
        confirmPhrase={addIsOwner ? pendingAdd?.delegate : undefined}
        confirmLabel={addError ? "Try again" : addIsOwner ? "Grant ownership" : "Grant access"}
        busy={adding}
        changes={[
          { label: "Calendar", after: pendingAdd?.calendar ?? "" },
          {
            label: pendingAdd?.external ? "Grantee (outside your organisation)" : "Grantee",
            after: pendingAdd?.delegate ?? "",
            emphasis: !!pendingAdd?.external,
          },
          {
            label: "Role",
            after: `${pendingAdd?.role ?? ""} — ${roleDescriptions[pendingAdd?.role ?? ""] ?? ""}`,
            emphasis: pendingAdd?.role === "owner" || pendingAdd?.role === "writer",
          },
        ]}
        warnings={
          pendingAdd?.external || addIsOwner ? (
            <>
              {pendingAdd?.external && (
                <p className={addIsOwner ? "mb-2" : undefined}>
                  <strong>{pendingAdd.delegate}</strong> is outside your
                  organisation
                  {verifiedDomains === null
                    ? " (or the tenant's domains couldn't be checked)"
                    : ""}
                  : the calendar&apos;s events will be shared with an account
                  your organisation doesn&apos;t control.
                </p>
              )}
              {addIsOwner && (
                <p>
                  <strong>Owner</strong> can re-share, transfer, and delete the
                  calendar. Only grant this if {pendingAdd?.delegate} should
                  have full control.
                </p>
              )}
            </>
          ) : null
        }
        error={addError}
        onConfirm={() => {
          if (pendingAdd) void addAcl(pendingAdd);
        }}
      />

      <ConfirmActionDialog
        open={!!pendingRemove}
        onOpenChange={(o) => {
          if (removing || o) return;
          setPendingRemove(null);
          setRemoveError(null);
        }}
        title="Remove calendar access"
        summary={`Revoke ${pendingRemove?.rule.scope?.value ?? ""}'s ${pendingRemove?.rule.role ?? ""} access to ${pendingRemove?.calendar ?? ""}.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity={pendingRemove?.rule.role === "owner" ? "high" : "medium"}
        confirmPhrase={
          pendingRemove?.rule.role === "owner" ? pendingRemove.rule.scope?.value : undefined
        }
        confirmLabel={removeError ? "Try again" : "Remove access"}
        busy={!!removing}
        changes={[
          { label: "Calendar", after: pendingRemove?.calendar ?? "" },
          {
            label: "Removing",
            before: `${pendingRemove?.rule.scope?.value ?? ""} (${pendingRemove?.rule.role ?? ""})`,
            after: "no longer has access",
            emphasis: true,
          },
        ]}
        warnings={
          pendingRemove?.rule.role === "owner" ? (
            <>
              Removing an owner from a secondary calendar with no other owners
              can leave the calendar orphaned. Make sure another owner exists.
            </>
          ) : null
        }
        error={removeError}
        onConfirm={() => {
          if (pendingRemove) void removeAcl(pendingRemove);
        }}
      />
    </>
  );
}
