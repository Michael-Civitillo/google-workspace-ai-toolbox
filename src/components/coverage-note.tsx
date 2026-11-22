"use client";

import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * What an AI report could not cover, as the server worked it out: sections
 * whose data could not be read, and sections cut short. Shown beside the
 * summary rather than left to the model to mention, because the model may
 * not, and nothing it writes can be relied on to say what is missing.
 */
export interface Coverage {
  unavailable: Array<{ section: string; error: string }>;
  truncated: string[];
}

/** The coverage fields of an AI route's answer, or null when there are none. */
export function readCoverage(data: unknown): Coverage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { unavailable?: unknown; truncated?: unknown };
  const unavailable = Array.isArray(d.unavailable)
    ? d.unavailable
        .filter(
          (u): u is { section: string; error: string } =>
            !!u &&
            typeof (u as { section?: unknown }).section === "string" &&
            typeof (u as { error?: unknown }).error === "string"
        )
        .slice(0, 20)
    : [];
  const truncated = Array.isArray(d.truncated)
    ? d.truncated.filter((t): t is string => typeof t === "string").slice(0, 20)
    : [];
  return unavailable.length > 0 || truncated.length > 0 ? { unavailable, truncated } : null;
}

export function CoverageNote({ gaps }: { gaps: Coverage | null }) {
  if (!gaps) return null;
  return (
    <Alert variant="warning" data-testid="ai-coverage-note">
      <AlertTriangle className="h-4 w-4 text-warning" />
      <AlertDescription>
        <p className="font-medium">This report does not cover everything.</p>
        <ul className="mt-1 list-disc list-inside space-y-0.5 text-xs">
          {gaps.unavailable.map((u) => (
            <li key={`u:${u.section}`}>
              {u.section}: could not be read ({u.error})
            </li>
          ))}
          {gaps.truncated.map((t) => (
            <li key={`t:${t}`}>{t}: only the first part was read</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
