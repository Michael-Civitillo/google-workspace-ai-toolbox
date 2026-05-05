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
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Mail, Loader2, Trash2, UserPlus, Search } from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

interface Delegate {
  delegateEmail: string;
  verificationStatus: string;
}

export default function EmailDelegation() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [user, setUser] = useState("");
  const [delegate, setDelegate] = useState("");
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmAddOpen, setConfirmAddOpen] = useState(false);
  const [confirmRemoveTarget, setConfirmRemoveTarget] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const listDelegates = async () => {
    if (!user) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await tfetch(
        `/api/gws/email-delegation?user=${encodeURIComponent(user)}`
      );
      const result = await res.json();

      if (result.success && result.data?.delegates) {
        setDelegates(result.data.delegates);
      } else if (result.success) {
        setDelegates([]);
        setMessage({ type: "success", text: "No delegates found for this user." });
      } else {
        setMessage({ type: "error", text: result.error || "Failed to list delegates" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  const addDelegate = async () => {
    if (!user || !delegate) return;
    setAdding(true);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/email-delegation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, delegate }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Successfully added ${delegate} as a delegate for ${user}`,
        });
        setDelegate("");
        setConfirmAddOpen(false);
        await listDelegates();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to add delegate" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setAdding(false);
    }
  };

  const removeDelegate = async (delegateEmail: string) => {
    setRemoving(delegateEmail);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/email-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, delegate: delegateEmail }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Successfully removed ${delegateEmail} as a delegate`,
        });
        setConfirmRemoveTarget(null);
        await listDelegates();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to remove delegate" });
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
        title="Email Delegation"
        description="Grant mailbox access to another user. Delegates can read, send, and delete messages on behalf of the mailbox owner."
        badge="Gmail"
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
        {/* Lookup & Add */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Manage Delegates
            </CardTitle>
            <CardDescription>
              Look up existing delegates or add a new one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user">Mailbox Owner</Label>
              <div className="flex gap-2">
                <Input
                  id="user"
                  placeholder="user@yourdomain.com"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
                <Button
                  variant="secondary"
                  onClick={listDelegates}
                  disabled={!user || loading}
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
              <Label htmlFor="delegate">Add Delegate</Label>
              <div className="flex gap-2">
                <Input
                  id="delegate"
                  placeholder="delegate@yourdomain.com"
                  value={delegate}
                  onChange={(e) => setDelegate(e.target.value)}
                />
                <Button
                  onClick={() => {
                    setMessage(null);
                    setConfirmAddOpen(true);
                  }}
                  disabled={!user || !delegate || adding}
                >
                  {adding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The delegate will be able to read, send, and delete messages.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Current Delegates */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Current Delegates</CardTitle>
            <CardDescription>
              {delegates.length > 0
                ? `${delegates.length} delegate${delegates.length > 1 ? "s" : ""} found`
                : "Search for a user to see their delegates"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {delegates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No delegates to display
              </div>
            ) : (
              <div className="space-y-3">
                {delegates.map((d) => (
                  <div
                    key={d.delegateEmail}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center">
                        <Mail className="h-4 w-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {d.delegateEmail}
                        </p>
                        <StatusBadge
                          status={
                            d.verificationStatus === "accepted"
                              ? "success"
                              : "pending"
                          }
                          label={d.verificationStatus}
                        />
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMessage(null);
                        setConfirmRemoveTarget(d.delegateEmail);
                      }}
                      disabled={removing === d.delegateEmail}
                    >
                      {removing === d.delegateEmail ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-red-500" />
                      )}
                    </Button>
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
        title="Add mailbox delegate"
        summary={`Grant ${delegate || "—"} delegate access to ${user || "—"}'s mailbox.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="medium"
        confirmLabel="Add delegate"
        busy={adding}
        changes={[
          { label: "Mailbox owner", after: user },
          { label: "New delegate", after: delegate },
          {
            label: "Delegate can",
            after: "Read, send, and delete messages on behalf of the owner",
            emphasis: true,
          },
          {
            label: "Verification",
            after: "Delegate must accept an email invitation before access activates",
          },
        ]}
        onConfirm={addDelegate}
      />

      <ConfirmActionDialog
        open={!!confirmRemoveTarget}
        onOpenChange={(o) => !removing && !o && setConfirmRemoveTarget(null)}
        title="Remove mailbox delegate"
        summary={`${confirmRemoveTarget ?? ""} will lose access to ${user}'s mailbox.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="medium"
        confirmLabel="Remove delegate"
        busy={!!removing}
        changes={[
          { label: "Mailbox owner", after: user },
          {
            label: "Delegate to remove",
            before: confirmRemoveTarget ?? "",
            after: "no longer has access",
            emphasis: true,
          },
        ]}
        onConfirm={() => {
          if (confirmRemoveTarget) void removeDelegate(confirmRemoveTarget);
        }}
      />
    </>
  );
}
