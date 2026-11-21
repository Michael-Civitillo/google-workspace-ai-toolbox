"use client";

import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";

interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string;
}

/** Fired by App Settings when the setting or the answer changes. */
export const UPDATE_STATUS_EVENT = "open-admin:update-status";

/**
 * A one-line note in the sidebar when a newer release is out. Shows nothing
 * unless the update check has been switched on in App Settings and found
 * one. While the check is off the server answers without asking anyone.
 */
export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/config/update")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.success) setStatus(d.data as UpdateStatus);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(UPDATE_STATUS_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(UPDATE_STATUS_EVENT, load);
    };
  }, []);

  if (!status?.enabled || !status.updateAvailable || !status.latest) return null;
  return (
    <a
      href={status.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="update-notice"
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-xs text-info-fg transition-colors hover:bg-info/15"
    >
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">{`Version ${status.latest} is out`}</span>
        <span className="block text-[11px] opacity-80">{`You have ${status.current}. Open the download page`}</span>
      </span>
    </a>
  );
}
