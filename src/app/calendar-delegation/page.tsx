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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
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
  freeBusyReader: "bg-zinc-100 text-zinc-700 border-zinc-200",
  reader: "bg-blue-100 text-blue-700 border-blue-200",
  writer: "bg-amber-100 text-amber-700 border-amber-200",
  owner: "bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900/50",
};

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
  const [confirmAddOpen, setConfirmAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AclRule | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Live tenant id for staleness checks inside async closures.
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  const listAcl = async (calendarOverride?: string) => {
    // calendarOverride lets refresh-after-removal re-list the calendar the
    // panel is showing (listedCalendar) — the live input may have been
    // retyped since.
    const calendar = (calendarOverride ?? calendarId).trim();
    if (!calendar) return;
    setLoading(true);
    setMessage(null);
    // Pin the tenant this list belongs to, and discard the response if the
    // tenant changed while it was in flight — otherwise a stale tenant-A list
    // repopulates the UI under tenant B and defeats the listedCalendar guard.
    const pinnedTenantId = tenantId;

    try {
      const res = await tfetch(
        `/api/gws/calendar-delegation?calendarId=${encodeURIComponent(calendar)}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

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
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  // Clear a stale rules list when the tenant changes — rules fetched for tenant
  // A must never drive removals against tenant B.
  useEffect(() => {
    setAclRules([]);
    setListedCalendar("");
  }, [tenantId]);

  const addAcl = async () => {
    if (!calendarId || !delegateEmail || !role) return;
    setAdding(true);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/calendar-delegation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            calendarId,
            delegateEmail,
            role,
            // The dialog already made the operator type the delegate email for
            // owner grants; relay that confirmation so the server's
            // external-owner gate accepts intentional external grants.
            confirmExternal:
              role === "owner" ? delegateEmail.trim() : undefined,
          }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        const grantedTo = delegateEmail;
        setDelegateEmail("");
        setConfirmAddOpen(false);
        // Refresh first, then set the message: listAcl clears messages in its
        // synchronous prologue, so setting it earlier batches a set+clear into
        // one render and the success feedback is never painted.
        await listAcl();
        setMessage({
          type: "success",
          text: `Granted ${role} access to ${grantedTo}`,
        });
      } else {
        // Close the dialog so the page-level error banner isn't hidden
        // behind the modal overlay.
        setConfirmAddOpen(false);
        setMessage({ type: "error", text: result.error || "Failed to add access" });
      }
    } catch {
      setConfirmAddOpen(false);
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setAdding(false);
    }
  };

  const removeAcl = async (ruleId: string) => {
    if (!listedCalendar) return;
    setRemoving(ruleId);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/calendar-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // Target the calendar the list was fetched for, not the live input.
          body: JSON.stringify({ calendarId: listedCalendar, ruleId }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setConfirmRemove(null);
        // Refresh the calendar the removal actually ran against — the live
        // input may point somewhere else by now. Refresh before messaging —
        // listAcl's prologue clears messages, which would erase this success
        // text in the same batched render.
        await listAcl(listedCalendar);
        setMessage({ type: "success", text: "Access removed successfully" });
      } else {
        // Close the dialog so the page-level error banner isn't hidden
        // behind the modal overlay.
        setConfirmRemove(null);
        setMessage({ type: "error", text: result.error || "Failed to remove access" });
      }
    } catch {
      setConfirmRemove(null);
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Calendar Delegation"
        description="Share calendar access with other users. Control what they can see and do."
        badge="Calendar"
      />

      {message && (
        <Alert
          className={`mb-6 ${message.type === "error" ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40" : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"}`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Manage */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
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
            </div>

            <div className="space-y-2">
              <Label>Permission Level</Label>
              <Select value={role} onValueChange={(v) => v && setRole(v)}>
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
              onClick={() => {
                setMessage(null);
                setConfirmAddOpen(true);
              }}
              disabled={!calendarId || !delegateEmail || adding}
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
            <CardTitle className="text-lg">Current Access Rules</CardTitle>
            <CardDescription>
              {aclRules.length > 0
                ? `${aclRules.length} rule${aclRules.length > 1 ? "s" : ""} found`
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
                      <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center">
                        <CalendarDays className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {rule.scope?.value || rule.scope?.type}
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            roleBadgeColors[rule.role] ||
                            "bg-zinc-100 text-zinc-700"
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
                          setMessage(null);
                          setConfirmRemove(rule);
                        }}
                        disabled={removing === rule.id}
                      >
                        {removing === rule.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-red-500" />
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
        open={confirmAddOpen}
        onOpenChange={(o) => !adding && setConfirmAddOpen(o)}
        title="Grant calendar access"
        summary={`Give ${delegateEmail || "—"} ${role} access to ${calendarId || "—"}'s calendar.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity={role === "owner" ? "high" : "medium"}
        confirmPhrase={role === "owner" ? delegateEmail : undefined}
        confirmLabel={role === "owner" ? "Grant ownership" : "Grant access"}
        busy={adding}
        changes={[
          { label: "Calendar", after: calendarId },
          { label: "Grantee", after: delegateEmail },
          {
            label: "Role",
            after: `${role} — ${roleDescriptions[role] ?? ""}`,
            emphasis: role === "owner" || role === "writer",
          },
        ]}
        warnings={
          role === "owner" ? (
            <>
              <strong>Owner</strong> can re-share, transfer, and delete the
              calendar. Only grant this if {delegateEmail} should have full
              control.
            </>
          ) : null
        }
        onConfirm={addAcl}
      />

      <ConfirmActionDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !removing && !o && setConfirmRemove(null)}
        title="Remove calendar access"
        summary={`Revoke ${confirmRemove?.scope?.value ?? ""}'s ${confirmRemove?.role ?? ""} access to ${listedCalendar}.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity={confirmRemove?.role === "owner" ? "high" : "medium"}
        confirmPhrase={confirmRemove?.role === "owner" ? confirmRemove?.scope?.value : undefined}
        confirmLabel="Remove access"
        busy={!!removing}
        changes={[
          { label: "Calendar", after: listedCalendar },
          {
            label: "Removing",
            before: `${confirmRemove?.scope?.value ?? ""} (${confirmRemove?.role ?? ""})`,
            after: "no longer has access",
            emphasis: true,
          },
        ]}
        warnings={
          confirmRemove?.role === "owner" ? (
            <>
              Removing an owner from a secondary calendar with no other owners
              can leave the calendar orphaned. Make sure another owner exists.
            </>
          ) : null
        }
        onConfirm={() => {
          if (confirmRemove?.id) void removeAcl(confirmRemove.id);
        }}
      />
    </>
  );
}
