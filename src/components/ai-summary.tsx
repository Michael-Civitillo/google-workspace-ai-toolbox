"use client";

import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Inline markdown subset: `**bold**`, `*italic*`, and `code`. */
function renderInline(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, j) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={j}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={j} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={j}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

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
  let listKind: "ul" | "ol" = "ul";
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      listKind === "ol" ? (
        <ol key={key} className="my-1 ml-5 list-decimal space-y-0.5">
          {bullets}
        </ol>
      ) : (
        <ul key={key} className="my-1 ml-4 list-disc space-y-0.5">
          {bullets}
        </ul>
      )
    );
    bullets = [];
  };

  text.split("\n").forEach((line, i) => {
    // Bullets (indented ones too, flattened) and numbered steps: the model
    // writes both, and either used to come out as raw "- " or "1." text.
    const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
    if (kind) {
      if (bullets.length > 0 && kind !== listKind) flushBullets(`list-${i}-switch`);
      listKind = kind;
      // A numbered step keeps the number the model wrote. The steps often
      // come with blank lines or sub-points between them, each of which ends
      // one list and starts another, and every one would begin again at "1.".
      const written = kind === "ol" ? Number.parseInt(line, 10) : NaN;
      bullets.push(
        <li
          key={i}
          className="text-sm"
          {...(Number.isInteger(written) && written >= 0 ? { value: written } : {})}
        >
          {renderInline(line.replace(kind === "ul" ? BULLET : NUMBERED, ""))}
        </li>
      );
      return;
    }
    flushBullets(`list-${i}`);

    if (/^#{3,6} /.test(line)) {
      blocks.push(
        <h4 key={i} className="text-sm font-semibold mt-3 mb-1">
          {renderInline(line.replace(/^#{3,6} /, ""))}
        </h4>
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={i} className="text-base font-semibold mt-4 mb-2">
          {renderInline(line.replace("## ", ""))}
        </h3>
      );
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
          {renderInline(line.replace("# ", ""))}
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
