"use client";

import type { ReactNode } from "react";

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

  return <div className="prose prose-sm max-w-none">{blocks}</div>;
}
