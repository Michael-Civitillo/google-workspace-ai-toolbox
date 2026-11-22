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
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import { StatusBadge } from "@/components/status-badge";
import { Mail, Loader2, Trash2, UserPlus, Search, UserCheck } from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ReactivateAccountDialog } from "@/components/reactivate-account-dialog";

interface Delegate {
  delegateEmail: string;
  verificationStatus: string;
}

/**
 * A failed add/remove, shown inside the dialog that triggered it. When the
 * server says the failure is a suspended account, `suspendedUser` lets the
 * dialog offer to re-enable it and retry.
 */
interface DialogError {
  message: string;
  suspendedUser?: string;
}

function dialogErrorFrom(result: {
  error?: string;
  suspendedUser?: string;
  code?: string;
}, fallback: string): DialogError {
  return {
    message: result.error || fallback,
    suspendedUser:
      typeof result.suspendedUser === "string" && result.suspendedUser
        ? result.suspendedUser
        : undefined,
  };
}

/** An add or a removal as it stood when its dialog opened. */
interface PendingChange {
  owner: string;
  delegate: string;
}

export default function EmailDelegation() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [user, setUser] = useState("");
  const [delegate, setDelegate] = useState("");
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  // The mailbox owner the currently-displayed list was actually fetched for.
  // Remove actions target THIS, not the live input, so editing the owner field
  // after searching can't send a delete to the wrong mailbox.
  const [listedOwner, setListedOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // What each dialog acts on, pinned when it opens: a lookup that finishes
  // while a dialog is open must not change the mailbox its Confirm targets.
  const [pendingAdd, setPendingAdd] = useState<PendingChange | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PendingChange | null>(null);
  const [addError, setAddError] = useState<DialogError | null>(null);
  const [removeError, setRemoveError] = useState<DialogError | null>(null);
  // Which suspended account the re-enable dialog is for, and what to retry
  // once it is active again.
  const [reactivate, setReactivate] = useState<{
    user: string;
    then: "add" | "remove";
  } | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Live tenant id for staleness checks inside async closures.
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  // Only the latest list request may fill the panel: a slow lookup of one
  // mailbox must not land after a newer one, or after a tenant switch.
  const listSeq = useRef(0);

  const listDelegates = async (ownerOverride?: string) => {
    // ownerOverride lets refresh-after-change re-list the owner the change
    // ran against — the live input may have been retyped since.
    const owner = (ownerOverride ?? user).trim();
    if (!owner) return;
    const seq = ++listSeq.current;
    setLoading(true);
    setMessage(null);
    // Pin the tenant this list belongs to, and discard the response if the
    // tenant changed while it was in flight — otherwise a stale tenant-A list
    // repopulates the UI under tenant B and defeats the listedOwner guard.
    const pinnedTenantId = tenantId;
    const isLatest = () =>
      listSeq.current === seq && tenantIdRef.current === pinnedTenantId;

    try {
      const res = await tfetch(
        `/api/gws/email-delegation?user=${encodeURIComponent(owner)}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (!isLatest()) return;

      if (result.success && result.data?.delegates) {
        setDelegates(result.data.delegates);
        setListedOwner(owner);
      } else if (result.success) {
        setDelegates([]);
        setListedOwner(owner);
        setMessage({ type: "success", text: "No delegates found for this user." });
      } else {
        setMessage({ type: "error", text: result.error || "Failed to list delegates" });
      }
    } catch {
      if (!isLatest()) return;
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      if (listSeq.current === seq) setLoading(false);
    }
  };

  // Clear a stale list when the tenant changes — a list fetched for tenant A
  // must never drive removals against tenant B — and close the dialogs: one
  // opened under tenant A must not confirm a change under tenant B.
  useEffect(() => {
    listSeq.current++;
    setLoading(false);
    setDelegates([]);
    setListedOwner("");
    setPendingAdd(null);
    setPendingRemove(null);
    setAddError(null);
    setRemoveError(null);
    setReactivate(null);
  }, [tenantId]);

  /**
   * Add the delegate. Failures stay in the add dialog (`addError`) so the
   * operator sees them where they are looking; only success closes it.
   * `reactivated` names an account that was just re-enabled for this add,
   * so the success message can say so.
   */
  const addDelegate = async (p: PendingChange, reactivated?: string) => {
    setAdding(true);
    setMessage(null);
    setAddError(null);
    const pinnedTenantId = tenantId;

    try {
      const res = await tfetch(
        "/api/gws/email-delegation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: p.owner, delegate: p.delegate }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setDelegate("");
        setPendingAdd(null);
        // Refresh first, then set the message: listDelegates clears messages in
        // its synchronous prologue, so setting it earlier batches a set+clear
        // into one render and the success feedback is never painted. The
        // mailbox the delegate was added to, not whatever the field says now.
        await listDelegates(p.owner);
        if (tenantIdRef.current !== pinnedTenantId) return;
        setMessage({
          type: "success",
          text: reactivated
            ? `Re-enabled ${reactivated} and added ${p.delegate} as a delegate for ${p.owner}`
            : `Successfully added ${p.delegate} as a delegate for ${p.owner}`,
        });
      } else {
        setAddError(dialogErrorFrom(result, "Failed to add delegate"));
      }
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      setAddError({ message: "Failed to connect to the API" });
    } finally {
      setAdding(false);
    }
  };

  const removeDelegate = async (p: PendingChange, reactivated?: string) => {
    setRemoving(p.delegate);
    setMessage(null);
    setRemoveError(null);
    const pinnedTenantId = tenantId;

    try {
      const res = await tfetch(
        "/api/gws/email-delegation",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // The owner and delegate the dialog was opened for — never the
          // live input or a list that loaded since.
          body: JSON.stringify({ user: p.owner, delegate: p.delegate }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setPendingRemove(null);
        // Refresh the owner the removal actually ran against. Refresh before
        // messaging — listDelegates' prologue clears messages, which would
        // erase this success text in the same batched render.
        await listDelegates(p.owner);
        if (tenantIdRef.current !== pinnedTenantId) return;
        setMessage({
          type: "success",
          text: reactivated
            ? `Re-enabled ${reactivated} and removed ${p.delegate} as a delegate from ${p.owner}`
            : `Successfully removed ${p.delegate} as a delegate from ${p.owner}`,
        });
      } else {
        setRemoveError(dialogErrorFrom(result, "Failed to remove delegate"));
      }
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      setRemoveError({ message: "Failed to connect to the API" });
    } finally {
      setRemoving(null);
    }
  };

  const reenableButton = (err: DialogError | null, then: "add" | "remove") =>
    err?.suspendedUser ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setReactivate({ user: err.suspendedUser as string, then })}
      >
        <UserCheck className="h-3.5 w-3.5" />
        Re-enable {err.suspendedUser}…
      </Button>
    ) : null;

  return (
    <>
      <PageHeader
        title="Email Delegation"
        description="Grant mailbox access to another user. Delegates can read, send, and delete messages on behalf of the mailbox owner."
        badge="Gmail"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Lookup & Add */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
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
                  onClick={() => listDelegates()}
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
                    const owner = user.trim();
                    const added = delegate.trim();
                    if (!owner || !added) return;
                    setMessage(null);
                    setAddError(null);
                    setPendingAdd({ owner, delegate: added });
                  }}
                  disabled={!user.trim() || !delegate.trim() || adding}
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
            <CardTitle>Current Delegates</CardTitle>
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
                      <div className="h-8 w-8 rounded-full bg-info/10 flex items-center justify-center">
                        <Mail className="h-4 w-4 text-info" />
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
                        if (!listedOwner) return;
                        setMessage(null);
                        setRemoveError(null);
                        setPendingRemove({
                          owner: listedOwner,
                          delegate: d.delegateEmail,
                        });
                      }}
                      disabled={removing === d.delegateEmail}
                    >
                      {removing === d.delegateEmail ? (
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

      <ConfirmActionDialog
        open={!!pendingAdd}
        onOpenChange={(o) => {
          if (adding || o) return;
          setAddError(null);
          setPendingAdd(null);
        }}
        title="Add mailbox delegate"
        summary={`Grant ${pendingAdd?.delegate ?? "—"} delegate access to ${pendingAdd?.owner ?? "—"}'s mailbox.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="medium"
        confirmLabel={addError ? "Try again" : "Add delegate"}
        busy={adding}
        changes={[
          { label: "Mailbox owner", after: pendingAdd?.owner ?? "" },
          { label: "New delegate", after: pendingAdd?.delegate ?? "" },
          {
            label: "Delegate can",
            after: "Read, send, and delete messages on behalf of the owner",
            emphasis: true,
          },
          {
            label: "When access starts",
            after: "Usually right away, or within a few minutes",
          },
        ]}
        error={addError?.message}
        errorActions={reenableButton(addError, "add")}
        onConfirm={() => {
          if (pendingAdd) void addDelegate(pendingAdd);
        }}
      />

      <ConfirmActionDialog
        open={!!pendingRemove}
        onOpenChange={(o) => {
          if (removing || o) return;
          setRemoveError(null);
          setPendingRemove(null);
        }}
        title="Remove mailbox delegate"
        summary={`${pendingRemove?.delegate ?? ""} will lose access to ${pendingRemove?.owner ?? ""}'s mailbox.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="medium"
        confirmLabel={removeError ? "Try again" : "Remove delegate"}
        busy={!!removing}
        changes={[
          { label: "Mailbox owner", after: pendingRemove?.owner ?? "" },
          {
            label: "Delegate to remove",
            before: pendingRemove?.delegate ?? "",
            after: "no longer has access",
            emphasis: true,
          },
        ]}
        error={removeError?.message}
        errorActions={reenableButton(removeError, "remove")}
        onConfirm={() => {
          if (pendingRemove) void removeDelegate(pendingRemove);
        }}
      />

      <ReactivateAccountDialog
        user={reactivate?.user ?? null}
        onOpenChange={(o) => {
          if (!o) setReactivate(null);
        }}
        thenLabel={
          reactivate?.then === "remove"
            ? `Remove ${pendingRemove?.delegate ?? ""} as a delegate from ${pendingRemove?.owner ?? ""}`
            : `Add ${pendingAdd?.delegate ?? ""} as a delegate for ${pendingAdd?.owner ?? ""}`
        }
        onReactivated={async (reactivated) => {
          const then = reactivate?.then;
          setReactivate(null);
          if (then === "remove") {
            if (pendingRemove) await removeDelegate(pendingRemove, reactivated);
          } else if (pendingAdd) {
            await addDelegate(pendingAdd, reactivated);
          }
        }}
      />
    </>
  );
}
