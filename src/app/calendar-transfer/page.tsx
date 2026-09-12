"use client";

import { useEffect, useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import {
  ArrowRightLeft,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog, type DiffRow } from "@/components/confirm-action-dialog";

export default function CalendarTransfer() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [sourceUser, setSourceUser] = useState("");
  const [targetUser, setTargetUser] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [removeSourceAccess, setRemoveSourceAccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Tenant's verified domains, for detecting an external target. null = not yet
  // loaded / lookup failed → treat targets as external (fail-safe), matching the
  // server's fail-closed guard so we always send the required confirmExternal.
  const [verifiedDomains, setVerifiedDomains] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "warning";
    text: string;
  } | null>(null);

  useEffect(() => {
    // Cancelled flag: on a tenant switch the previous tenant's in-flight
    // response must not land after (and overwrite) the new tenant's domains —
    // a stale set could classify an external target as internal and set the
    // dialog severity wrong. The tenantId pin keeps the request itself
    // consistent with the tenant this effect run is for.
    let cancelled = false;
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

  const effectiveCalendarId = calendarId || sourceUser;
  const targetDomain = targetUser.includes("@")
    ? targetUser.slice(targetUser.indexOf("@") + 1).toLowerCase()
    : "";
  // External if we know the verified set and the domain isn't in it, OR if we
  // couldn't load the set at all (fail-safe — the server enforces this too).
  const targetIsExternal =
    !!targetUser &&
    (verifiedDomains === null || !verifiedDomains.includes(targetDomain));

  const transferCalendar = async () => {
    if (!sourceUser || !targetUser) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/calendar-transfer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceUser,
            targetUser,
            calendarId: effectiveCalendarId,
            removeSourceAccess,
            // Server requires confirmation phrase to equal calendarId when
            // remove is requested. Click-through-the-dialog already gates the
            // intent; we send it server-side too for defence in depth.
            removeConfirmation: removeSourceAccess
              ? effectiveCalendarId
              : undefined,
            // Granting ownership to a target outside the tenant's verified
            // domains requires explicit confirmation server-side.
            confirmExternal: targetIsExternal ? targetUser : undefined,
          }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        const note = result.data?.note || "Transfer completed";
        // Partial only when we asked for source-access removal and it didn't
        // happen. Matching on the note's prose also flagged every successful
        // default (keep-access) transfer as a warning, making real partial
        // failures indistinguishable from normal success.
        const isPartial = removeSourceAccess && result.data?.removed !== true;
        setMessage({
          type: isPartial ? "warning" : "success",
          text: note,
        });
        setConfirmOpen(false);
      } else {
        // Close the dialog so the page-level error banner isn't hidden
        // behind the modal overlay.
        setConfirmOpen(false);
        setMessage({
          type: "error",
          text: result.error || "Transfer failed",
        });
      }
    } catch {
      setConfirmOpen(false);
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  const changes: DiffRow[] = [
    {
      label: "Calendar",
      after: effectiveCalendarId,
    },
    {
      label: "Owner role",
      after: `${targetUser} gains owner access`,
      emphasis: true,
    },
  ];
  if (removeSourceAccess) {
    changes.push({
      label: "Source user access",
      before: `${sourceUser} has access`,
      after: `${sourceUser} access REMOVED (if Google permits — primary calendars cannot have their owner removed)`,
      emphasis: true,
    });
  } else {
    changes.push({
      label: "Source user access",
      before: `${sourceUser} has access`,
      after: `${sourceUser} keeps current access`,
    });
  }

  return (
    <>
      <PageHeader
        title="Calendar Transfer"
        description="Transfer calendar ownership from one user to another. Useful for offboarding or role changes."
        badge="Calendar"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Transfer Calendar Ownership
            </CardTitle>
            <CardDescription>
              Grants owner-level access to the target user. Source user keeps
              access by default.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-end gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="source">Source User</Label>
                <Input
                  id="source"
                  placeholder="departing@yourdomain.com"
                  value={sourceUser}
                  onChange={(e) => setSourceUser(e.target.value)}
                />
              </div>
              <div className="pb-2">
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 space-y-2">
                <Label htmlFor="target">Target User</Label>
                <Input
                  id="target"
                  placeholder="receiving@yourdomain.com"
                  value={targetUser}
                  onChange={(e) => setTargetUser(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="calendarId">
                Calendar ID{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                id="calendarId"
                placeholder="Defaults to the source user's primary calendar"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to transfer the primary calendar. For secondary
                calendars, enter the calendar ID.
              </p>
            </div>

            <div className="rounded-lg border p-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={removeSourceAccess}
                  onChange={(e) => setRemoveSourceAccess(e.target.checked)}
                  className="mt-1"
                />
                <span className="text-sm">
                  <span className="font-medium">
                    Also remove the source user&apos;s access
                  </span>
                  <span className="block text-xs text-muted-foreground mt-1">
                    Off by default. For primary calendars Google rejects this
                    anyway. For <strong>secondary</strong> calendars, this WILL
                    revoke the source user — they will lose access immediately.
                  </span>
                </span>
              </label>
            </div>

            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription>
                Granting owner access is reversible. Removing the source
                user&apos;s access on a secondary calendar is much harder to
                undo if the calendar has no other owners.
              </AlertDescription>
            </Alert>

            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                setMessage(null);
                setConfirmOpen(true);
              }}
              disabled={!sourceUser || !targetUser}
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Review &amp; Transfer Calendar
            </Button>
          </CardContent>
        </Card>
      </div>

      {sourceUser && targetUser && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => !loading && setConfirmOpen(o)}
          title="Transfer calendar ownership"
          summary={
            removeSourceAccess
              ? `Grant ${targetUser} owner access AND remove ${sourceUser}'s access.`
              : `Grant ${targetUser} owner access. ${sourceUser} keeps existing access.`
          }
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity={removeSourceAccess || targetIsExternal ? "high" : "medium"}
          confirmPhrase={
            targetIsExternal
              ? targetUser
              : removeSourceAccess
                ? effectiveCalendarId
                : undefined
          }
          confirmLabel={removeSourceAccess ? "Transfer and revoke" : "Grant ownership"}
          busy={loading}
          changes={changes}
          warnings={
            targetIsExternal ? (
              <>
                <strong>{targetUser}</strong> is outside this tenant&apos;s
                verified domains — you are granting calendar ownership to an
                external account. Type the target address to confirm.
              </>
            ) : removeSourceAccess ? (
              <>
                <strong>Removing source access</strong> on a secondary calendar
                cannot be self-recovered if the calendar has no other owners.
                Make sure {targetUser} (or another admin) can re-share if
                needed.
              </>
            ) : null
          }
          onConfirm={transferCalendar}
        />
      )}
    </>
  );
}
