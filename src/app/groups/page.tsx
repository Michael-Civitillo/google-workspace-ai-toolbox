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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { FeedbackAlert } from "@/components/feedback-alert";
import {
  Users,
  Loader2,
  Search,
  Trash2,
  UserPlus,
  ChevronRight,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

interface GroupSummary {
  id: string;
  email: string;
  name: string;
  description: string;
  directMembersCount: string;
}

interface GroupMember {
  id: string;
  email: string;
  role: string;
  type: string;
  status: string;
}

const ROLES = ["MEMBER", "MANAGER", "OWNER"] as const;

/** An add as it stood when its confirmation opened. */
interface PendingAdd {
  group: string;
  member: string;
  role: string;
  /** Outside the tenant's verified domains (or the domains are unknown). */
  external: boolean;
}

export default function Groups() {
  const { tenant, id: tenantId } = useCurrentTenant();

  // Browse tab
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsPageToken, setGroupsPageToken] = useState<string | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsSearched, setGroupsSearched] = useState(false);
  // The group the members panel is showing — pinned like listedOwner so a
  // later selection change can't retarget an in-flight mutation.
  const [selectedGroup, setSelectedGroup] = useState("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersPageToken, setMembersPageToken] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [newMember, setNewMember] = useState("");
  const [newRole, setNewRole] = useState("MEMBER");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // The group, member and role the add dialog acts on, pinned when it opens:
  // a member list that finishes loading for another group while the dialog
  // is open must not change where Confirm adds the member.
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmRemoveTarget, setConfirmRemoveTarget] = useState<{
    group: string;
    member: string;
  } | null>(null);
  // Tenant's verified domains (aliases included), for flagging an outside
  // member. null = not loaded / lookup failed → treated as outside, the same
  // fail-safe the server's gate uses.
  const [verifiedDomains, setVerifiedDomains] = useState<string[] | null>(null);

  // Memberships tab
  const [memberUser, setMemberUser] = useState("");
  const [listedMemberUser, setListedMemberUser] = useState("");
  const [userGroups, setUserGroups] = useState<GroupSummary[]>([]);
  const [userGroupsPageToken, setUserGroupsPageToken] = useState<string | null>(
    null
  );
  const [userGroupsLoading, setUserGroupsLoading] = useState(false);
  const [userGroupsSearched, setUserGroupsSearched] = useState(false);

  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const selectedGroupRef = useRef(selectedGroup);
  selectedGroupRef.current = selectedGroup;

  // Per-list request sequence numbers. A response only applies if it is still
  // the LATEST request for that list — otherwise a slow first page can
  // overwrite a newer one, or a stale "load more" for group A can append A's
  // members onto group B's freshly-loaded list.
  const groupsSeqRef = useRef(0);
  const membersSeqRef = useRef(0);
  const userGroupsSeqRef = useRef(0);
  // The query the current groups listing was fetched with. "Load more" must
  // reuse it — pairing the stored pageToken with a since-edited input would
  // hand Google a token from a different result set.
  const [groupsQuery, setGroupsQuery] = useState("");

  // Lists fetched for tenant A must never drive actions against tenant B,
  // and a dialog opened under A must not confirm a change under B.
  useEffect(() => {
    let cancelled = false;
    setGroups([]);
    setGroupsPageToken(null);
    setGroupsSearched(false);
    setSelectedGroup("");
    setMembers([]);
    setMembersPageToken(null);
    setUserGroups([]);
    setUserGroupsPageToken(null);
    setUserGroupsSearched(false);
    setListedMemberUser("");
    setPendingAdd(null);
    setAddError(null);
    setConfirmRemoveTarget(null);
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

  const loadGroups = async (append: boolean) => {
    setGroupsLoading(true);
    setMessage(null);
    const pinnedTenantId = tenantId;
    const seq = ++groupsSeqRef.current;
    const effectiveQuery = append ? groupsQuery : query.trim();
    try {
      const params = new URLSearchParams();
      if (effectiveQuery) params.set("query", effectiveQuery);
      params.set("pageSize", "200");
      if (append && groupsPageToken) params.set("pageToken", groupsPageToken);
      const res = await tfetch(
        `/api/admin/groups?${params.toString()}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (groupsSeqRef.current !== seq) return;

      if (result.success) {
        if (!append) setGroupsQuery(effectiveQuery);
        setGroups((prev) =>
          append ? [...prev, ...result.data.groups] : result.data.groups
        );
        setGroupsPageToken(result.data.nextPageToken);
        setGroupsSearched(true);
        if (!append) {
          setSelectedGroup("");
          setMembers([]);
          setMembersPageToken(null);
        }
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to list groups",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setGroupsLoading(false);
    }
  };

  const loadMembers = async (group: string, append: boolean) => {
    setMembersLoading(true);
    setMessage(null);
    const pinnedTenantId = tenantId;
    const seq = ++membersSeqRef.current;
    try {
      const params = new URLSearchParams({ group, pageSize: "200" });
      if (append && membersPageToken) params.set("pageToken", membersPageToken);
      const res = await tfetch(
        `/api/admin/groups/members?${params.toString()}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (membersSeqRef.current !== seq) return;

      if (result.success) {
        setSelectedGroup(group);
        setMembers((prev) =>
          append ? [...prev, ...result.data.members] : result.data.members
        );
        setMembersPageToken(result.data.nextPageToken);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to list group members",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setMembersLoading(false);
    }
  };

  const openAdd = () => {
    const member = newMember.trim();
    if (!selectedGroup || !member) return;
    setMessage(null);
    setAddError(null);
    setPendingAdd({
      group: selectedGroup,
      member,
      role: newRole,
      external: isExternal(member),
    });
  };

  const addMember = async (p: PendingAdd) => {
    setAdding(true);
    setMessage(null);
    setAddError(null);
    const pinnedTenantId = tenantId;
    try {
      const res = await tfetch(
        "/api/admin/groups/members",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            group: p.group,
            member: p.member,
            role: p.role,
            // Both are the member's address as the operator typed it in the
            // dialog, which asks for it whenever either applies: the server
            // wants it for an Owner, and for anyone outside the tenant.
            confirm: p.role === "OWNER" ? p.member : undefined,
            confirmExternal: p.external ? p.member : undefined,
          }),
        },
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;

      if (result.success) {
        setNewMember("");
        setPendingAdd(null);
        // Refresh first, then set the message — loadMembers clears messages in
        // its prologue, which would erase this text in the same render batch.
        // Only if that group is still the one on screen.
        if (selectedGroupRef.current === p.group) {
          await loadMembers(p.group, false);
        }
        if (tenantIdRef.current !== pinnedTenantId) return;
        setMessage({
          type: "success",
          text: result.data?.alreadyMember
            ? result.data?.roleChanged
              ? `${p.member} was already a member of ${p.group} — role changed from ${result.data?.previousRole ?? "?"} to ${p.role}`
              : `${p.member} was already a member of ${p.group}`
            : `Added ${p.member} to ${p.group} as ${p.role}`,
        });
      } else {
        // Stay in the dialog: that is where the operator is looking.
        setAddError(result.error || "Failed to add group member");
      }
    } catch {
      if (tenantIdRef.current !== pinnedTenantId) return;
      setAddError("Failed to connect to the API");
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (group: string, member: string) => {
    setRemoving(`${group}:${member}`);
    setMessage(null);
    try {
      const res = await tfetch(
        "/api/admin/groups/members",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // The route requires a typed confirmation of the member being
          // removed; the dialog above is that confirmation for the operator.
          body: JSON.stringify({ group, member, confirm: member }),
        },
        tenantId
      );
      const result = await res.json();

      if (result.success) {
        setConfirmRemoveTarget(null);
        // Refresh whichever list the removal affects before messaging.
        if (group === selectedGroup) {
          await loadMembers(group, false);
        }
        if (listedMemberUser && member === listedMemberUser) {
          await loadUserGroups(false, listedMemberUser);
        }
        setMessage({
          type: "success",
          text: result.data?.removed
            ? `Removed ${member} from ${group}`
            : `${member} was not a member of ${group}`,
        });
      } else {
        setConfirmRemoveTarget(null);
        setMessage({
          type: "error",
          text: result.error || "Failed to remove group member",
        });
      }
    } catch {
      setConfirmRemoveTarget(null);
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setRemoving(null);
    }
  };

  const loadUserGroups = async (append: boolean, targetOverride?: string) => {
    // targetOverride lets refresh-after-removal re-list the user whose panel
    // is showing (listedMemberUser), not whatever is in the live input now.
    const target =
      targetOverride ?? (append ? listedMemberUser : memberUser.trim());
    if (!target) return;
    setUserGroupsLoading(true);
    setMessage(null);
    const pinnedTenantId = tenantId;
    const seq = ++userGroupsSeqRef.current;
    try {
      const params = new URLSearchParams({ userKey: target, pageSize: "200" });
      if (append && userGroupsPageToken) {
        params.set("pageToken", userGroupsPageToken);
      }
      const res = await tfetch(
        `/api/admin/groups?${params.toString()}`,
        {},
        pinnedTenantId
      );
      const result = await res.json();
      if (tenantIdRef.current !== pinnedTenantId) return;
      if (userGroupsSeqRef.current !== seq) return;

      if (result.success) {
        setUserGroups((prev) =>
          append ? [...prev, ...result.data.groups] : result.data.groups
        );
        setUserGroupsPageToken(result.data.nextPageToken);
        setUserGroupsSearched(true);
        setListedMemberUser(target);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to list memberships",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setUserGroupsLoading(false);
    }
  };

  // An outside member or a new owner is typed out in full before it is added.
  const addNeedsTyping =
    !!pendingAdd && (pendingAdd.external || pendingAdd.role === "OWNER");

  const roleBadgeClass = (role: string) =>
    role === "OWNER"
      ? "border-danger/40 text-danger-fg"
      : role === "MANAGER"
        ? "border-warning/40 text-warning-fg"
        : "";

  return (
    <>
      <PageHeader
        title="Groups"
        description="Browse groups, manage their members, and see every group a user belongs to."
        badge="Directory"
      />

      <FeedbackAlert message={message} className="mb-6" />

      <Tabs defaultValue="browse">
        <TabsList className="mb-4">
          <TabsTrigger value="browse">Browse groups</TabsTrigger>
          <TabsTrigger value="memberships">User memberships</TabsTrigger>
        </TabsList>

        <TabsContent value="browse">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Groups
                </CardTitle>
                <CardDescription>
                  Search by Directory query (e.g.{" "}
                  <code className="text-xs">email:eng-*</code> or{" "}
                  <code className="text-xs">name:contractors</code>), or leave
                  blank to list everything.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Search groups (optional)"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !groupsLoading) {
                        void loadGroups(false);
                      }
                    }}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => loadGroups(false)}
                    disabled={groupsLoading}
                  >
                    {groupsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                </div>

                {groups.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {groupsSearched && !groupsLoading
                      ? "No groups found"
                      : "Search to list groups"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {groups.map((g) => (
                      <button
                        key={g.email}
                        type="button"
                        onClick={() => loadMembers(g.email, false)}
                        className={`w-full flex items-center justify-between gap-3 p-3 rounded-lg border text-left transition-colors ${selectedGroup === g.email ? "border-primary bg-primary/5" : "bg-muted/30 hover:bg-muted/60"}`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {g.name || g.email}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {g.email}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {g.directMembersCount && (
                            <Badge variant="outline">
                              {g.directMembersCount} member
                              {g.directMembersCount === "1" ? "" : "s"}
                            </Badge>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    ))}
                    {groupsPageToken && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => loadGroups(true)}
                        disabled={groupsLoading}
                      >
                        {groupsLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Load more groups
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Members</CardTitle>
                <CardDescription>
                  {selectedGroup
                    ? `Direct members of ${selectedGroup}`
                    : "Select a group to manage its members"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedGroup && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="new-member">Add member</Label>
                      <div className="flex gap-2">
                        <Input
                          id="new-member"
                          placeholder="user@yourdomain.com"
                          value={newMember}
                          onChange={(e) => setNewMember(e.target.value)}
                        />
                        <Select
                          value={newRole}
                          onValueChange={(v) => v && setNewRole(v)}
                          items={{ MEMBER: "Member", MANAGER: "Manager", OWNER: "Owner" }}
                        >
                          <SelectTrigger
                            className="w-32 shrink-0"
                            aria-label="Member role"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {r.charAt(0) + r.slice(1).toLowerCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          onClick={openAdd}
                          disabled={!newMember.trim() || adding}
                        >
                          {adding ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <UserPlus className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      {newMember.trim() && isExternal(newMember.trim()) && (
                        <p className="text-xs text-warning-fg">
                          This address is outside your organisation
                          {verifiedDomains === null
                            ? " (or the tenant's domains couldn't be checked)"
                            : ""}
                          .
                        </p>
                      )}
                    </div>
                    <Separator />
                  </>
                )}

                {members.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {selectedGroup && !membersLoading
                      ? "No direct members"
                      : "No members to display"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {members.map((m) => (
                      <div
                        key={m.email || m.id}
                        className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {m.email || "(no email)"}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge
                              variant="outline"
                              className={roleBadgeClass(m.role)}
                            >
                              {m.role}
                            </Badge>
                            {m.type && m.type !== "USER" && (
                              <span className="text-xs text-muted-foreground">
                                {m.type}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setMessage(null);
                            setConfirmRemoveTarget({
                              group: selectedGroup,
                              member: m.email,
                            });
                          }}
                          disabled={
                            !m.email ||
                            removing === `${selectedGroup}:${m.email}`
                          }
                        >
                          {removing === `${selectedGroup}:${m.email}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-danger" />
                          )}
                        </Button>
                      </div>
                    ))}
                    {membersPageToken && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => loadMembers(selectedGroup, true)}
                        disabled={membersLoading}
                      >
                        {membersLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Load more members
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="memberships">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                User Memberships
              </CardTitle>
              <CardDescription>
                Every group the user is a direct member of. To remove someone
                from all groups at once, use the Offboarding flow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 max-w-lg">
                <Input
                  placeholder="user@yourdomain.com"
                  value={memberUser}
                  onChange={(e) => setMemberUser(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !userGroupsLoading && memberUser) {
                      void loadUserGroups(false);
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  onClick={() => loadUserGroups(false)}
                  disabled={!memberUser || userGroupsLoading}
                >
                  {userGroupsLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {userGroups.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {userGroupsSearched && !userGroupsLoading
                    ? `${listedMemberUser} is not a direct member of any group`
                    : "Search for a user to see their memberships"}
                </div>
              ) : (
                <div className="space-y-2">
                  {userGroups.map((g) => (
                    <div
                      key={g.email}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {g.name || g.email}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {g.email}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setMessage(null);
                          setConfirmRemoveTarget({
                            group: g.email,
                            member: listedMemberUser,
                          });
                        }}
                        disabled={
                          removing === `${g.email}:${listedMemberUser}`
                        }
                      >
                        {removing === `${g.email}:${listedMemberUser}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-danger" />
                        )}
                      </Button>
                    </div>
                  ))}
                  {userGroupsPageToken && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => loadUserGroups(true)}
                      disabled={userGroupsLoading}
                    >
                      {userGroupsLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      Load more
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmActionDialog
        open={!!pendingAdd}
        onOpenChange={(o) => {
          if (adding || o) return;
          setPendingAdd(null);
          setAddError(null);
        }}
        title="Add group member"
        summary={`Add ${pendingAdd?.member ?? "—"} to ${pendingAdd?.group ?? "—"} as ${pendingAdd?.role ?? ""}.`}
        tenant={
          tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
        }
        severity={addNeedsTyping ? "high" : "medium"}
        confirmPhrase={addNeedsTyping ? pendingAdd?.member : undefined}
        confirmLabel={addError ? "Try again" : "Add member"}
        busy={adding}
        changes={[
          { label: "Group", after: pendingAdd?.group ?? "" },
          {
            label: pendingAdd?.external
              ? "New member (outside your organisation)"
              : "New member",
            after: pendingAdd?.member ?? "",
            emphasis: !!pendingAdd?.external,
          },
          {
            label: "Role",
            after: pendingAdd?.role ?? "",
            emphasis: !!pendingAdd && pendingAdd.role !== "MEMBER",
          },
        ]}
        warnings={
          addNeedsTyping ? (
            <>
              {pendingAdd?.external && (
                <p className={pendingAdd.role === "OWNER" ? "mb-2" : undefined}>
                  <strong>{pendingAdd.member}</strong> is outside your
                  organisation
                  {verifiedDomains === null
                    ? " (or the tenant's domains couldn't be checked)"
                    : ""}
                  : they will get whatever this group gives its members — its
                  mail, and any files, calendars or sites shared with it.
                </p>
              )}
              {pendingAdd?.role === "OWNER" && (
                <p>
                  An <strong>owner</strong> can change the group&apos;s
                  settings, add and remove members (owners included), and
                  delete the group.
                </p>
              )}
            </>
          ) : null
        }
        error={addError}
        onConfirm={() => {
          if (pendingAdd) void addMember(pendingAdd);
        }}
      />

      <ConfirmActionDialog
        open={!!confirmRemoveTarget}
        onOpenChange={(o) => !removing && !o && setConfirmRemoveTarget(null)}
        title="Remove group member"
        summary={`${confirmRemoveTarget?.member ?? ""} will be removed from ${confirmRemoveTarget?.group ?? ""}.`}
        tenant={
          tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null
        }
        severity="medium"
        confirmLabel="Remove member"
        busy={!!removing}
        changes={[
          { label: "Group", after: confirmRemoveTarget?.group ?? "" },
          {
            label: "Member to remove",
            before: confirmRemoveTarget?.member ?? "",
            after: "no longer a member",
            emphasis: true,
          },
        ]}
        onConfirm={() => {
          if (confirmRemoveTarget) {
            void removeMember(
              confirmRemoveTarget.group,
              confirmRemoveTarget.member
            );
          }
        }}
      />
    </>
  );
}
