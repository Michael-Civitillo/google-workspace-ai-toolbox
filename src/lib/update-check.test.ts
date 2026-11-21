/**
 * The update check, with a made-up release server.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  clearUpdateCheck,
  fetchLatestRelease,
  isNewer,
  latestRelease,
  parseVersion,
  RELEASES_PAGE,
  REPOSITORY,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_CHECK_TTL_MS,
  updateCheckUrl,
} from "./update-check";

const release = (tag: string, html = `https://github.com/${REPOSITORY}/releases/tag/${tag}`) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: html, body: "notes" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

interface Seen {
  url: string;
  init: RequestInit;
}
const server = (answer: () => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answer();
  };
  return { seen, fetchImpl };
};

describe("parseVersion and isNewer", () => {
  it("reads release tags with or without the v", () => {
    assert.deepEqual(parseVersion("v0.3.0"), [0, 3, 0]);
    assert.deepEqual(parseVersion("12.0.7"), [12, 0, 7]);
    assert.deepEqual(parseVersion(" v1.2.3 "), [1, 2, 3]);
  });

  it("refuses anything that isn't a plain release number", () => {
    for (const bad of ["", "latest", "v1.2", "1.2.3.4", "v1.2.3-beta", "v1.2.x", "1.2.3; rm -rf", null, 3, "v999999.0.0"]) {
      assert.equal(parseVersion(bad), null, String(bad));
    }
  });

  it("compares by number, not by text", () => {
    assert.ok(isNewer([0, 10, 0], [0, 9, 9]));
    assert.ok(isNewer([1, 0, 0], [0, 99, 99]));
    assert.ok(isNewer([0, 3, 1], [0, 3, 0]));
    assert.ok(!isNewer([0, 3, 0], [0, 3, 0]));
    assert.ok(!isNewer([0, 2, 9], [0, 3, 0]));
  });
});

describe("fetchLatestRelease", () => {
  it("says when a newer release is out, and where", async () => {
    const { fetchImpl } = server(() => release("v0.4.0"));
    const result = await fetchLatestRelease({ currentVersion: "0.3.0", fetchImpl, now: 0 });
    assert.deepEqual(result, {
      latest: "0.4.0",
      updateAvailable: true,
      url: `https://github.com/${REPOSITORY}/releases/tag/v0.4.0`,
      checkedAt: "1970-01-01T00:00:00.000Z",
      error: null,
    });
  });

  it("says nothing is newer when running the latest, or something ahead of it", async () => {
    for (const current of ["0.4.0", "0.5.0"]) {
      const { fetchImpl } = server(() => release("v0.4.0"));
      const result = await fetchLatestRelease({ currentVersion: current, fetchImpl });
      assert.equal(result.updateAvailable, false);
      assert.equal(result.latest, "0.4.0");
      assert.equal(result.error, null);
    }
  });

  it("asks one fixed address and sends nothing about who is asking", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    await fetchLatestRelease({ currentVersion: "0.3.0", fetchImpl });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `https://api.github.com/repos/${REPOSITORY}/releases/latest`);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[0].init.body, undefined);
    assert.deepEqual(seen[0].init.headers, {
      accept: "application/vnd.github+json",
      "user-agent": "open-admin-update-check",
    });
    // Following a redirect could take the request, or the link shown, elsewhere.
    assert.equal(seen[0].init.redirect, "error");
  });

  it("never passes on a link that isn't this project's release page", async () => {
    for (const html of [
      "https://evil.example/download.exe",
      "https://github.com/someone-else/fork/releases/tag/v9.9.9",
      `https://github.com/${REPOSITORY}/releases/tag/v9" onclick="x`,
      "javascript:alert(1)",
      42 as unknown as string,
    ]) {
      const { fetchImpl } = server(() => release("v9.9.9", html));
      const result = await fetchLatestRelease({ currentVersion: "0.3.0", fetchImpl });
      assert.equal(result.url, RELEASES_PAGE, String(html));
      assert.equal(result.updateAvailable, true);
    }
  });

  it("reports a failure as a result, whatever goes wrong", async () => {
    const cases: Array<[() => Response | Promise<Response>, RegExp]> = [
      [() => new Response("{}", { status: 404 }), /No published release/],
      [() => new Response("{}", { status: 403 }), /limiting requests/],
      [() => new Response("{}", { status: 500 }), /answered 500/],
      [() => new Response("<html>not json", { status: 200 }), /could not be read/],
      [() => new Response(JSON.stringify({ tag_name: "nightly" }), { status: 200 }), /no usable version/],
      [() => new Response(JSON.stringify(null), { status: 200 }), /no usable version/],
      [() => new Response("x".repeat(300_001), { status: 200 }), /too large/],
      [() => Promise.reject(new Error("getaddrinfo ENOTFOUND")), /could not be reached: getaddrinfo ENOTFOUND/],
    ];
    for (const [answer, message] of cases) {
      const { fetchImpl } = server(answer);
      const result = await fetchLatestRelease({ currentVersion: "0.3.0", fetchImpl });
      assert.match(result.error ?? "", message);
      assert.equal(result.updateAvailable, false);
      assert.equal(result.latest, null);
      assert.equal(result.url, RELEASES_PAGE);
    }
  });

  it("doesn't ask at all when the build has no version to compare", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    const result = await fetchLatestRelease({ currentVersion: "dev", fetchImpl });
    assert.match(result.error ?? "", /no usable version number/);
    assert.equal(seen.length, 0);
  });
});

describe("latestRelease", () => {
  beforeEach(() => clearUpdateCheck());
  const HOUR = 60 * 60 * 1000;

  it("asks once and reuses the answer for half a day", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    const opts = { fetchImpl, currentVersion: "0.3.0" };
    await latestRelease({ ...opts, now: 0 });
    await latestRelease({ ...opts, now: UPDATE_CHECK_TTL_MS - 1 });
    assert.equal(seen.length, 1);
    await latestRelease({ ...opts, now: UPDATE_CHECK_TTL_MS + 1 });
    assert.equal(seen.length, 2);
  });

  it("tries again sooner after a failure, but not on every page", async () => {
    const { seen, fetchImpl } = server(() => new Response("{}", { status: 500 }));
    const opts = { fetchImpl, currentVersion: "0.3.0" };
    await latestRelease({ ...opts, now: 0 });
    await latestRelease({ ...opts, now: UPDATE_CHECK_RETRY_MS - 1 });
    assert.equal(seen.length, 1);
    await latestRelease({ ...opts, now: UPDATE_CHECK_RETRY_MS + 1 });
    assert.equal(seen.length, 2);
  });

  it("asks now when told to", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    const opts = { fetchImpl, currentVersion: "0.3.0" };
    await latestRelease({ ...opts, now: 0 });
    await latestRelease({ ...opts, now: HOUR, force: true });
    assert.equal(seen.length, 2);
  });

  it("shares one request between callers that arrive together", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    const opts = { fetchImpl, currentVersion: "0.3.0", now: 0 };
    const results = await Promise.all([latestRelease(opts), latestRelease(opts), latestRelease(opts)]);
    assert.equal(seen.length, 1);
    assert.ok(results.every((r) => r.latest === "0.4.0"));
  });

  it("forgets the answer when cleared", async () => {
    const { seen, fetchImpl } = server(() => release("v0.4.0"));
    const opts = { fetchImpl, currentVersion: "0.3.0", now: 0 };
    await latestRelease(opts);
    clearUpdateCheck();
    await latestRelease(opts);
    assert.equal(seen.length, 2);
  });
});

describe("updateCheckUrl", () => {
  it("is GitHub's unless a mirror is configured", () => {
    assert.equal(updateCheckUrl({}), `https://api.github.com/repos/${REPOSITORY}/releases/latest`);
    assert.equal(
      updateCheckUrl({ OPEN_ADMIN_UPDATE_URL: " https://mirror.internal/open-admin/latest.json " }),
      "https://mirror.internal/open-admin/latest.json"
    );
  });

  it("ignores a setting that isn't a web address", () => {
    for (const bad of ["", "   ", "file:///etc/passwd", "mirror.internal/latest"]) {
      assert.equal(
        updateCheckUrl({ OPEN_ADMIN_UPDATE_URL: bad }),
        `https://api.github.com/repos/${REPOSITORY}/releases/latest`
      );
    }
  });
});
