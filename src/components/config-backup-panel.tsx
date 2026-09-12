"use client";

import { useEffect, useRef, useState } from "react";
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
  credentialFileCount: number;
  ssoIssuer: string | null;
  ssoEnabled: boolean;
  raw: unknown;
}

interface ImportOutcome {
  tenants: number;
  sso: boolean;
  credentialFiles: number;
  notes: string[];
  warnings: string[];
}

export function ConfigBackupPanel() {
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [currentTenants, setCurrentTenants] = useState<number | null>(null);
  const [currentSsoIssuer, setCurrentSsoIssuer] = useState<string | null>(null);
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
  // While current state is still loading (null), err on the guarded side.
  const freshServer = currentTenants === 0 && !currentSsoIssuer;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setCurrentTenants(
          typeof data?.tenantCount === "number" ? data.tenantCount : 0
        );
        setCurrentSsoIssuer(data?.sso?.issuer ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        const tenants = Array.isArray(parsed?.tenants?.tenants)
          ? parsed.tenants.tenants.length
          : 0;
        setPreview({
          exportedAt:
            typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
          includesSecrets: parsed.includesSecrets === true,
          tenantCount: tenants,
          credentialFileCount:
            parsed.credentialFiles && typeof parsed.credentialFiles === "object"
              ? Object.keys(parsed.credentialFiles).length
              : 0,
          ssoIssuer:
            typeof parsed?.app?.sso?.issuer === "string"
              ? parsed.app.sso.issuer
              : null,
          ssoEnabled: parsed?.app?.sso?.enabled === true,
          raw: parsed,
        });
      } catch {
        setParseError("Could not parse the file as JSON.");
      }
    };
    reader.onerror = () => setParseError("Could not read the file.");
    reader.readAsText(file);
  }

  async function runImport() {
    if (!preview) return;
    setImporting(true);
    setImportError(null);
    try {
      // The server demands the same phrase the dialog collected whenever it
      // already holds configuration; on a fresh server it is ignored.
      const res = await fetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(preview.raw as Record<string, unknown>),
          confirm: "REPLACE",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data?.error ?? "Import failed");
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
      setCurrentTenants(data?.imported?.tenants ?? 0);
      // The sidebar tenant switcher shows live tenant state — tell it to refetch.
      notifyTenantsChanged();
    } catch {
      setImportError("Network error — nothing was imported");
    } finally {
      setImporting(false);
      setConfirmOpen(false);
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
        {exportError && <p className="text-xs text-danger">{exportError}</p>}
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
              </li>
              <li>
                SSO:{" "}
                {preview.ssoIssuer
                  ? `${preview.ssoEnabled ? "enabled" : "configured but disabled"} — ${preview.ssoIssuer}`
                  : "not configured"}
              </li>
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
              onClick={() => setConfirmOpen(true)}
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

        {importError && (
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
            after: preview?.ssoIssuer ?? "not configured",
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
            </p>
          )
        }
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
