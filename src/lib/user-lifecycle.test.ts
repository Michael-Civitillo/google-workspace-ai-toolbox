/**
 * Creating accounts and resetting passwords, against the stand-in for Google.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  createUser,
  generateTemporaryPassword,
  NoSuchAccountError,
  resetUserPassword,
  TEMP_PASSWORD_LENGTH,
  UserAlreadyExistsError,
} from "./admin-sdk";
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

const DOMAINS = {
  domains: [
    {
      domainName: "example.com",
      isPrimary: true,
      verified: true,
      domainAliases: [{ domainAliasName: "example.net", verified: true }],
    },
    { domainName: "pending.example", isPrimary: false, verified: false },
  ],
};

/** Accounts that exist, by any address that reaches them. */
const USERS: Record<string, { primaryEmail: string; suspended?: boolean }> = {
  "taken@example.com": { primaryEmail: "taken@example.com" },
  "nick@example.com": { primaryEmail: "nicola@example.com" },
  "nicola@example.com": { primaryEmail: "nicola@example.com" },
  "gone@example.com": { primaryEmail: "gone@example.com", suspended: true },
  [ADMIN]: { primaryEmail: ADMIN },
  "boss@example.com": { primaryEmail: ADMIN },
};

const USERS_PATH = "/admin/directory/v1/users";

/** The directory, with `write` deciding what a create or update answers. */
const directory =
  (write: (call: Call) => Response = (call) => json(call.body)) =>
  (call: Call) => {
    const path = decodeURIComponent(call.url.pathname);
    if (path.endsWith("/customer/my_customer/domains")) return json(DOMAINS);
    if (call.method === "GET" && path.startsWith(`${USERS_PATH}/`)) {
      const found = USERS[path.slice(USERS_PATH.length + 1).toLowerCase()];
      return found
        ? json({ ...found, name: { fullName: "Someone" } })
        : googleError(404, "Resource Not Found: userKey", "notFound");
    }
    if (call.method === "POST" && path === USERS_PATH) return write(call);
    if (call.method === "PUT" && path.startsWith(`${USERS_PATH}/`)) return write(call);
    return undefined;
  };

const writes = () => google.calls.filter((c) => c.method !== "GET");

beforeEach(() => google.reset(directory()));

describe("generateTemporaryPassword", () => {
  it("is long, typeable, and passes any complexity rule", () => {
    for (let i = 0; i < 500; i++) {
      const password = generateTemporaryPassword();
      assert.equal(password.length, TEMP_PASSWORD_LENGTH);
      assert.match(password, /[A-Z]/);
      assert.match(password, /[a-z]/);
      assert.match(password, /[0-9]/);
      assert.match(password, /[-_.!?]/);
      // Nothing that is misread off a screen or misheard on a call.
      assert.doesNotMatch(password, /[0O1lI]/);
      assert.match(password, /^[A-Za-z0-9\-_.!?]+$/);
    }
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    assert.equal(seen.size, 200);
  });

  it("doesn't always put the guaranteed characters in the same places", () => {
    const firstIsUpper = Array.from({ length: 200 }, () =>
      /[A-Z]/.test(generateTemporaryPassword()[0])
    );
    assert.ok(firstIsUpper.includes(true) && firstIsUpper.includes(false));
  });

  it("takes all its randomness from the source it is given", () => {
    const fixed = () => generateTemporaryPassword(() => 0);
    assert.equal(fixed(), fixed());
  });
});

describe("createUser", () => {
  const jane = {
    givenName: " Jane ",
    familyName: "Doe",
    primaryEmail: "Jane.Doe@Example.com",
  };

  it("creates the account as the admin, with a password that must be changed", async () => {
    const created = await createUser(tenant, jane);
    const [insert] = writes();
    assert.equal(writes().length, 1);
    assert.equal(insert.method, "POST");
    assert.equal(insert.url.pathname, USERS_PATH);
    assert.equal(insert.subject, ADMIN);
    assert.deepEqual(insert.body, {
      primaryEmail: "jane.doe@example.com",
      name: { givenName: "Jane", familyName: "Doe" },
      password: created.temporaryPassword,
      changePasswordAtNextLogin: true,
      orgUnitPath: "/",
    });
    assert.equal(created.primaryEmail, "jane.doe@example.com");
    assert.equal(created.orgUnitPath, "/");
    assert.equal(created.temporaryPassword.length, TEMP_PASSWORD_LENGTH);
  });

  it("puts the account in the organisational unit asked for", async () => {
    const created = await createUser(tenant, { ...jane, orgUnitPath: " /Sales/EMEA/ " });
    assert.equal(created.orgUnitPath, "/Sales/EMEA");
    assert.equal((writes()[0].body as { orgUnitPath: string }).orgUnitPath, "/Sales/EMEA");
  });

  it("refuses an organisational unit that isn't a path", async () => {
    await assert.rejects(
      createUser(tenant, { ...jane, orgUnitPath: "Sales" }),
      (e) => e instanceof ValidationError && /must start with "\/"/.test(e.message)
    );
    assert.equal(google.calls.length, 0);
  });

  it("refuses an address that already reaches an account, primary or alias", async () => {
    for (const primaryEmail of ["taken@example.com", "NICK@example.com"]) {
      await assert.rejects(
        createUser(tenant, { ...jane, primaryEmail }),
        (e) => e instanceof UserAlreadyExistsError
      );
    }
    assert.equal(writes().length, 0);
  });

  it("refuses a domain alias, an unverified domain, and someone else's domain", async () => {
    const refused: Array<[string, RegExp]> = [
      ["jane@example.net", /domain alias/],
      ["jane@pending.example", /not a verified domain/],
      ["jane@elsewhere.org", /not a verified domain/],
    ];
    for (const [primaryEmail, why] of refused) {
      await assert.rejects(
        createUser(tenant, { ...jane, primaryEmail }),
        (e) => e instanceof ValidationError && why.test(e.message)
      );
    }
    assert.equal(writes().length, 0);
  });

  it("refuses a missing, overlong or control-character name before asking Google anything", async () => {
    for (const bad of ["", "   ", "x".repeat(61), "Jane\u0000", "Ja\nne"]) {
      await assert.rejects(
        createUser(tenant, { ...jane, givenName: bad }),
        (e) => e instanceof ValidationError
      );
      await assert.rejects(
        createUser(tenant, { ...jane, familyName: bad }),
        (e) => e instanceof ValidationError
      );
    }
    assert.equal(google.calls.length, 0);
  });

  it("never tries a second time when Google fails: the first may have gone through", async () => {
    google.reset(directory(() => googleError(503, "Backend Error", "backendError")));
    await assert.rejects(createUser(tenant, jane), /Backend Error/);
    assert.equal(writes().length, 1);
  });

  it("hands back Google's own refusal, such as no licences left", async () => {
    google.reset(
      directory(() => googleError(412, "Domain user limit reached.", "limitExceeded"))
    );
    await assert.rejects(createUser(tenant, jane), /Domain user limit reached/);
    assert.equal(writes().length, 1);
  });
});

describe("resetUserPassword", () => {
  it("sets a new password that must be changed, on the account's primary address", async () => {
    const result = await resetUserPassword(tenant, "Nick@example.com");
    const [update] = writes();
    assert.equal(writes().length, 1);
    assert.equal(update.method, "PUT");
    assert.equal(decodeURIComponent(update.url.pathname), `${USERS_PATH}/nicola@example.com`);
    assert.equal(update.subject, ADMIN);
    assert.deepEqual(update.body, {
      password: result.temporaryPassword,
      changePasswordAtNextLogin: true,
    });
    assert.equal(result.primaryEmail, "nicola@example.com");
    assert.equal(result.temporaryPassword.length, TEMP_PASSWORD_LENGTH);
  });

  it("refuses the admin account it acts as, by primary address or alias", async () => {
    for (const address of [ADMIN, "boss@example.com"]) {
      await assert.rejects(
        resetUserPassword(tenant, address),
        (e) => e instanceof ValidationError && /acts as/.test(e.message)
      );
    }
    assert.equal(writes().length, 0);
  });

  it("refuses a suspended account, where a new password lets nobody in", async () => {
    await assert.rejects(
      resetUserPassword(tenant, "gone@example.com"),
      (e) => e instanceof ValidationError && /suspended/.test(e.message)
    );
    assert.equal(writes().length, 0);
  });

  it("changes nothing for an address that reaches no account", async () => {
    await assert.rejects(
      resetUserPassword(tenant, "Nobody@example.com"),
      (e) =>
        e instanceof NoSuchAccountError &&
        e.message === "There is no account with the address nobody@example.com."
    );
    assert.equal(writes().length, 0);
  });

  it("refuses something that isn't an email address without asking Google", async () => {
    await assert.rejects(
      resetUserPassword(tenant, "not an address"),
      (e) => e instanceof ValidationError
    );
    assert.equal(google.calls.length, 0);
  });
});
