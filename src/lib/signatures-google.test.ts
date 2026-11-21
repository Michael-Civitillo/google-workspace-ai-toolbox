/**
 * Reading profiles and setting signatures, against the stand-in for Google.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { applySignature, getSignatureProfile, previewSignature } from "./admin-sdk";
import { DEFAULT_SIGNATURE_TEMPLATE } from "./signatures";
import { ValidationError } from "./validate";
import type { Tenant } from "./tenant-types";
import {
  ADMIN,
  googleError,
  installFakeGoogle,
  json,
  type Call,
} from "./test-support/fake-google";

const fake = installFakeGoogle();
const google = fake.google;
let tenant: Tenant;
before(() => {
  tenant = fake.tenant();
});

const BASIC = "https://www.googleapis.com/auth/gmail.settings.basic";
const SEND_AS = "/gmail/v1/users/me/settings/sendAs";
const JANE = "jane@example.com";

const DIRECTORY: Record<string, object> = {
  [JANE]: {
    primaryEmail: "Jane@Example.com",
    name: { fullName: "Jane Doe", givenName: "Jane", familyName: "Doe" },
    organizations: [
      { title: "Old job", department: "Elsewhere" },
      { title: "Head of Sales", department: "Sales", primary: true },
    ],
    phones: [
      { type: "mobile", value: "07700 900000", primary: true },
      { type: "work", value: "020 7946 0000" },
    ],
  },
  "bare@example.com": {
    primaryEmail: "bare@example.com",
    name: { fullName: "", givenName: "", familyName: "" },
  },
  "gone@example.com": {
    primaryEmail: "gone@example.com",
    name: { fullName: "Gone Person" },
    suspended: true,
  },
  "nomail@example.com": {
    primaryEmail: "nomail@example.com",
    name: { fullName: "No Mail" },
    isMailboxSetup: false,
  },
};

const JANE_HTML =
  '<div dir="ltr"><b>Jane Doe</b><br>Head of Sales<br>Sales<br>020 7946 0000<br>' +
  '<a href="mailto:jane@example.com">jane@example.com</a></div>';

/** Mailboxes: each one's send-as addresses. */
let sendAs: Record<string, Array<{ sendAsEmail: string; isPrimary?: boolean; signature?: string }>>;

const handler = (call: Call) => {
  const path = decodeURIComponent(call.url.pathname);
  if (path.startsWith("/admin/directory/v1/users/")) {
    const found = DIRECTORY[path.slice("/admin/directory/v1/users/".length).toLowerCase()];
    return found ? json(found) : googleError(404, "Resource Not Found: userKey", "notFound");
  }
  const box = sendAs[call.subject ?? ""];
  if (path === SEND_AS && call.method === "GET") {
    return box ? json({ sendAs: box }) : googleError(400, "Mail service not enabled", "failedPrecondition");
  }
  if (path.startsWith(`${SEND_AS}/`) && call.method === "PATCH") {
    const entry = box?.find((s) => s.sendAsEmail === path.slice(SEND_AS.length + 1));
    if (!entry) return googleError(404, "Not Found", "notFound");
    Object.assign(entry, call.body);
    return json(entry);
  }
  return undefined;
};

const gmailCalls = () => google.calls.filter((c) => c.url.pathname.startsWith("/gmail/"));
const writes = () => google.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  sendAs = {
    [JANE]: [
      { sendAsEmail: "sales@example.com", signature: "<div>Sales team</div>" },
      { sendAsEmail: JANE, isPrimary: true, signature: "<div>Sent from my phone</div>" },
    ],
    "bare@example.com": [{ sendAsEmail: "bare@example.com", isPrimary: true, signature: "<div>Mine</div>" }],
  };
  google.reset(handler);
});

describe("getSignatureProfile", () => {
  it("reads the person's name, primary job and work phone, as the admin", async () => {
    const { profile, suspended, mailboxSetup } = await getSignatureProfile(tenant, JANE);
    assert.deepEqual(profile, {
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      email: JANE,
      title: "Head of Sales",
      department: "Sales",
      phone: "020 7946 0000",
    });
    assert.deepEqual([suspended, mailboxSetup], [false, true]);
    assert.equal(google.calls.length, 1);
    assert.equal(google.calls[0].subject, ADMIN);
  });

  it("gives empty fields, not errors, for a profile that has nothing", async () => {
    const { profile } = await getSignatureProfile(tenant, "bare@example.com");
    assert.deepEqual(
      [profile.name, profile.title, profile.department, profile.phone],
      ["", "", "", ""]
    );
  });
});

describe("previewSignature", () => {
  it("shows what the template gives next to what the mailbox has, and writes nothing", async () => {
    const preview = await previewSignature(tenant, JANE, DEFAULT_SIGNATURE_TEMPLATE);
    assert.equal(preview.rendered.html, JANE_HTML);
    assert.equal(preview.current, "<div>Sent from my phone</div>");
    assert.equal(writes().length, 0);
  });

  it("opens the mailbox as its owner, with only the basic settings permission", async () => {
    await previewSignature(tenant, JANE, DEFAULT_SIGNATURE_TEMPLATE);
    assert.ok(gmailCalls().length > 0);
    assert.ok(gmailCalls().every((c) => c.subject === JANE));
    assert.ok(gmailCalls().every((c) => c.scopes.length === 1 && c.scopes[0] === BASIC));
  });

  it("refuses a bad template before asking Google anything", async () => {
    await assert.rejects(
      previewSignature(tenant, JANE, "{{nmae}}"),
      (e) => e instanceof ValidationError && /isn't a field/.test(e.message)
    );
    assert.equal(google.calls.length, 0);
  });
});

describe("applySignature", () => {
  it("sets the signature on the address the person sends from, and nowhere else", async () => {
    const result = await applySignature(tenant, JANE, DEFAULT_SIGNATURE_TEMPLATE);
    const [patch] = writes();
    assert.equal(writes().length, 1);
    assert.equal(patch.method, "PATCH");
    assert.equal(decodeURIComponent(patch.url.pathname), `${SEND_AS}/${JANE}`);
    assert.deepEqual(patch.body, { signature: JANE_HTML });
    assert.equal(patch.subject, JANE);
    assert.deepEqual(patch.scopes, [BASIC]);
    assert.deepEqual(result, {
      user: JANE,
      changed: true,
      previous: "<div>Sent from my phone</div>",
      html: JANE_HTML,
    });
    assert.equal(sendAs[JANE][0].signature, "<div>Sales team</div>");
  });

  it("leaves a mailbox that already has exactly this signature untouched", async () => {
    sendAs[JANE][1].signature = JANE_HTML;
    const result = await applySignature(tenant, JANE, DEFAULT_SIGNATURE_TEMPLATE);
    assert.equal(result.changed, false);
    assert.equal(writes().length, 0);
  });

  it("refuses to wipe a signature when nothing in the template applies to the person", async () => {
    await assert.rejects(
      applySignature(tenant, "bare@example.com", "{{name}}\n{{title}}\n{{phone}}"),
      (e) => e instanceof ValidationError && /left as it is/.test(e.message)
    );
    assert.equal(gmailCalls().length, 0);
    assert.equal(sendAs["bare@example.com"][0].signature, "<div>Mine</div>");
  });

  it("refuses a suspended account and one with no mailbox, without opening any mailbox", async () => {
    await assert.rejects(
      applySignature(tenant, "gone@example.com", DEFAULT_SIGNATURE_TEMPLATE),
      (e) => e instanceof ValidationError && /suspended/.test(e.message)
    );
    await assert.rejects(
      applySignature(tenant, "nomail@example.com", DEFAULT_SIGNATURE_TEMPLATE),
      (e) => e instanceof ValidationError && /no Gmail mailbox/.test(e.message)
    );
    assert.equal(gmailCalls().length, 0);
  });

  it("refuses a bad template before asking Google anything", async () => {
    await assert.rejects(
      applySignature(tenant, JANE, "{{name}} {{oops}}"),
      (e) => e instanceof ValidationError
    );
    await assert.rejects(applySignature(tenant, JANE, ""), (e) => e instanceof ValidationError);
    assert.equal(google.calls.length, 0);
  });

  it("changes nothing for an address that reaches no account", async () => {
    await assert.rejects(
      applySignature(tenant, "nobody@example.com", DEFAULT_SIGNATURE_TEMPLATE),
      /Resource Not Found/
    );
    assert.equal(writes().length, 0);
  });

  it("writes only what the rules produce, whatever the directory holds", async () => {
    DIRECTORY["sly@example.com"] = {
      primaryEmail: "sly@example.com",
      name: { fullName: '<img src=x onerror=alert(1)>' },
      organizations: [{ title: '"><script>x</script>', primary: true }],
    };
    sendAs["sly@example.com"] = [{ sendAsEmail: "sly@example.com", isPrimary: true }];
    const { html } = await applySignature(tenant, "sly@example.com", "{{name}}\n{{title}}");
    assert.equal(
      html,
      '<div dir="ltr">&lt;img src=x onerror=alert(1)&gt;<br>&quot;&gt;&lt;script&gt;x&lt;/script&gt;</div>'
    );
    assert.deepEqual(writes()[0].body, { signature: html });
  });
});
