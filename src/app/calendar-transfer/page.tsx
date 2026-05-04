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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import {
  ArrowRightLeft,
  Loader2,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

export default function CalendarTransfer() {
  const [sourceUser, setSourceUser] = useState("");
  const [targetUser, setTargetUser] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [removeSourceAccess, setRemoveSourceAccess] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "warning";
    text: string;
  } | null>(null);

  const transferCalendar = async () => {
    if (!sourceUser || !targetUser) return;
    setLoading(true);
    setMessage(null);

    const effectiveCalendarId = calendarId || sourceUser;

    try {
      const res = await tfetch("/api/gws/calendar-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUser,
          targetUser,
          calendarId: effectiveCalendarId,
          removeSourceAccess,
          removeConfirmation: removeSourceAccess ? removeConfirmation : undefined,
        }),
      });
      const result = await res.json();

      if (result.success) {
        const note = result.data?.note || "Transfer completed";
        const isPartial = note.includes("was NOT removed") || note.includes("was not removed");
        setMessage({
          type: isPartial ? "warning" : "success",
          text: note,
        });
        setRemoveConfirmation("");
      } else {
        setMessage({
          type: "error",
          text: result.error || "Transfer failed",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  const effectiveCalendarId = calendarId || sourceUser;
  const removeConfirmOk =
    !removeSourceAccess ||
    removeConfirmation.trim().toLowerCase() === effectiveCalendarId.toLowerCase();

  return (
    <>
      <PageHeader
        title="Calendar Transfer"
        description="Transfer calendar ownership from one user to another. Useful for offboarding or role changes."
        badge="Calendar"
      />

      {message && (
        <Alert
          className={`mb-6 ${
            message.type === "error"
              ? "border-red-200 bg-red-50"
              : message.type === "warning"
                ? "border-amber-200 bg-amber-50"
                : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error"
                ? "text-red-800"
                : message.type === "warning"
                  ? "text-amber-800"
                  : "text-emerald-800"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Transfer Calendar Ownership
            </CardTitle>
            <CardDescription>
              Grants owner-level access to the target user. Source user keeps access by default.
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
                  <span className="font-medium">Also remove the source user&apos;s access</span>
                  <span className="block text-xs text-muted-foreground mt-1">
                    Off by default. For primary calendars Google rejects this anyway. For
                    <strong> secondary</strong> calendars, this WILL revoke the source user — they
                    will lose access immediately.
                  </span>
                </span>
              </label>
              {removeSourceAccess && (
                <div className="space-y-2 pl-7">
                  <Label htmlFor="removeConfirm" className="text-xs">
                    Type the calendar ID to confirm removal
                  </Label>
                  <Input
                    id="removeConfirm"
                    value={removeConfirmation}
                    onChange={(e) => setRemoveConfirmation(e.target.value)}
                    placeholder={effectiveCalendarId || "calendar id"}
                    className="font-mono text-sm"
                  />
                </div>
              )}
            </div>

            <Alert className="border-amber-200 bg-amber-50">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 text-sm">
                Granting owner access is reversible (you can remove the ACL
                later). Removing the source user&apos;s access on a secondary
                calendar is harder to undo if the calendar has no other owners.
              </AlertDescription>
            </Alert>

            <Button
              className="w-full"
              size="lg"
              onClick={transferCalendar}
              disabled={!sourceUser || !targetUser || loading || !removeConfirmOk}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-2 h-4 w-4" />
              )}
              Transfer Calendar
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
