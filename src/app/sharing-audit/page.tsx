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
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  Search,
  Loader2,
  ExternalLink,
  Globe2,
  Users,
  Mail,
  AlertTriangle,
  Download,
} from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

interface ExternalPermission {
  type: "anyone" | "domain" | "user" | "group";
  role: string;
  target: string;
  allowFileDiscovery?: boolean | null;
}

interface ExternalFile {
  id: string;
  name: string;
  webViewLink: string | null;
  mimeType: string;
  ownedByMe: boolean;
  externalCount: number;
  external: ExternalPermission[];
}

interface AuditResult {
  user: string;
  scannedFiles: number;
  truncated: boolean;
  files: ExternalFile[];
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-violet-100 text-violet-700 border-violet-200",
  organizer: "bg-violet-100 text-violet-700 border-violet-200",
  fileOrganizer: "bg-violet-100 text-violet-700 border-violet-200",
  writer: "bg-amber-100 text-amber-700 border-amber-200",
  commenter: "bg-blue-100 text-blue-700 border-blue-200",
  reader: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

function permissionIcon(type: ExternalPermission["type"]) {
  switch (type) {
    case "anyone":
      return <Globe2 className="h-3.5 w-3.5" />;
    case "domain":
      return <Globe2 className="h-3.5 w-3.5" />;
    case "group":
      return <Users className="h-3.5 w-3.5" />;
    default:
      return <Mail className="h-3.5 w-3.5" />;
  }
}

function permissionLabel(p: ExternalPermission): string {
  if (p.type === "anyone") {
    return p.allowFileDiscovery
      ? "Anyone (public, indexable)"
      : "Anyone with the link";
  }
  if (p.type === "domain") return `Domain: ${p.target}`;
  return `${p.type}: ${p.target}`;
}

/**
 * Convert a list of external-share rows into a CSV the admin can paste
 * straight into a remediation ticket. We expand each external permission
 * into its own row so it slots into a flat spreadsheet.
 */
function toCsv(result: AuditResult): string {
  const header = [
    "file_name",
    "file_id",
    "mime_type",
    "web_view_link",
    "share_type",
    "share_target",
    "role",
    "anyone_with_link_indexable",
  ];
  const rows: string[][] = [header];
  for (const f of result.files) {
    for (const p of f.external) {
      rows.push([
        f.name,
        f.id,
        f.mimeType,
        f.webViewLink ?? "",
        p.type,
        p.target,
        p.role,
        p.type === "anyone" ? String(p.allowFileDiscovery ?? "") : "",
      ]);
    }
  }
  return rows
    .map((r) => r.map((c) => `"${(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

export default function SharingAudit() {
  const [user, setUser] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!user.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await tfetch(
        `/api/admin/sharing-audit?user=${encodeURIComponent(user)}`
      );
      const data = await res.json();
      if (data.success) {
        setResult(data.data);
      } else {
        setError(data.error || "Audit failed");
      }
    } catch {
      setError("Failed to connect to the API");
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    if (!result) return;
    const blob = new Blob([toCsv(result)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `external-sharing-${result.user}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const anyoneCount = result?.files.filter((f) =>
    f.external.some((p) => p.type === "anyone")
  ).length;

  return (
    <>
      <PageHeader
        title="External Sharing Audit"
        description="Find Drive files a user has shared outside your tenant — link-shared, shared with external domains, or shared with external email addresses."
        badge="Drive"
      />

      {error && (
        <Alert className="mb-6 border-red-200 bg-red-50">
          <AlertDescription className="text-red-800">{error}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-5xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Run Audit</CardTitle>
            <CardDescription>
              Scans the user&apos;s owned Drive files (up to 1,000 per run) and
              flags any permission outside the tenant&apos;s verified domains.
              Read-only — no changes are made.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="user">User Email</Label>
              <div className="flex gap-2">
                <Input
                  id="user"
                  placeholder="user@yourdomain.com"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && run()}
                />
                <Button onClick={run} disabled={!user.trim() || loading}>
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Requires the service account to have{" "}
                <code className="bg-muted px-1 rounded">
                  drive.metadata.readonly
                </code>{" "}
                domain-wide-delegation scope authorised in the Admin Console.
              </p>
            </div>
          </CardContent>
        </Card>

        {loading && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
                <p className="text-sm">
                  Scanning Drive (up to 1,000 files)…
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {result && (
          <>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg">
                      Results — {result.user}
                    </CardTitle>
                    <CardDescription>
                      Scanned {result.scannedFiles} file
                      {result.scannedFiles === 1 ? "" : "s"} · {result.files.length}{" "}
                      flagged{anyoneCount ? ` · ${anyoneCount} link-shared` : ""}
                      {result.truncated ? " · result was truncated at the cap" : ""}
                    </CardDescription>
                  </div>
                  {result.files.length > 0 && (
                    <Button variant="outline" size="sm" onClick={downloadCsv}>
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Export CSV
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {result.truncated && (
                  <Alert className="mb-4 border-amber-200 bg-amber-50">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription className="text-amber-800 text-sm">
                      Hit the 1,000 file cap. There may be additional
                      externally-shared files that weren&apos;t scanned.
                    </AlertDescription>
                  </Alert>
                )}

                {result.files.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground text-sm">
                    No externally-shared files found in {result.scannedFiles}{" "}
                    scanned.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {result.files.map((f) => (
                      <div
                        key={f.id}
                        className="rounded-lg border bg-muted/30 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">
                              {f.name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {f.mimeType}
                            </p>
                          </div>
                          {f.webViewLink && (
                            <a
                              href={f.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs flex items-center gap-1 text-blue-600 hover:underline shrink-0"
                            >
                              Open <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {f.external.map((p, i) => (
                            <Badge
                              key={i}
                              variant="outline"
                              className={`${
                                p.type === "anyone"
                                  ? "bg-red-50 text-red-700 border-red-200"
                                  : "bg-amber-50 text-amber-700 border-amber-200"
                              } text-xs flex items-center gap-1`}
                            >
                              {permissionIcon(p.type)}
                              {permissionLabel(p)}
                              <span
                                className={`ml-1 px-1 rounded ${
                                  ROLE_BADGE[p.role] ??
                                  "bg-zinc-100 text-zinc-700 border-zinc-200"
                                }`}
                              >
                                {p.role}
                              </span>
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
