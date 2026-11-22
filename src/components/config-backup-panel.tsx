"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { notifyTenantsChanged } from "@/lib/tenant-client";
import { CONFIG_BUNDLE_KIND } from "@/lib/app-config-types";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  Upload,
} from "lucide-react";

/**
 * Export / import of the whole toolbox configuration (SSO settings + tenant
 * list) as a portable JSON bundle, for moving the app to another server.
 * Import is replace-not-merge and destructive, so it runs through the
 * standard typed-confirmation dialog.
 */

interface BundlePreview {
  exportedAt: string | null;
  includesSecrets: boolean;
  tenantCount: number;
  /** The first few tenants, as "name (admin)": what the server will act on. */
  tenantNames: string[];
  credentialFileCount: number;
  ssoIssuer: string | null;
  ssoEnabled: boolean;
  /** Who the bundle's single sign-on lets in, in a sentence; null without SSO. */
  ssoAccess: string | null;
  /** The bundle asks for the password form to be turned off. */
  ssoOnly: boolean;
  raw: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

/** Who a bundle's single sign-on block lets in, said plainly. */
function describeSsoAccess(sso: Record<string, unknown>): string {
  if (sso.allowAnyIdpUser === true) return "anyone the identity provider signs in";
  const domains = strings(sso.allowedDomains);
  const emails = strings(sso.allowedEmails);
  const list = (items: string[]) =>
    items.slice(0, 5).join(", ") + (items.length > 5 ? ` and ${items.length - 5} more` : "");
  const parts = [
    domains.length > 0 ? `addresses at ${list(domains)}` : "",
    emails.length > 0 ? list(emails) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; and ") : "nobody (no domains or addresses are allowed)";
}

interface ImportOutcome {
  tenants: number;
  sso: boolean;
  credentialFiles: number;
  notes: string[];
  warnings: string[];
}

interface ServerStatus {
  tenants: number;
  ssoIssuer: string | null;
}

/** What this server has configured now, or null when it couldn't be read. */
async function readServerStatus(): Promise<ServerStatus | null> {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    const data = r.ok ? await r.json() : null;
    if (typeof data?.tenantCount !== "number") return null;
    return {
      tenants: data.tenantCount,
      ssoIssuer: typeof data?.sso?.issuer === "string" ? data.sso.issuer : null,
    };
  } catch {
    return null;
  }
}

export function ConfigBackupPanel() {
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [currentTenants, setCurrentTenants] = useState<number | null>(null);
  const [currentSsoIssuer, setCurrentSsoIssuer] = useState<string | null>(null);
  // Whether the last read of this server's configuration succeeded. Until it
  // has, the server counts as configured: a failed read is not "empty".
  const [statusKnown, setStatusKnown] = useState(false);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // With nothing configured yet (the restore-onto-new-server case) the import
  // is one click; only overwriting real config demands the typed phrase.
  // While current state is unknown — loading, or the read failed — err on the
  // guarded side.
  const freshServer = statusKnown && currentTenants === 0 && !currentSsoIssuer;

  const applyStatus = useCallback((status: ServerStatus | null) => {
    if (status) {
      setCurrentTenants(status.tenants);
      setCurrentSsoIssuer(status.ssoIssuer);
    }
    setStatusKnown(status !== null);
  }, []);

  /** Read what this server has now. Returns false when it couldn't. */
  const loadStatus = useCallback(async (): Promise<boolean> => {
    const status = await readServerStatus();
    applyStatus(status);
    return status !== null;
  }, [applyStatus]);

  useEffect(() => {
    let cancelled = false;
    readServerStatus().then((status) => {
      if (!cancelled) applyStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [applyStatus]);

  function onFilePicked(file: File | null) {
    setPreview(null);
    setParseError(null);
    setOutcome(null);
    setImportError(null);
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setParseError("File is larger than 8 MB — that is not a toolbox config bundle.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || typeof parsed !== "object" || parsed.kind !== CONFIG_BUNDLE_KIND) {
          setParseError(
            "This file is not a toolbox configuration bundle (expected an export from App Settings)."
          );
          return;
        }
        const tenantList: unknown[] = Array.isArray(parsed?.tenants?.tenants)
          ? parsed.tenants.tenants
          : [];
        const sso =
          parsed?.app?.sso && typeof parsed.app.sso === "object"
            ? (parsed.app.sso as Record<string, unknown>)
            : null;
        setPreview({
          exportedAt:
            typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
          includesSecrets: parsed.includesSecrets === true,
          tenantCount: tenantList.length,
          tenantNames: tenantList.slice(0, 5).map((t) => {
            const r = (t ?? {}) as Record<string, unknown>;
            const name = typeof r.name === "string" ? r.name.slice(0, 100) : "(no name)";
            return typeof r.adminEmail === "string" ? `${name} (${r.adminEmail.slice(0, 320)})` : name;
          }),
          credentialFileCount:
            parsed.credentialFiles && typeof parsed.credentialFiles === "object"
              ? Object.keys(parsed.credentialFiles).length
              : 0,
          ssoIssuer: typeof sso?.issuer === "string" ? sso.issuer : null,
          ssoEnabled: sso?.enabled === true,
          ssoAccess: sso ? describeSsoAccess(sso) : null,
          ssoOnly: sso?.enabled === true && sso?.passwordLoginEnabled === false,
          raw: parsed,
        });
      } catch {
        setParseError("Could not parse the file as JSON.");
      }
    };
    reader.onerror = () => setParseError("Could not read the file.");
    reader.readAsText(file);
  }

  async function openImportDialog() {
    setImportError(null);
    // Decide whether to ask for the typed phrase from what the server has
    // now, not from what it had when the page opened.
    await loadStatus();
    setConfirmOpen(true);
  }

  async function runImport() {
    if (!preview) return;
    setImporting(true);
    setImportError(null);
    try {
      // The phrase goes only when the dialog collected it. On a server that
      // looked empty the request goes without, so if it has been configured
      // meanwhile the server refuses instead of being overwritten unasked.
      const res = await fetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(preview.raw as Record<string, unknown>),
          ...(freshServer ? {} : { confirm: "REPLACE" }),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (freshServer) {
          // Configured after all: show the guarded dialog, phrase and all.
          await loadStatus();
        }
        setImportError(data?.error ?? `Import failed (the server answered ${res.status})`);
        return;
      }
      setOutcome({
        tenants: data?.imported?.tenants ?? 0,
        sso: Boolean(data?.imported?.sso),
        credentialFiles: data?.imported?.credentialFiles ?? 0,
        notes: Array.isArray(data?.notes) ? data.notes : [],
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      });
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      setConfirmOpen(false);
      void loadStatus();
      // The sidebar tenant switcher shows live tenant state — tell it to refetch.
      notifyTenantsChanged();
    } catch {
      // The request may have reached the server: say so rather than guess.
      setImportError(
        "The server did not answer, so it is not known whether the configuration was replaced. Reload the page to see what this server has now before trying again."
      );
      void loadStatus();
      notifyTenantsChanged();
    } finally {
      setImporting(false);
    }
  }

  // The bundle with secrets is a POST behind a typed confirmation: one file
  // carries every private key the server holds, so it is a deliberate act
  // rather than a link that any page could point at.
  async function runExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/config/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "EXPORT SECRETS" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setExportError(data?.error ?? "Export failed");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        match?.[1] ??
        `gws-toolbox-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportConfirmOpen(false);
    } catch {
      setExportError("Network error — nothing was exported");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Export */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Export configuration</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {includeSecrets ? (
            <>
              Downloads one JSON file with everything: SSO settings, every
              tenant, and the service-account key files themselves. Import it
              on another server and the whole setup comes back — no separate
              key copying.
            </>
          ) : (
            <>
              Downloads a sanitised bundle: SSO settings and tenants, with
              secrets and key files stripped. Good for sharing a config
              layout, but a restore from it needs the keys re-entered.
            </>
          )}
        </p>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Include secrets (OIDC client secret, Gemini API keys, service-account key files)
        </label>
        {includeSecrets && (
          <p className="text-xs text-warning-fg">
            The file will contain live secrets, including private keys — treat
            it like a password and store it somewhere access-controlled.
          </p>
        )}
        {includeSecrets ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setExportError(null);
              setExportConfirmOpen(true);
            }}
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download config bundle
          </Button>
        ) : (
          <a
            href="/api/config/export"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            download
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download sanitised bundle
          </a>
        )}
        {exportError && !exportConfirmOpen && (
          <p className="text-xs text-danger">{exportError}</p>
        )}
      </div>

      {/* Import */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Import configuration</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Pick a bundle exported from another server and the whole setup is
          restored — including the service-account key files, written back to
          disk automatically. It{" "}
          <strong>replaces</strong>{" "}
          the SSO settings and entire tenant list here; it is not a merge.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted file:cursor-pointer"
        />

        {parseError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4 text-danger" />
            <AlertDescription>
              {parseError}
            </AlertDescription>
          </Alert>
        )}

        {preview && (
          <div className="rounded-lg border bg-muted/40 p-3 space-y-2 text-sm">
            <p className="font-medium flex items-center gap-1.5">
              <FileUp className="h-4 w-4" />
              Bundle contents
            </p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>
                Exported:{" "}
                {preview.exportedAt
                  ? new Date(preview.exportedAt).toLocaleString()
                  : "unknown"}
              </li>
              <li>
                Tenants: {preview.tenantCount}
                {currentTenants !== null &&
                  ` (this server currently has ${currentTenants})`}
                {preview.tenantNames.length > 0 && (
                  <>
                    {": "}
                    {preview.tenantNames.join(", ")}
                    {preview.tenantCount > preview.tenantNames.length &&
                      ` and ${preview.tenantCount - preview.tenantNames.length} more`}
                  </>
                )}
              </li>
              <li>
                SSO:{" "}
                {preview.ssoIssuer
                  ? `${preview.ssoEnabled ? "enabled" : "configured but disabled"} — ${preview.ssoIssuer}`
                  : "not configured"}
              </li>
              {preview.ssoIssuer && preview.ssoEnabled && (
                <li>
                  Who can sign in with it: {preview.ssoAccess}.
                  {preview.ssoOnly
                    ? " The bundle turns the password form off; this server keeps it on until a test sign-in passes here."
                    : " The password form stays available too."}
                </li>
              )}
              <li>
                Service-account key files:{" "}
                {preview.credentialFileCount > 0
                  ? `${preview.credentialFileCount} embedded (restored to disk on import)`
                  : "none embedded"}
              </li>
              <li>Secrets included: {preview.includesSecrets ? "yes" : "no"}</li>
            </ul>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void openImportDialog()}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1.5" />
              )}
              Import and replace...
            </Button>
          </div>
        )}

        {importError && !confirmOpen && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4 text-danger" />
            <AlertDescription>
              {importError}
            </AlertDescription>
          </Alert>
        )}

        {outcome && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <AlertDescription>
              <p>
                Imported {outcome.tenants} tenant
                {outcome.tenants === 1 ? "" : "s"}
                {outcome.sso ? " and SSO settings" : ""}
                {outcome.credentialFiles > 0
                  ? `, restored ${outcome.credentialFiles} key file${
                      outcome.credentialFiles === 1 ? "" : "s"
                    } to disk`
                  : ""}
                .
              </p>
              {outcome.notes.length > 0 && (
                <ul className="mt-2 list-disc list-inside space-y-1 text-xs">
                  {outcome.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {outcome.warnings.length > 0 && (
                <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-warning-fg">
                  {outcome.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          freshServer
            ? "Restore configuration from bundle"
            : "Replace this server's configuration"
        }
        summary={
          freshServer
            ? "Nothing is configured here yet — the bundle just fills everything in."
            : "The bundle becomes the new configuration — current SSO settings and all existing tenants are overwritten."
        }
        tenant={null}
        changes={[
          {
            label: "Tenants",
            before:
              currentTenants !== null ? `${currentTenants} configured` : null,
            after: `${preview?.tenantCount ?? 0} from bundle`,
            emphasis: !freshServer,
          },
          {
            label: "SSO settings",
            before: currentSsoIssuer ?? "not configured",
            after: preview?.ssoIssuer
              ? `${preview.ssoIssuer}${preview.ssoEnabled ? `, letting in ${preview.ssoAccess}` : ", turned off"}`
              : "not configured",
            emphasis: Boolean(preview?.ssoEnabled),
          },
          {
            label: "Service-account key files",
            after:
              (preview?.credentialFileCount ?? 0) > 0
                ? `${preview?.credentialFileCount} written to disk`
                : "none embedded in bundle",
          },
        ]}
        warnings={
          freshServer ? undefined : (
            <p>
              This cannot be undone from the UI. Consider exporting the current
              configuration first as a fallback.
              {!statusKnown &&
                " This server's current configuration could not be read, so it is treated as configured."}
            </p>
          )
        }
        error={importError}
        // A fresh server has nothing to lose — restoring there is one click.
        // Overwriting a configured server keeps the typed guard.
        severity={freshServer ? "medium" : "high"}
        confirmPhrase={freshServer ? undefined : "REPLACE"}
        confirmLabel={freshServer ? "Restore" : "Import bundle"}
        busy={importing}
        onConfirm={runImport}
      />

      <ConfirmActionDialog
        open={exportConfirmOpen}
        onOpenChange={(o) => !exporting && setExportConfirmOpen(o)}
        error={exportError}
        title="Export configuration with secrets"
        summary="One file will hold every service-account private key, the OIDC client secret and every Gemini key this server has."
        tenant={null}
        severity="high"
        confirmPhrase="EXPORT SECRETS"
        confirmLabel="Download bundle"
        busy={exporting}
        changes={[
          {
            label: "Tenants",
            after:
              currentTenants !== null
                ? `${currentTenants} with their key files`
                : "all configured tenants with their key files",
          },
          {
            label: "Single sign-on",
            after: currentSsoIssuer
              ? `${currentSsoIssuer} with its client secret`
              : "not configured",
          },
          {
            label: "Handling",
            after:
              "Anyone holding the file can act as this app — store it somewhere access-controlled",
            emphasis: true,
          },
        ]}
        onConfirm={runExport}
      />
    </div>
  );
}
