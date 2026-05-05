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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import {
  Globe,
  Loader2,
  Search,
  ArrowRight,
  AlertTriangle,
  User,
  Mail,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

interface UserInfo {
  primaryEmail: string;
  name: {
    fullName: string;
    givenName: string;
    familyName: string;
  };
  emails: Array<{
    address: string;
    primary?: boolean;
  }>;
  orgUnitPath: string;
  isAdmin: boolean;
  suspended: boolean;
}

interface DomainInfo {
  domainName: string;
  isPrimary: boolean;
  verified: boolean;
}

export default function DomainChange() {
  const { tenant, id: tenantId } = useCurrentTenant();
  const [email, setEmail] = useState("");
  const [user, setUser] = useState<UserInfo | null>(null);
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [changing, setChanging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    tfetch("/api/admin/domains")
      .then((res) => res.json())
      .then((result) => {
        if (result.success && result.data) {
          setDomains(result.data);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingDomains(false));
  }, []);

  const lookupUser = async () => {
    if (!email) return;
    setLookingUp(true);
    setMessage(null);
    setUser(null);

    try {
      const res = await tfetch(
        `/api/admin/user?email=${encodeURIComponent(email)}`
      );
      const result = await res.json();

      if (result.success && result.data) {
        setUser(result.data);
        const username = result.data.primaryEmail.split("@")[0];
        setNewUsername(username);
      } else {
        setMessage({
          type: "error",
          text: result.error || "User not found",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLookingUp(false);
    }
  };

  const changeDomain = async () => {
    if (!user || !selectedDomain) return;
    setChanging(true);
    setMessage(null);

    try {
      // Pin tenantId to whatever was active when the dialog was confirmed.
      // If the user (or another tab) switches tenants between confirm and
      // request-completion, we still target the tenant they saw in the dialog.
      const res = await tfetch(
        "/api/admin/change-domain",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentEmail: user.primaryEmail,
            newDomain: selectedDomain,
            newUsername: newUsername || undefined,
            // Server-side typed confirmation — must equal currentEmail.
            confirm: user.primaryEmail,
          }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        const verified = result.data?.verifiedNewPrimary;
        setMessage({
          type: "success",
          text: `Done. Google now reports primary email as ${verified}. The old address is kept as an alias.`,
        });
        setUser({
          ...user,
          primaryEmail: verified || result.data?.newEmail || user.primaryEmail,
        });
        setEmail(verified || result.data?.newEmail || user.primaryEmail);
        setConfirmOpen(false);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to change domain",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setChanging(false);
    }
  };

  const currentDomain = user?.primaryEmail.split("@")[1] || "";
  const previewEmail = `${newUsername || user?.primaryEmail.split("@")[0] || "user"}@${selectedDomain || "domain.com"}`;

  const availableDomains = domains.filter(
    (d) => d.domainName !== currentDomain && d.verified
  );

  return (
    <>
      <PageHeader
        title="Change Primary Domain"
        description="Switch a user's primary email address to a different domain in your tenant. The old address is kept as an alias."
        badge="Admin SDK"
      />

      {message && (
        <Alert
          className={`mb-6 ${
            message.type === "error"
              ? "border-red-200 bg-red-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800" : "text-emerald-800"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Change User Domain
            </CardTitle>
            <CardDescription>
              Look up a user, pick the new domain, and swap it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email">User Email</Label>
              <div className="flex gap-2">
                <Input
                  id="email"
                  placeholder="jane@currentdomain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && lookupUser()}
                />
                <Button
                  variant="secondary"
                  onClick={lookupUser}
                  disabled={!email || lookingUp}
                >
                  {lookingUp ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {user && (
              <>
                <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                      <User className="h-5 w-5 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium">{user.name.fullName}</p>
                      <p className="text-sm text-muted-foreground">
                        {user.primaryEmail}
                      </p>
                    </div>
                    <div className="ml-auto flex gap-2">
                      {user.isAdmin && (
                        <Badge
                          variant="outline"
                          className="bg-violet-50 text-violet-700 border-violet-200"
                        >
                          Admin
                        </Badge>
                      )}
                      {user.suspended && (
                        <Badge
                          variant="outline"
                          className="bg-red-50 text-red-700 border-red-200"
                        >
                          Suspended
                        </Badge>
                      )}
                      <Badge variant="outline">{user.orgUnitPath}</Badge>
                    </div>
                  </div>

                  {user.emails && user.emails.length > 1 && (
                    <div className="pt-2">
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">
                        All email addresses
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {user.emails.map((e, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            className={
                              e.primary
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : ""
                            }
                          >
                            <Mail className="h-3 w-3 mr-1" />
                            {e.address}
                            {e.primary && " (primary)"}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>New Domain</Label>
                    {loadingDomains ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading domains...
                      </div>
                    ) : availableDomains.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No other verified domains found in your tenant.
                      </p>
                    ) : (
                      <Select
                        value={selectedDomain}
                        onValueChange={(v) => v && setSelectedDomain(v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a domain..." />
                        </SelectTrigger>
                        <SelectContent>
                          {availableDomains.map((d) => (
                            <SelectItem
                              key={d.domainName}
                              value={d.domainName}
                            >
                              {d.domainName}
                              {d.isPrimary ? " (tenant primary)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="newUsername">
                      Username{" "}
                      <span className="text-muted-foreground font-normal">
                        (optional — change if needed)
                      </span>
                    </Label>
                    <Input
                      id="newUsername"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder={user.primaryEmail.split("@")[0]}
                    />
                  </div>

                  {selectedDomain && (
                    <div className="flex items-center gap-3 p-4 rounded-lg border-2 border-dashed">
                      <span className="text-sm font-medium text-muted-foreground">
                        {user.primaryEmail}
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-semibold">
                        {previewEmail}
                      </span>
                    </div>
                  )}

                  <Alert className="border-amber-200 bg-amber-50">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription className="text-amber-800 text-sm">
                      The user&apos;s old email address will automatically
                      become an alias, so they&apos;ll still receive mail at
                      their previous address. They&apos;ll need to sign in with
                      the new address going forward.{" "}
                      <strong>This action is irreversible from this tool</strong>{" "}
                      — undo through the Google Admin Console only.
                    </AlertDescription>
                  </Alert>

                  <Button
                    className="w-full"
                    size="lg"
                    onClick={() => {
                      setMessage(null);
                      setConfirmOpen(true);
                    }}
                    disabled={!selectedDomain}
                  >
                    <Globe className="mr-2 h-4 w-4" />
                    Review &amp; Change Primary Domain
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Your Domains</CardTitle>
            <CardDescription>
              {loadingDomains
                ? "Loading..."
                : `${domains.length} domain${domains.length !== 1 ? "s" : ""} in your tenant`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingDomains ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : domains.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No domains found. Make sure the Admin SDK is configured in the
                Setup page.
              </div>
            ) : (
              <div className="space-y-2">
                {domains.map((d) => (
                  <div
                    key={d.domainName}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">
                        {d.domainName}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      {d.isPrimary && (
                        <Badge
                          variant="outline"
                          className="bg-blue-50 text-blue-700 border-blue-200 text-xs"
                        >
                          Primary
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className={
                          d.verified
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 text-xs"
                            : "bg-zinc-100 text-zinc-600 border-zinc-200 text-xs"
                        }
                      >
                        {d.verified ? "Verified" : "Unverified"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {user && selectedDomain && (
        <ConfirmActionDialog
          open={confirmOpen}
          onOpenChange={(o) => !changing && setConfirmOpen(o)}
          title="Change primary email"
          summary="This will swap the user's primary email to the new domain. The old address becomes an alias."
          tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
          severity="high"
          confirmPhrase={user.primaryEmail}
          confirmLabel="Change primary email"
          busy={changing}
          changes={[
            {
              label: "Primary email",
              before: user.primaryEmail,
              after: previewEmail,
              emphasis: true,
            },
            {
              label: "Old address",
              before: user.primaryEmail,
              after: `${user.primaryEmail} (kept as alias)`,
            },
            {
              label: "Sign-in",
              after: `User must sign in with ${previewEmail} from now on`,
            },
          ]}
          warnings={
            <>
              Irreversible from this tool. If wrong, undo via the Google Admin
              Console. Make sure the user is not the admin this toolbox is
              impersonating.
            </>
          }
          onConfirm={changeDomain}
        />
      )}
    </>
  );
}
