/**
 * Who exported whose mailbox is on record: every export's first page, and a
 * request that comes in part-way once.
 */
import "./test-support/isolated-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import { before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET as exportPage } from "@/app/api/admin/mailbox-export/route";
import { AUDIT_LOG_PATH } from "./audit";
import { createSessionToken, SESSION_COOKIE_NAME } from "./auth";
import { ADMIN, installFakeGoogle, json } from "./test-support/fake-google";

const fake = installFakeGoogle();
let cookie = "";
before(async () => {
  // No tenant is set up here, so the route uses the environment's credentials.
  process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = fake.tenant().credentialsFile;
  process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL = ADMIN;
  cookie = `${SESSION_COOKIE_NAME}=${await createSessionToken()}`;
});

beforeEach(() =>
  fake.google.reset((call) => {
    const path = call.url.pathname;
    if (path === "/gmail/v1/users/me/messages") return json({ messages: [], nextPageToken: "next-page" });
    if (path === "/gmail/v1/users/me/labels") return json({ labels: [] });
    return undefined;
  })
);

const page = async (mailbox: string, extra = "") => {
  const res = await exportPage(
    new NextRequest(`http://localhost:3000/api/admin/mailbox-export?user=${mailbox}${extra}`, {
      headers: { cookie },
    })
  );
  assert.equal(res.status, 200, await res.clone().text());
};

const logged = (mailbox: string) =>
  (fs.existsSync(AUDIT_LOG_PATH) ? fs.readFileSync(AUDIT_LOG_PATH, "utf-8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { action: string; params: { user?: string; continued?: boolean } })
    .filter((e) => e.action === "mailbox_export" && e.params.user === mailbox);

describe("the mailbox export's audit entries", () => {
  it("log the start of every export, and not each of its pages", async () => {
    await page("alice@example.com");
    await page("alice@example.com", "&pageToken=next-page");
    await page("alice@example.com", "&pageToken=next-page");
    assert.equal(logged("alice@example.com").length, 1);
    // A second export of the same mailbox a few minutes later, by someone
    // else signed in with the shared password: its own entry, not silence.
    await page("alice@example.com", "&includeSpamTrash=true");
    assert.equal(logged("alice@example.com").length, 2);
  });

  it("log an export that is only ever asked for part-way, once", async () => {
    await page("bob@example.com", "&pageToken=next-page");
    await page("bob@example.com", "&pageToken=next-page");
    const entries = logged("bob@example.com");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].params.continued, true);
  });
});
