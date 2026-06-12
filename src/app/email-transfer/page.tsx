"use client";

import { useState, useEffect } from "react";
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
import { PageHeader } from "@/components/page-header";
import {
  ArrowRightLeft,
  ArrowRight,
  Info,
  AlertTriangle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

const ACTION_LABELS: Record<string, string> = {
  keep: "Keep in inbox",
  archive: "Archive",
  trash: "Move to trash",
  markRead: "Mark as read",
};

export default function EmailTransfer() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [sourceUser, setSourceUser] = useState("");
  const [targetUser, setTargetUser] = useState("");
  const [action, setAction] = useState("keep");
  const [verifiedDomains, setVerifiedDomains] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    tfetch("/api/admin/domains", {}, tenantId)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success && Array.isArray(data.data)) {
          setVerifiedDomains(
            data.data
              .filter(
                (d: { verified: boolean; domainName: string }) => d.verified
              )
              .map((d: { domainName: string }) => d.domainName.toLowerCase())
          );
        } else {
          setVerifiedDomains([]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const targetDomain = targetUser.includes("@")
    ? targetUser.split("@")[1].toLowerCase()
    : "";
  const isExternal =
    !!targetDomain &&
    verifiedDomains.length > 0 &&
    !verifiedDomains.includes(targetDomain);

  const transferEmail = async () => {
    if (!sourceUser || !targetUser) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await tfetch(
        "/api/gws/email-transfer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceUser,
            targetUser,
            action,
            confirmExternal: isExternal ? targetUser : undefined,
          }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Email forwarding set up from ${sourceUser} to ${targetUser}. New emails will be forwarded automatically.`,
        });
        setConfirmOpen(false);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to set up email transfer",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Email Transfer"
        description="Set up automatic email forwarding from one user to another. Ideal for offboarding or role transitions."
        badge="Gmail"
      />

      {message && (
        <Alert
          className={`mb-6 ${
            message.type === "error"
              ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40"
              : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
          }`}
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

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Set Up Email Forwarding
            </CardTitle>
            <CardDescription>
              Creates a forwarding address and enables automatic forwarding for
              all incoming mail.
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
              <Label>After Forwarding</Label>
              <Select value={action} onValueChange={(v) => v && setAction(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">
                    Keep in inbox (recommended)
                  </SelectItem>
                  <SelectItem value="archive">Archive original</SelectItem>
                  <SelectItem value="trash">Move to trash</SelectItem>
                  <SelectItem value="markRead">Mark as read</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                What happens to the original email in the source mailbox after
                it&apos;s forwarded.
              </p>
            </div>

            {isExternal && (
              <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 dark:text-red-300 text-sm">
                  <strong>{targetDomain}</strong> is NOT one of your tenant&apos;s
                  verified domains. Forwarding email outside your tenant can
                  leak data.
                </AlertDescription>
              </Alert>
            )}

            <Alert className="border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/40">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 dark:text-blue-300 text-sm">
                This sets up forwarding for <strong>new</strong> incoming email
                only. Existing emails are not transferred. For existing mail
                migration, use Google&apos;s Data Migration Service in the Admin
                Console.
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
              Review &amp; Set Up Forwarding
            </Button>
          </CardContent>
        </Card>
      </div>

      {sourceUser && targetUser && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => !loading && setConfirmOpen(o)}
          title="Enable email forwarding"
          summary={`All incoming mail to ${sourceUser} will be auto-forwarded to ${targetUser}.`}
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity={isExternal ? "high" : "medium"}
          confirmPhrase={isExternal ? targetUser : undefined}
          confirmLabel={isExternal ? "Forward externally" : "Enable forwarding"}
          busy={loading}
          changes={[
            { label: "Source mailbox", after: sourceUser },
            {
              label: "Forward to",
              after: targetUser,
              emphasis: isExternal,
            },
            {
              label: "After forwarding",
              after: ACTION_LABELS[action] ?? action,
            },
            {
              label: "Scope",
              after: "Applies to NEW incoming mail only — existing mail is not moved",
            },
          ]}
          warnings={
            isExternal ? (
              <>
                <strong>{targetDomain}</strong> is OUTSIDE your verified tenant
                domains. Every future email to {sourceUser} will be sent to an
                external address. Confirm this is intentional and authorised.
              </>
            ) : null
          }
          onConfirm={transferEmail}
        />
      )}
    </>
  );
}
