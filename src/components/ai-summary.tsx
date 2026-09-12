"use client";

import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Inline markdown subset: `**bold**`. */
function renderInline(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={j}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  );
}

/**
 * Renders the markdown-ish subset the AI report prompts ask for: headers,
 * bold, and bullets. Shared by the User Audit report and the Security Digest.
 * Consecutive bullet lines are grouped into one list so the markup nests
 * `<li>` inside a `<ul>` rather than directly in the container.
 *
 * The narrative is framed as advisory, and set off behind a rule, because the
 * model wrote it from strings the tenant chooses (label names, delegate and
 * forwarding addresses, group names, activity parameters): someone who can set
 * one of those can phrase it to steer the report, and no prompt preamble makes
 * that impossible. Nothing here is executed — every value is escaped by React
 * — so the residual risk is a *misleading* report, which is exactly what the
 * operator has to be told to double-check.
 */
export function AiSummary({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="my-1 ml-4 list-disc space-y-0.5">
        {bullets}
      </ul>
    );
    bullets = [];
  };

  text.split("\n").forEach((line, i) => {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(
        <li key={i} className="text-sm">
          {renderInline(line.slice(2))}
        </li>
      );
      return;
    }
    flushBullets(`list-${i}`);

    if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={i} className="text-base font-semibold mt-4 mb-2">
          {line.replace("## ", "")}
        </h3>
      );
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
          {line.replace("# ", "")}
        </h2>
      );
    } else if (line.trim() === "") {
      blocks.push(<br key={i} />);
    } else {
      blocks.push(
        <p key={i} className="text-sm">
          {renderInline(line)}
        </p>
      );
    }
  });
  flushBullets("list-end");

  return (
    <div className="space-y-3">
      {/* role="note": a standing disclaimer, not a live message — role="alert"
          would make a screen reader interrupt to announce it. */}
      <Alert variant="warning" role="note">
        <Bot />
        <AlertTitle>
          AI narrative — advisory, not an authoritative finding
        </AlertTitle>
        <AlertDescription>
          Written by Gemini from tenant-controlled data (label names, delegate
          and forwarding addresses, group names, activity parameters). Anyone
          who can set one of those strings can influence the wording below, and
          the model can also simply be wrong. Confirm anything that matters
          against the underlying Gmail, Calendar and Reports data before acting.
        </AlertDescription>
      </Alert>
      <div className="border-l-2 border-warning/30 pl-3">
        <div className="prose prose-sm max-w-none">{blocks}</div>
      </div>
    </div>
  );
}
