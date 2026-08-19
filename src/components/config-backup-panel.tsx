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
  ssoIssuer: string | null;
  ssoEnabled: boolean;
  raw: unknown;
}

interface ImportOutcome {
  tenants: number;
  sso: boolean;
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
  const fileRef = useRef<HTMLInputElement>(null);

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
    if (file.size > 1024 * 1024) {
      setParseError("File is larger than 1 MB — that is not a toolbox config bundle.");
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
      const res = await fetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preview.raw),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data?.error ?? "Import failed");
        return;
      }
      setOutcome({
        tenants: data?.imported?.tenants ?? 0,
        sso: Boolean(data?.imported?.sso),
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

  return (
    <div className="space-y-6">
      {/* Export */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Export configuration</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Downloads a JSON bundle with your SSO settings and every tenant
          (names, admin emails, credential paths{includeSecrets ? ", secrets" : ""}).
          Import it on another server to clone this setup. Service-account JSON
          key files are <strong>not</strong> included — copy those separately.
        </p>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Include secrets (OIDC client secret, Gemini API keys)
        </label>
        {includeSecrets && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            The file will contain live secrets — treat it like a password and
            store it somewhere access-controlled.
          </p>
        )}
        <a
          href={`/api/config/export${includeSecrets ? "" : "?secrets=0"}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          download
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Download config bundle
        </a>
      </div>

      {/* Import */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Import configuration</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Restores a bundle exported from another server. It{" "}
          <strong>replaces</strong>{" "}
          this server&apos;s SSO settings and entire tenant list — it is not a
          merge.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted file:cursor-pointer"
        />

        {parseError && (
          <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-sm text-red-800 dark:text-red-300">
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
          <Alert className="border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-sm text-red-800 dark:text-red-300">
              {importError}
            </AlertDescription>
          </Alert>
        )}

        {outcome && (
          <Alert className="border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <AlertDescription className="text-sm text-emerald-800 dark:text-emerald-300">
              <p>
                Imported {outcome.tenants} tenant
                {outcome.tenants === 1 ? "" : "s"}
                {outcome.sso ? " and SSO settings" : ""}.
              </p>
              {outcome.warnings.length > 0 && (
                <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-amber-800 dark:text-amber-300">
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
        title="Replace this server's configuration"
        summary="The bundle becomes the new configuration — current SSO settings and all existing tenants are overwritten."
        tenant={null}
        changes={[
          {
            label: "Tenants",
            before:
              currentTenants !== null ? `${currentTenants} configured` : null,
            after: `${preview?.tenantCount ?? 0} from bundle`,
            emphasis: true,
          },
          {
            label: "SSO settings",
            before: currentSsoIssuer ?? "not configured",
            after: preview?.ssoIssuer ?? "not configured",
          },
        ]}
        warnings={
          <p>
            This cannot be undone from the UI. Consider exporting the current
            configuration first as a fallback.
          </p>
        }
        severity="high"
        confirmPhrase="REPLACE"
        confirmLabel="Import bundle"
        busy={importing}
        onConfirm={runImport}
      />
    </div>
  );
}
