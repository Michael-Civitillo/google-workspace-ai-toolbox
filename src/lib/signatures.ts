/**
 * Email signatures from a template.
 *
 * The operator writes a few plain lines with placeholders such as {{name}}
 * and {{title}}; each person's signature is those lines filled in from their
 * own directory profile. This module is the rules: which placeholders exist,
 * how a template is checked, and how it becomes the HTML Gmail stores.
 *
 * Everything a profile contributes is escaped, and the only markup produced
 * is the handful of tags written out below, so nothing typed into a
 * directory field (or a template) can put markup of its own into anyone's
 * mail. No Node imports and no network: the page and the tests share it.
 */

export interface SignatureProfile {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  department: string;
  phone: string;
}

export const SIGNATURE_FIELDS: ReadonlyArray<{
  key: keyof SignatureProfile;
  label: string;
}> = [
  { key: "name", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "title", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email address" },
];

export const DEFAULT_SIGNATURE_TEMPLATE =
  "**{{name}}**\n{{title}}\n{{department}}\n{{phone}}\n{{email}}";

/** Gmail's own limit on a signature is 10,000 characters of HTML. */
export const SIGNATURE_TEMPLATE_MAX = 2000;
export const SIGNATURE_HTML_MAX = 10_000;

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
const FIELD_KEYS = new Set<string>(SIGNATURE_FIELDS.map((f) => f.key));

/**
 * What is wrong with a template, or null. A placeholder that doesn't exist is
 * refused rather than left in: "{{tittle}}" would otherwise be written,
 * braces and all, into every mailbox the template is applied to.
 */
export function templateProblem(template: unknown): string | null {
  if (typeof template !== "string" || !template.trim()) {
    return "The template is empty.";
  }
  if (template.length > SIGNATURE_TEMPLATE_MAX) {
    return `The template is too long (${template.length} characters; the limit is ${SIGNATURE_TEMPLATE_MAX}).`;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(template)) {
    return "The template contains control characters.";
  }
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!FIELD_KEYS.has(match[1])) {
      return `{{${match[1]}}} isn't a field. Use one of: ${SIGNATURE_FIELDS.map((f) => `{{${f.key}}}`).join(", ")}.`;
    }
  }
  // Braces that didn't parse as a placeholder: "{{ name }" or "{{first name}}".
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, ""))) {
    return "There is a {{ or }} that isn't part of a field. Fields look like {{name}}.";
  }
  return null;
}

/** One run of text in a rendered line. */
export interface SignaturePart {
  text: string;
  bold?: boolean;
  /** Present when the text is a web or email address. */
  href?: string;
}

export interface RenderedSignature {
  /** What Gmail is given. */
  html: string;
  /** The same thing as data, so a page can draw it without injecting HTML. */
  lines: SignaturePart[][];
  /** Fields the template uses that this person has nothing for. */
  missing: string[];
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Addresses worth linking. Deliberately narrow: http(s) and plain emails only,
// so nothing typed into a profile can become a javascript: or data: link.
const LINKABLE =
  /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

function linkify(text: string, bold: boolean): SignaturePart[] {
  const parts: SignaturePart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINKABLE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), ...(bold ? { bold } : {}) });
    parts.push({
      text: match[0],
      href: match[1] ? match[0] : `mailto:${match[0]}`,
      ...(bold ? { bold } : {}),
    });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), ...(bold ? { bold } : {}) });
  return parts;
}

/** Split a filled-in line on **bold** markers, then find the addresses in it. */
function parseLine(line: string): SignaturePart[] {
  const parts: SignaturePart[] = [];
  const segments = line.split(/\*\*(.+?)\*\*/g);
  segments.forEach((segment, i) => {
    if (segment) parts.push(...linkify(segment, i % 2 === 1));
  });
  return parts;
}

function partHtml(part: SignaturePart): string {
  let html = escapeHtml(part.text);
  if (part.href) html = `<a href="${escapeHtml(part.href)}">${html}</a>`;
  if (part.bold) html = `<b>${html}</b>`;
  return html;
}

/**
 * Fill a template in for one person.
 *
 * A line that has fields, all of them empty for this person, is left out:
 * someone with no phone number gets no blank "Phone:" line. A line with no
 * fields is always kept. Blank lines are kept as typed, except that leaving a
 * line out never leaves two blank lines in a row or a blank first or last
 * line.
 */
export function renderSignature(template: string, profile: SignatureProfile): RenderedSignature {
  const missing = new Set<string>();
  const kept: string[] = [];
  for (const raw of template.replace(/\r\n?/g, "\n").split("\n")) {
    const fields = [...raw.matchAll(PLACEHOLDER)].map((m) => m[1] as keyof SignatureProfile);
    for (const f of fields) if (!String(profile[f] ?? "").trim()) missing.add(f);
    if (fields.length > 0 && fields.every((f) => !String(profile[f] ?? "").trim())) continue;
    kept.push(
      raw
        .replace(PLACEHOLDER, (_, key: keyof SignatureProfile) =>
          // A value is one line of text, whatever the directory holds.
          String(profile[key] ?? "").replace(/\s+/g, " ").trim()
        )
        // Also the space an empty field leaves at the start: "{{title}} {{name}}".
        .trim()
    );
  }
  const tidy: string[] = [];
  for (const line of kept) {
    const blank = line.trim() === "";
    if (blank && (tidy.length === 0 || tidy[tidy.length - 1].trim() === "")) continue;
    tidy.push(line);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].trim() === "") tidy.pop();

  const lines = tidy.map(parseLine);
  const html = lines.length
    ? `<div dir="ltr">${lines.map((line) => line.map(partHtml).join("")).join("<br>")}</div>`
    : "";
  return { html, lines, missing: [...missing] };
}

/**
 * An existing signature as plain text, for showing what is about to be
 * replaced. It was written by someone else (or by another tool), so it is
 * never rendered as HTML here: tags are dropped, not interpreted.
 */
export function signatureToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(div|p|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
