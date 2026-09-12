"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  ArrowRight,
  ArrowRightLeft,
  AlertTriangle,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  StopCircle,
} from "lucide-react";
import { tfetch, useCurrentTenant } from "@/lib/tenant-client";
import {
  ConfirmActionDialog,
  type DiffRow,
} from "@/components/confirm-action-dialog";

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  childrenIds: string[];
  childrenLoaded: boolean;
  loadingChildren: boolean;
  nextPageToken: string | null;
  expanded: boolean;
}

interface FolderListResponse {
  parent: { id: string; name: string } | null;
  folders: Array<{ id: string; name: string; ownedByUser: boolean }>;
  nextPageToken: string | null;
}

interface TransferCursor {
  queue: string[];
  current: {
    folderId: string;
    pageToken: string | null;
    selfTransferred: boolean;
  } | null;
}

interface TransferProgress {
  transferred: number;
  alreadyOwned: number;
  notOwned: number;
  errors: Array<{ id: string; name: string | null; message: string }>;
  nextCursor: TransferCursor | null;
}

interface ProgressTotals {
  transferred: number;
  alreadyOwned: number;
  notOwned: number;
  errors: Array<{ id: string; name: string | null; message: string }>;
  chunks: number;
  done: boolean;
}

// Server hard-caps the initial folder selection (TRANSFER_FOLDER_SELECTION_CAP).
// Mirror it client-side so a too-large selection is caught before the confirm
// dialog instead of aborting the first chunk after it.
const FOLDER_SELECTION_CAP = 100;

export default function DriveTransfer() {
  const { tenant, id: tenantId } = useCurrentTenant();

  const [fromUser, setFromUser] = useState("");
  const [toUser, setToUser] = useState("");

  const [nodes, setNodes] = useState<Record<string, FolderNode>>({});
  const [rootIds, setRootIds] = useState<string[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootNextToken, setRootNextToken] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(false);
  // Bumped on every tree reset (new root load or a change of "from" user).
  // Async folder loads capture the value at dispatch and discard their results
  // if it changed meanwhile, so a slow load for the previous user can't
  // repopulate the tree after the user switched.
  const loadSeq = useRef(0);
  // Abort the in-flight transfer chunk on cancel or unmount: cancelRef only
  // stops the loop BETWEEN chunks, and one chunk (500 items, 6-way
  // concurrency) can run for tens of seconds — long after the operator has
  // clicked Cancel or navigated away.
  const transferAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      transferAbortRef.current?.abort();
    };
  }, []);
  const [progress, setProgress] = useState<ProgressTotals | null>(null);
  const [completion, setCompletion] = useState<
    | { tone: "success" | "error"; message: string }
    | null
  >(null);

  function resetTree() {
    // Invalidate any in-flight folder loads so their results are discarded.
    loadSeq.current++;
    // Those superseded loads no longer touch the spinner either (see loadRoot),
    // so clear it here — a new load sets it again right after.
    setRootLoading(false);
    setNodes({});
    setRootIds(null);
    setRootNextToken(null);
    setSelected(new Set());
    setProgress(null);
    setCompletion(null);
  }

  async function loadRoot() {
    if (!fromUser.trim()) return;
    // resetTree() bumps the sequence (and clears any stale spinner); capture
    // the new value and bail if it changes (a new load / user switch) before
    // our results come back.
    resetTree();
    const seq = loadSeq.current;
    setError(null);
    setRootLoading(true);
    try {
      const res = await tfetch(
        `/api/admin/drive-transfer/folders?user=${encodeURIComponent(fromUser)}`,
        {},
        tenantId
      );
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (!data.success) {
        setError(data.error || "Failed to load Drive folders");
        return;
      }
      const payload = data.data as FolderListResponse;
      const newNodes: Record<string, FolderNode> = {};
      const ids: string[] = [];
      for (const f of payload.folders) {
        newNodes[f.id] = {
          id: f.id,
          name: f.name,
          parentId: null,
          childrenIds: [],
          childrenLoaded: false,
          loadingChildren: false,
          nextPageToken: null,
          expanded: false,
        };
        ids.push(f.id);
      }
      if (seq !== loadSeq.current) return;
      setNodes(newNodes);
      setRootIds(ids);
      setRootNextToken(payload.nextPageToken);
    } catch {
      if (seq !== loadSeq.current) return;
      setError("Failed to connect to the API");
    } finally {
      // Only the latest load owns the spinner: a superseded load must not
      // clear it (or post an error) while the newer one is still in flight.
      if (seq === loadSeq.current) setRootLoading(false);
    }
  }

  async function loadMoreRoot() {
    if (!fromUser.trim() || !rootNextToken) return;
    setError(null);
    setRootLoading(true);
    // Same staleness pin as loadRoot/loadChildren: if the tree was reset (new
    // root load / user switch) while this page was in flight, discard it —
    // otherwise the previous user's folders repopulate the emptied tree.
    const seq = loadSeq.current;
    try {
      const res = await tfetch(
        `/api/admin/drive-transfer/folders?user=${encodeURIComponent(fromUser)}&pageToken=${encodeURIComponent(rootNextToken)}`,
        {},
        tenantId
      );
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (!data.success) {
        setError(data.error || "Failed to load Drive folders");
        return;
      }
      const payload = data.data as FolderListResponse;
      setNodes((prev) => {
        const next = { ...prev };
        for (const f of payload.folders) {
          if (next[f.id]) continue;
          next[f.id] = {
            id: f.id,
            name: f.name,
            parentId: null,
            childrenIds: [],
            childrenLoaded: false,
            loadingChildren: false,
            nextPageToken: null,
            expanded: false,
          };
        }
        return next;
      });
      setRootIds((prev) => {
        const existing = new Set(prev ?? []);
        const merged = [...(prev ?? [])];
        for (const f of payload.folders) {
          if (!existing.has(f.id)) merged.push(f.id);
        }
        return merged;
      });
      setRootNextToken(payload.nextPageToken);
    } catch {
      if (seq !== loadSeq.current) return;
      setError("Failed to connect to the API");
    } finally {
      if (seq === loadSeq.current) setRootLoading(false);
    }
  }

  async function loadChildren(folderId: string, pageToken?: string) {
    // Pin the tree generation this load belongs to; if the tree is reset (new
    // root load / user switch) before results arrive, discard them so we don't
    // graft the old user's subfolders onto the new tree.
    const seq = loadSeq.current;
    setNodes((prev) => ({
      ...prev,
      [folderId]: { ...prev[folderId], loadingChildren: true },
    }));
    setError(null);
    try {
      const url =
        `/api/admin/drive-transfer/folders?user=${encodeURIComponent(fromUser)}&parent=${encodeURIComponent(folderId)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await tfetch(url, {}, tenantId);
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (!data.success) {
        setError(data.error || "Failed to load subfolders");
        setNodes((prev) => ({
          ...prev,
          [folderId]: { ...prev[folderId], loadingChildren: false },
        }));
        return;
      }
      const payload = data.data as FolderListResponse;
      setNodes((prev) => {
        const next = { ...prev };
        const parent = { ...next[folderId] };
        const newChildIds: string[] = pageToken ? [...parent.childrenIds] : [];
        const existing = new Set(newChildIds);
        for (const f of payload.folders) {
          if (!existing.has(f.id)) {
            newChildIds.push(f.id);
          }
          if (!next[f.id]) {
            next[f.id] = {
              id: f.id,
              name: f.name,
              parentId: folderId,
              childrenIds: [],
              childrenLoaded: false,
              loadingChildren: false,
              nextPageToken: null,
              expanded: false,
            };
          }
        }
        parent.childrenIds = newChildIds;
        parent.childrenLoaded = true;
        parent.loadingChildren = false;
        parent.nextPageToken = payload.nextPageToken;
        next[folderId] = parent;
        return next;
      });
    } catch {
      if (seq !== loadSeq.current) return;
      setError("Failed to connect to the API");
      setNodes((prev) => ({
        ...prev,
        [folderId]: { ...prev[folderId], loadingChildren: false },
      }));
    }
  }

  async function toggleExpand(folderId: string) {
    const node = nodes[folderId];
    if (!node) return;
    if (!node.expanded && !node.childrenLoaded) {
      await loadChildren(folderId);
    }
    // The tree may have been reset while the children were loading (user
    // switch mid-expand) — the guarded updater keeps this from dereferencing a
    // node that no longer exists and crashing the render.
    setNodes((prev) =>
      prev[folderId]
        ? {
            ...prev,
            [folderId]: { ...prev[folderId], expanded: !prev[folderId].expanded },
          }
        : prev
    );
  }

  function toggleSelected(folderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
        return next;
      }
      // Selecting a folder covers its whole subtree, so drop any
      // already-selected descendants: as separate transfer roots the server
      // would walk their subtrees twice, and their checkboxes would be stuck
      // checked-but-disabled under the selected ancestor.
      for (const id of next) {
        let cur = nodes[id]?.parentId ?? null;
        while (cur) {
          if (cur === folderId) {
            next.delete(id);
            break;
          }
          cur = nodes[cur]?.parentId ?? null;
        }
      }
      next.add(folderId);
      return next;
    });
  }

  const selectedNames = useMemo(() => {
    return Array.from(selected)
      .map((id) => nodes[id]?.name)
      .filter(Boolean) as string[];
  }, [selected, nodes]);

  const overSelectionCap = selected.size > FOLDER_SELECTION_CAP;
  const canConfirm =
    !!fromUser.trim() &&
    !!toUser.trim() &&
    fromUser.trim().toLowerCase() !== toUser.trim().toLowerCase() &&
    selected.size > 0 &&
    !overSelectionCap &&
    !busy;

  async function runTransfer() {
    if (selected.size === 0) return;
    setBusy(true);
    // Close the modal immediately: the transfer runs in chunks that can take
    // minutes, and while the dialog is up it covers the live progress card
    // and the Cancel button — the operator would be locked out of both for
    // the whole run.
    setConfirmOpen(false);
    cancelRef.current = false;
    const ac = new AbortController();
    transferAbortRef.current = ac;
    setError(null);
    setCompletion(null);
    setProgress({
      transferred: 0,
      alreadyOwned: 0,
      notOwned: 0,
      errors: [],
      chunks: 0,
      done: false,
    });

    // Snapshot the selection so a click after we kick off can't change what
    // we're actually transferring mid-flight. Trim the addresses once here —
    // a pasted trailing space would otherwise fail the server's strict email
    // validation after the operator already confirmed the dialog.
    const initialFolderIds = Array.from(selected);
    const from = fromUser.trim();
    const to = toUser.trim();

    let cursor: TransferCursor | null = null;
    let chunkIndex = 0;
    let totalErrors: ProgressTotals["errors"] = [];
    let aborted: string | null = null;

    try {
      while (true) {
        if (cancelRef.current) {
          aborted = "Cancelled before next chunk";
          break;
        }
        chunkIndex++;
        // The server re-checks the typed confirmation on every chunk, not just
        // the first, so each continuation has to carry it too.
        const body =
          cursor === null
            ? {
                fromUser: from,
                toUser: to,
                confirm: to,
                folderIds: initialFolderIds,
              }
            : { fromUser: from, toUser: to, confirm: to, cursor };
        let res: Response;
        try {
          res = await tfetch(
            "/api/admin/drive-transfer/transfer",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: ac.signal,
            },
            tenantId
          );
        } catch {
          // An abort is the operator cancelling (or leaving the page), not a
          // network failure. The server finishes the chunk it was given, which
          // the "some items may already have been transferred" note covers.
          aborted = ac.signal.aborted ? "Cancelled" : "Network error";
          break;
        }
        let data;
        try {
          data = await res.json();
        } catch {
          aborted = `Server returned a non-JSON response (HTTP ${res.status})`;
          break;
        }
        if (!data.success) {
          aborted = data.error || "Transfer failed";
          break;
        }
        const p = data.data as TransferProgress;
        totalErrors = totalErrors.concat(p.errors);
        setProgress((prev) => ({
          transferred: (prev?.transferred ?? 0) + p.transferred,
          alreadyOwned: (prev?.alreadyOwned ?? 0) + p.alreadyOwned,
          notOwned: (prev?.notOwned ?? 0) + p.notOwned,
          errors: [
            ...(prev?.errors ?? []),
            ...p.errors,
          ].slice(0, 200),
          chunks: chunkIndex,
          done: p.nextCursor === null,
        }));
        if (p.nextCursor === null) {
          cursor = null;
          break;
        }
        cursor = p.nextCursor;
      }
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }

    if (aborted) {
      setCompletion({
        tone: "error",
        message: `Transfer halted: ${aborted}. Some items may already have been transferred — re-select and re-run to continue.`,
      });
      return;
    }

    const hadErrors = totalErrors.length > 0;
    setCompletion({
      tone: hadErrors ? "error" : "success",
      message: hadErrors
        ? `Done with ${totalErrors.length} per-item error${totalErrors.length === 1 ? "" : "s"}. See the list below for details.`
        : "Ownership transfer complete across the selected folders.",
    });
  }

  const changes: DiffRow[] = [
    {
      label: "Source user",
      after: fromUser,
    },
    {
      label: "Target user (new owner)",
      after: toUser,
      emphasis: true,
    },
    {
      label: "Folders selected",
      after:
        selectedNames.length <= 5
          ? selectedNames.join(", ") || "(none)"
          : `${selectedNames.slice(0, 5).join(", ")} … +${selectedNames.length - 5} more`,
    },
    {
      label: "Scope",
      after:
        "The selected folders, every subfolder, and every file inside (recursively) — only items currently owned by the source user. Drive does NOT inherit owner permissions, so each item is transferred individually.",
      emphasis: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="Drive Folder Transfer"
        description="Pick folders from a user's Drive and transfer ownership of each folder and everything inside it (recursively) to another user in the same tenant."
        badge="Drive"
      />

      {error && (
        <Alert variant="destructive" className="mb-6">
          <XCircle className="h-4 w-4 text-danger" />
          <AlertDescription>
            {error}
          </AlertDescription>
        </Alert>
      )}

      {completion && (
        <Alert
          variant={completion.tone === "success" ? "success" : "warning"}
          className="mb-6"
        >
          {completion.tone === "success" ? <CheckCircle2 /> : <AlertTriangle />}
          <AlertDescription>{completion.message}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-4xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Users
            </CardTitle>
            <CardDescription>
              Both users must already exist in this tenant. Drive only permits
              ownership transfers within the same Google Workspace
              organization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px] space-y-2">
                <Label htmlFor="fromUser">Current owner</Label>
                <Input
                  id="fromUser"
                  placeholder="departing@yourdomain.com"
                  value={fromUser}
                  onChange={(e) => {
                    setFromUser(e.target.value);
                    resetTree();
                  }}
                  disabled={busy}
                />
              </div>
              <div className="pb-2">
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-[200px] space-y-2">
                <Label htmlFor="toUser">New owner</Label>
                <Input
                  id="toUser"
                  placeholder="receiving@yourdomain.com"
                  value={toUser}
                  onChange={(e) => setToUser(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => void loadRoot()}
                disabled={!fromUser.trim() || rootLoading || busy}
              >
                {rootLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                )}
                {rootIds === null ? "Load Drive" : "Reload Drive"}
              </Button>
              {selected.size > 0 && (
                <Badge variant="outline" className="text-xs">
                  {selected.size} folder{selected.size === 1 ? "" : "s"} selected
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {rootIds !== null && (
          <Card>
            <CardHeader>
              <CardTitle>
                Pick folders to transfer
              </CardTitle>
              <CardDescription>
                Click <ChevronRight className="inline h-3 w-3" /> to expand a
                folder. Check a folder to include it AND everything inside it.
                Only folders owned by {fromUser || "the source user"} are shown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rootIds.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No owned folders found at the root of My Drive for{" "}
                  {fromUser}.
                </div>
              ) : (
                <div className="rounded-md border bg-muted/20">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-2 border-b flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5" />
                    My Drive
                  </div>
                  <div className="p-2">
                    {rootIds.map((id) => (
                      <FolderRow
                        key={id}
                        nodeId={id}
                        nodes={nodes}
                        selected={selected}
                        depth={0}
                        onToggleExpand={toggleExpand}
                        onToggleSelected={toggleSelected}
                        onLoadMoreChildren={loadChildren}
                        disabled={busy}
                      />
                    ))}
                  </div>
                  {rootNextToken && (
                    <div className="border-t p-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void loadMoreRoot()}
                        disabled={rootLoading || busy}
                      >
                        {rootLoading ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : null}
                        Load more root folders
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <Alert variant="warning" className="mt-4">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertDescription>
                  Drive does not inherit ownership: each file and subfolder is
                  transferred individually. After the transfer, the source
                  user keeps writer (edit) access to every item — Drive demotes
                  them automatically rather than removing access.
                </AlertDescription>
              </Alert>

              {overSelectionCap && (
                <Alert variant="destructive" className="mt-4">
                  <AlertTriangle className="h-4 w-4 text-danger" />
                  <AlertDescription>
                    You&apos;ve selected {selected.size} folders — the maximum
                    per run is {FOLDER_SELECTION_CAP}. Unselect{" "}
                    {selected.size - FOLDER_SELECTION_CAP} before transferring
                    (each selected folder includes everything inside it).
                  </AlertDescription>
                </Alert>
              )}

              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <Button
                  size="lg"
                  onClick={() => {
                    setError(null);
                    setCompletion(null);
                    setConfirmOpen(true);
                  }}
                  disabled={!canConfirm}
                >
                  <ArrowRightLeft className="mr-2 h-4 w-4" />
                  Review &amp; transfer ownership
                </Button>
                {selected.size > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(new Set())}
                    disabled={busy}
                  >
                    Clear selection
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {progress && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : progress.errors.length > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-warning" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                )}
                Transfer progress
                {busy && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      cancelRef.current = true;
                      transferAbortRef.current?.abort();
                    }}
                    className="ml-auto"
                  >
                    <StopCircle className="h-3.5 w-3.5 mr-1.5" />
                    Cancel
                  </Button>
                )}
              </CardTitle>
              <CardDescription>
                {progress.chunks} chunk{progress.chunks === 1 ? "" : "s"}{" "}
                processed
                {progress.done ? " · done" : busy ? " · running…" : " · paused"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatTile label="Transferred" value={progress.transferred} tone="success" />
                <StatTile label="Already owned" value={progress.alreadyOwned} tone="neutral" />
                <StatTile label="Skipped (not owned)" value={progress.notOwned} tone="neutral" />
                <StatTile label="Errors" value={progress.errors.length} tone={progress.errors.length > 0 ? "error" : "neutral"} />
              </div>
              {progress.errors.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Per-item errors (first {Math.min(progress.errors.length, 200)})
                  </p>
                  <div className="rounded-md border bg-muted/20 max-h-72 overflow-auto">
                    {progress.errors.slice(0, 200).map((err, i) => (
                      <div
                        key={`${err.id}-${i}`}
                        className="px-3 py-2 border-b last:border-b-0 text-xs"
                      >
                        <p className="font-medium truncate">
                          {err.name || "(unnamed item)"}
                        </p>
                        <p className="text-muted-foreground font-mono text-[10px] truncate">
                          {err.id}
                        </p>
                        <p className="text-danger-fg mt-0.5">
                          {err.message}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={(o) => !busy && setConfirmOpen(o)}
        title="Transfer Drive folder ownership"
        summary={`Transfer ${selected.size} folder${selected.size === 1 ? "" : "s"} (and everything inside) from ${fromUser} to ${toUser}.`}
        tenant={tenant ? { name: tenant.name, adminEmail: tenant.adminEmail } : null}
        severity="high"
        confirmPhrase={toUser.trim()}
        confirmLabel="Transfer ownership"
        busy={busy}
        changes={changes}
        warnings={
          <span>
            Ownership transfers are{" "}
            <strong>not automatically reversible</strong> — the new owner has
            to transfer them back if needed. Google sends the new owner an
            email notification per item (Drive does not allow suppressing this
            for ownership transfers).
          </span>
        }
        onConfirm={runTransfer}
      />
    </>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "neutral" | "error";
}) {
  const toneClass =
    tone === "success"
      ? "border-success/25 bg-success/8 text-success-fg"
      : tone === "error"
        ? "border-danger/25 bg-danger/8 text-danger-fg"
        : "bg-muted/40";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-xl font-semibold mt-0.5">{value.toLocaleString()}</p>
    </div>
  );
}

function FolderRow({
  nodeId,
  nodes,
  selected,
  depth,
  onToggleExpand,
  onToggleSelected,
  onLoadMoreChildren,
  disabled,
}: {
  nodeId: string;
  nodes: Record<string, FolderNode>;
  selected: Set<string>;
  depth: number;
  onToggleExpand: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onLoadMoreChildren: (id: string, pageToken?: string) => void;
  disabled: boolean;
}) {
  const node = nodes[nodeId];
  if (!node) return null;
  const isSelected = selected.has(nodeId);
  // Visual cue when an ancestor is already selected — the user doesn't
  // need to (and shouldn't) double-select a child that's already covered.
  const ancestorSelected = (() => {
    let cur = node.parentId;
    while (cur) {
      if (selected.has(cur)) return true;
      const parent = nodes[cur];
      if (!parent) break;
      cur = parent.parentId;
    }
    return false;
  })();
  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 rounded hover:bg-muted/40"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <button
          type="button"
          onClick={() => onToggleExpand(nodeId)}
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-muted disabled:opacity-30"
          aria-label={node.expanded ? "Collapse" : "Expand"}
          disabled={disabled}
        >
          {node.loadingChildren ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : node.expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelected(nodeId)}
          disabled={disabled || ancestorSelected}
          aria-label={`Select ${node.name}`}
          className="shrink-0"
        />
        <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span
          className={`text-sm truncate ${
            ancestorSelected ? "text-muted-foreground italic" : ""
          }`}
          title={ancestorSelected ? "Already covered by a selected parent" : node.name}
        >
          {node.name}
        </span>
      </div>
      {node.expanded && node.childrenLoaded && (
        <div>
          {node.childrenIds.length === 0 && (
            <div
              className="text-xs text-muted-foreground py-1"
              style={{ paddingLeft: `${(depth + 1) * 14 + 24}px` }}
            >
              (no owned subfolders)
            </div>
          )}
          {node.childrenIds.map((childId) => (
            <FolderRow
              key={childId}
              nodeId={childId}
              nodes={nodes}
              selected={selected}
              depth={depth + 1}
              onToggleExpand={onToggleExpand}
              onToggleSelected={onToggleSelected}
              onLoadMoreChildren={onLoadMoreChildren}
              disabled={disabled}
            />
          ))}
          {node.nextPageToken && (
            <div style={{ paddingLeft: `${(depth + 1) * 14 + 24}px` }}>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled || node.loadingChildren}
                onClick={() =>
                  onLoadMoreChildren(nodeId, node.nextPageToken ?? undefined)
                }
              >
                {node.loadingChildren ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : null}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

