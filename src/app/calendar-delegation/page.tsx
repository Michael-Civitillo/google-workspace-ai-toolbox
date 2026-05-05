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
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmAddOpen, setConfirmAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AclRule | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const listAcl = async () => {
    if (!calendarId) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await tfetch(
        `/api/gws/calendar-delegation?calendarId=${encodeURIComponent(calendarId)}`
      );
      const result = await res.json();

      if (result.success && result.data?.items) {
        setAclRules(result.data.items);
      } else if (result.success) {
        setAclRules([]);
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
          body: JSON.stringify({ calendarId, delegateEmail, role }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Granted ${role} access to ${delegateEmail}`,
        });
        setDelegateEmail("");
        setConfirmAddOpen(false);
        await listAcl();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to add access" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setAdding(false);
    }
  };

  const removeAcl = async (ruleId: string) => {
    setRemoving(ruleId);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/calendar-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId, ruleId }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setMessage({ type: "success", text: "Access removed successfully" });
        setConfirmRemove(null);
        await listAcl();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to remove access" });
      }
    } catch {
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
                  onClick={listAcl}
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
        summary={`Revoke ${confirmRemove?.scope?.value ?? ""}'s ${confirmRemove?.role ?? ""} access to ${calendarId}.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity={confirmRemove?.role === "owner" ? "high" : "medium"}
        confirmPhrase={confirmRemove?.role === "owner" ? confirmRemove?.scope?.value : undefined}
        confirmLabel="Remove access"
        busy={!!removing}
        changes={[
          { label: "Calendar", after: calendarId },
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
