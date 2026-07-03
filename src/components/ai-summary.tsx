"use client";

/**
 * Renders the markdown-ish subset the AI report prompts ask for: headers,
 * bold, and bullets. Shared by the User Audit report and the Security Digest.
 */
export function AiSummary({ text }: { text: string }) {
  const rendered = text.split("\n").map((line, i) => {
    // Headers
    if (line.startsWith("## ")) {
      return (
        <h3 key={i} className="text-base font-semibold mt-4 mb-2">
          {line.replace("## ", "")}
        </h3>
      );
    }
    if (line.startsWith("# ")) {
      return (
        <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
          {line.replace("# ", "")}
        </h2>
      );
    }

    // Bold text with **
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    const withBold = parts.map((part, j) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={j}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });

    // Bullet points
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return (
        <li key={i} className="text-sm ml-4 list-disc">
          {withBold.map((r, idx) =>
            typeof r === "string" ? (idx === 0 ? r.slice(2) : r) : r
          )}
        </li>
      );
    }

    // Empty line
    if (line.trim() === "") {
      return <br key={i} />;
    }

    // Regular text
    return (
      <p key={i} className="text-sm">
        {withBold}
      </p>
    );
  });

  return <div className="prose prose-sm max-w-none">{rendered}</div>;
}
