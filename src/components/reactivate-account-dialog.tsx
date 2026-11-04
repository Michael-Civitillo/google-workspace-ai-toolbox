"use client";

import { useState } from "react";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";

/**
 * Typed-confirmation dialog that re-enables a suspended account.
 *
 * Offered wherever Google refused an action because an account is
 * suspended (adding or removing a mailbox delegate, say). `thenLabel` tells
 * the operator what happens right after — the caller retries its action in
 * `onReactivated`. Failures stay inside this dialog.
 */
export function ReactivateAccountDialog({
  user,
  onOpenChange,
  thenLabel,
  onReactivated,
}: {
  /** The suspended account; null keeps the dialog closed. */
  user: string | null;
  onOpenChange: (open: boolean) => void;
  /** What the caller will do once the account is active, e.g. "Add sam@… as a delegate". */
  thenLabel: string;
  onReactivated: (user: string) => void | Promise<void>;
}) {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reactivate = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tfetch(
        "/api/admin/user/unsuspend",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, confirm: user }),
        },
        tenantId
      );
      const result = await res.json();
      if (result.success) {
        await onReactivated(user);
      } else {
        setError(result.error || "Failed to re-enable the account");
      }
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmActionDialog
      open={!!user}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title="Re-enable account"
      summary={`${user ?? ""} is suspended. Re-enable it so the mailbox can be changed.`}
      tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
      severity="high"
      confirmPhrase={user ?? ""}
      confirmLabel="Re-enable account"
      busy={busy}
      changes={[
        { label: "Account", before: "suspended", after: "active", emphasis: true },
        { label: "Then", after: thenLabel },
      ]}
      warnings={
        <>
          The person will be able to sign in again, and anything the suspension
          stopped — mail delivery, device sync, app access — resumes
          immediately. If this account was suspended as part of an offboarding,
          suspend it again when you are done.
        </>
      }
      error={error}
      onConfirm={reactivate}
    />
  );
}
