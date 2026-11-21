/**
 * The one list of permissions. These tests are what keep it the one list: the
 * library must not ask Google for a scope the setup pages don't tell the
 * operator to authorise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { REQUIRED_APIS, REQUIRED_SCOPES } from "./required-scopes";
import { usedScopes } from "./preflight";

const SRC = path.resolve(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe("REQUIRED_SCOPES", () => {
  it("lists each scope once, with a name and what it is for", () => {
    const scopes = REQUIRED_SCOPES.map((s) => s.scope);
    assert.equal(new Set(scopes).size, scopes.length);
    for (const s of REQUIRED_SCOPES) {
      assert.match(s.scope, /^https:\/\/(www\.googleapis\.com\/auth\/[a-z._]+|mail\.google\.com\/)$/);
      assert.ok(s.label.length > 2 && s.feature.length > 5, s.scope);
    }
  });

  it("is exactly what the scope check asks Google about", () => {
    assert.deepEqual(usedScopes(), REQUIRED_SCOPES.map((s) => s.scope));
  });

  it("covers every scope the app's own code asks for", () => {
    // Any Google scope written out in the source that isn't on the list is a
    // feature whose permission nobody is told to authorise.
    const listed = new Set(REQUIRED_SCOPES.map((s) => s.scope));
    // Scopes the app names without ever requesting: the ones it tests its own
    // key for NOT having, and the names it shows for other apps' access.
    const namedOnly = new Set([
      path.join(SRC, "lib", "preflight.ts"),
      path.join(SRC, "lib", "security-check.ts"),
    ]);
    const missing = new Map<string, string>();
    for (const file of sourceFiles(SRC)) {
      if (namedOnly.has(file)) continue;
      const text = fs.readFileSync(file, "utf-8");
      for (const [scope] of text.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z._]+/g)) {
        if (!listed.has(scope)) missing.set(scope, path.relative(SRC, file));
      }
    }
    assert.deepEqual([...missing], []);
  });

  it("no page keeps a list of its own", () => {
    for (const page of ["app/setup/page.tsx", "app/onboarding/page.tsx"]) {
      const text = fs.readFileSync(path.join(SRC, page), "utf-8");
      assert.ok(text.includes("@/lib/required-scopes"), page);
      assert.doesNotMatch(text, /googleapis\.com\/auth\//, page);
    }
  });
});

describe("REQUIRED_APIS", () => {
  it("includes the API each family of scopes belongs to", () => {
    const names = REQUIRED_APIS.map((a) => a.name);
    assert.equal(new Set(names).size, names.length);
    for (const needed of ["Gmail API", "Google Calendar API", "Admin SDK API", "Google Drive API", "Enterprise License Manager API"]) {
      assert.ok(names.includes(needed), needed);
    }
  });
});
