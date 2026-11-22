/**
 * The Bulk Operations rules: what a row must look like, and the exact request
 * it becomes. The requests matter most. Each goes to a route that changes a
 * real account, so a wrong field here is a wrong change there.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmPhraseFor,
  duplicateRows,
  OPERATIONS,
  parseCsv,
  type OperationId,
} from "./bulk-operations";

const A = "alice@example.com";
const B = "bob@example.com";
const G = "staff@example.com";

describe("every operation", () => {
  const ids = Object.keys(OPERATIONS) as OperationId[];

  it("refuses an empty row, a row of junk, and a row with no @", () => {
    for (const id of ids) {
      const { validateRow } = OPERATIONS[id];
      for (const bad of [[], [""], ["", ""], ["not-an-email", "also not"], ["alice", "bob"]]) {
        assert.notEqual(validateRow(bad), null, `${id} accepted ${JSON.stringify(bad)}`);
      }
    }
  });

  it("accepts its own example row and turns it into a request", () => {
    for (const id of ids) {
      const def = OPERATIONS[id];
      const [cells] = parseCsv(def.example);
      assert.equal(def.validateRow(cells), null, `${id}: ${def.example}`);
      const body = def.toBody(cells);
      assert.ok(Object.values(body).every((v) => typeof v === "string" && v !== ""), id);
    }
  });

  it("skips its own header row the way the page does: by the first column's name", () => {
    for (const id of ids) {
      const def = OPERATIONS[id];
      const header = def.columns.map((c) => c.split(" ")[0]).join(",");
      const [first] = parseCsv(`${header}\n${def.example}`);
      assert.equal(first[0].toLowerCase(), def.columns[0].toLowerCase(), id);
    }
  });

  it("has a confirmation phrase that names the count", () => {
    for (const id of ids) {
      assert.match(confirmPhraseFor(OPERATIONS[id], 7), /^[A-Z]+ 7$/, id);
    }
  });
});

describe("the operations that take something away name themselves in the phrase", () => {
  it("suspend, remove from group and re-enable don't start on a generic RUN", () => {
    assert.equal(confirmPhraseFor(OPERATIONS.suspend, 12), "SUSPEND 12");
    assert.equal(confirmPhraseFor(OPERATIONS.group_remove, 3), "REMOVE 3");
    assert.equal(confirmPhraseFor(OPERATIONS.unsuspend, 12), "ENABLE 12");
    assert.equal(confirmPhraseFor(OPERATIONS.group_add, 3), "RUN 3");
  });

  it("each carries a warning for the confirmation dialog", () => {
    for (const id of ["suspend", "unsuspend", "group_remove"] as const) {
      assert.ok((OPERATIONS[id].warning ?? "").length > 20, id);
    }
  });
});

describe("group_add", () => {
  const op = OPERATIONS.group_add;

  it("adds an ordinary member without naming a role, so nobody already in is demoted", () => {
    assert.equal(op.validateRow([G, A]), null);
    assert.deepEqual(op.toBody([G, A]), { group: G, member: A });
    assert.deepEqual(op.toBody([G, A, ""]), { group: G, member: A });
  });

  it("sends a role in the spelling the API wants, however it was typed", () => {
    assert.equal(op.validateRow([G, A, "manager"]), null);
    assert.deepEqual(op.toBody([G, A, "manager"]), { group: G, member: A, role: "MANAGER" });
    // An owner also carries the confirmation the route asks for: the run's
    // own typed phrase stands for it.
    assert.deepEqual(op.toBody([G, A, " Owner "]), { group: G, member: A, role: "OWNER", confirm: A });
  });

  it("refuses a role that isn't one", () => {
    assert.match(op.validateRow([G, A, "admin"]) ?? "", /MEMBER, MANAGER, OWNER/);
  });

  it("refuses a group added to itself", () => {
    assert.match(op.validateRow([G, G.toUpperCase()]) ?? "", /must be different/);
  });
});

describe("group_remove", () => {
  it("repeats the member as the confirmation the route insists on", () => {
    assert.deepEqual(OPERATIONS.group_remove.toBody([G, A]), {
      group: G,
      member: A,
      confirm: A,
    });
    assert.equal(OPERATIONS.group_remove.method, "DELETE");
  });
});

describe("calendar_share", () => {
  const op = OPERATIONS.calendar_share;

  it("shares read-only unless told otherwise", () => {
    assert.deepEqual(op.toBody([A, B]), { calendarId: A, delegateEmail: B, role: "reader" });
  });

  it("accepts the three roles in any letter case, in the API's spelling", () => {
    for (const [typed, sent] of [
      ["freebusyreader", "freeBusyReader"],
      ["READER", "reader"],
      ["Writer", "writer"],
    ]) {
      assert.equal(op.validateRow([A, B, typed]), null);
      assert.equal(op.toBody([A, B, typed]).role, sent);
    }
  });

  it("never hands over ownership in bulk, and says where to do it", () => {
    for (const owner of ["owner", "OWNER", " Owner "]) {
      assert.match(op.validateRow([A, B, owner]) ?? "", /Calendar Delegation page/);
    }
  });

  it("refuses a role that isn't one", () => {
    assert.match(op.validateRow([A, B, "editor"]) ?? "", /freeBusyReader, reader, writer/);
  });
});

describe("suspend and unsuspend", () => {
  it("suspend goes through the offboarding step, confirmed with the account's own address", () => {
    assert.deepEqual(OPERATIONS.suspend.toBody([A]), { step: "suspend", user: A, confirm: A });
    assert.equal(OPERATIONS.suspend.endpoint, "/api/offboarding/step");
  });

  it("unsuspend is confirmed the same way", () => {
    assert.deepEqual(OPERATIONS.unsuspend.toBody([A]), { user: A, confirm: A });
    assert.equal(OPERATIONS.unsuspend.endpoint, "/api/admin/user/unsuspend");
  });

  it("refuse a row with a second column: that file was made for something else", () => {
    for (const id of ["suspend", "unsuspend"] as const) {
      assert.equal(OPERATIONS[id].validateRow([A]), null);
      assert.equal(OPERATIONS[id].validateRow([A, ""]), null);
      assert.match(OPERATIONS[id].validateRow([A, B]) ?? "", /only one column/);
      assert.match(OPERATIONS[id].validateRow([G, A, "MEMBER"]) ?? "", /only one column/);
    }
  });
});

describe("set_forwarding", () => {
  const op = OPERATIONS.set_forwarding;

  it("keeps originals unless told otherwise", () => {
    assert.deepEqual(op.toBody([A, B]), { sourceUser: A, targetUser: B, action: "keep" });
    assert.deepEqual(op.toBody([A, B, "trash"]), { sourceUser: A, targetUser: B, action: "trash" });
  });

  it("refuses an action that isn't one", () => {
    assert.match(op.validateRow([A, B, "delete"]) ?? "", /keep, archive, trash, markRead/);
  });
});

describe("duplicateRows", () => {
  it("marks the repeats and leaves the first of each", () => {
    const rows = parseCsv(`${A}\n${B}\n${A.toUpperCase()}\n${A}`);
    assert.deepEqual([...duplicateRows(rows, OPERATIONS.suspend)], [2, 3]);
  });

  it("treats a different role as a different row", () => {
    const rows = parseCsv(`${G},${A}\n${G},${A},OWNER\n${G},${A},owner`);
    assert.deepEqual([...duplicateRows(rows, OPERATIONS.group_add)], [2]);
  });

  it("treats a defaulted value and the same value written out as one row", () => {
    const rows = parseCsv(`${A},${B}\n${A},${B},reader`);
    assert.deepEqual([...duplicateRows(rows, OPERATIONS.calendar_share)], [1]);
  });

  it("ignores rows that are invalid anyway", () => {
    const rows = parseCsv(`nope\nnope\n${A}`);
    assert.equal(duplicateRows(rows, OPERATIONS.suspend).size, 0);
  });
});

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes, commas in quotes and every line ending", () => {
    assert.deepEqual(parseCsv('a,b\r\n"c,1","d ""x"""\rE , f\n\n'), [
      ["a", "b"],
      ["c,1", 'd "x"'],
      ["E", "f"],
    ]);
  });

  it("drops rows that are entirely empty", () => {
    assert.deepEqual(parseCsv("\n,\n ,  \nx\n"), [["x"]]);
  });
});
