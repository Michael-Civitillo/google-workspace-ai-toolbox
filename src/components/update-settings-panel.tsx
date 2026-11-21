"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { UPDATE_STATUS_EVENT } from "./update-notice";

interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string;
  checkedAt: string | null;
  error: string | null;
}

/**
 * The update check's switch, on App Settings. The check is off until someone
 * ticks the box here, and this is the only place that turns it on.
 */
export function UpdateSettingsPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/update")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.success) setStatus(d.data as UpdateStatus);
        else setFailure(d?.error || "The setting could not be read.");
      })
      .catch(() => {
        if (!cancelled) setFailure("Could not reach the server.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(body: { enabled?: boolean; check?: true }) {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d?.success) {
        setStatus(d.data as UpdateStatus);
        // The sidebar shows the same answer; tell it there is a new one.
        window.dispatchEvent(new Event(UPDATE_STATUS_EVENT));
      } else {
        setFailure(d?.error || "The setting could not be saved.");
      }
    } catch {
      setFailure("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm" data-testid="update-settings">
      <p>
        This is version{" "}
        <span className="font-medium" data-testid="running-version">
          {status?.current ?? "..."}
        </span>
        .
      </p>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={status?.enabled ?? false}
          disabled={!status || busy}
          onChange={(e) => void send({ enabled: e.target.checked })}
          data-testid="update-check-toggle"
        />
        <span>
          Tell me when a newer version is out
          <span className="block text-xs text-muted-foreground">
            Off unless you tick this. When on, Open Admin asks GitHub about
            twice a day which release is the newest. The request says nothing
            about your organisation, your tenants or you. Nothing is downloaded
            or installed: you get a link, here and at the bottom of the menu.
          </span>
        </span>
      </label>

      {status?.enabled && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3" data-testid="update-status">
          {status.error ? (
            <p className="text-danger-fg">Could not check: {status.error}</p>
          ) : status.updateAvailable && status.latest ? (
            <p>
              <span className="font-medium">{`Version ${status.latest} is out.`}</span>{" "}
              <a
                href={status.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                Open the download page
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          ) : status.latest ? (
            <p>{`You have the newest version (${status.latest} is the latest release).`}</p>
          ) : (
            <p className="text-muted-foreground">Not checked yet.</p>
          )}
          {status.updateAvailable && (
            <p className="text-xs text-muted-foreground">
              To update, download the new file and use it in place of the old
              one. Your tenants and settings are kept.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send({ check: true })}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check now
            </Button>
            {status.checkedAt && (
              <span className="text-xs text-muted-foreground">
                Last checked {new Date(status.checkedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}

      {failure && <p className="text-xs text-danger-fg">{failure}</p>}
    </div>
  );
}
