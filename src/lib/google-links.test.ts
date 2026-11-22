import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleLink } from "./google-links";

describe("googleLink", () => {
  it("keeps Drive and Docs addresses", () => {
    for (const url of [
      "https://drive.google.com/file/d/abc/view?usp=drivesdk",
      "https://docs.google.com/document/d/abc/edit",
      "https://google.com/x",
    ]) {
      assert.equal(googleLink(url), url);
    }
  });

  it("drops anything that isn't Google over HTTPS", () => {
    for (const url of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "http://docs.google.com/document/d/abc",
      "https://docs.google.com.evil.example/x",
      "https://evilgoogle.com/x",
      "https://google.com@evil.example/x",
      "not a url",
    ]) {
      assert.equal(googleLink(url), null, String(url));
    }
  });
});
