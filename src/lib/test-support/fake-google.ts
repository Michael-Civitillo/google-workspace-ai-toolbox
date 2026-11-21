/**
 * A stand-in for Google, for tests that call the real library code.
 *
 * The functions under test run unchanged, with a real (throwaway)
 * service-account key; only the network is replaced. That exercises what
 * tests of pure rules cannot: which endpoints are called, as whom, with which
 * scope, and what happens when Google refuses.
 *
 * It is installed as `window.fetch` because that is the one hook the Google
 * HTTP client (gaxios) offers without changing production code: it uses
 * `window.fetch` when a `window` exists and its own bundled fetch otherwise.
 *
 * Test-only: nothing in the app imports this file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";
import type { Tenant } from "../tenant-types";

export const ADMIN = "admin@example.com";
export const SERVICE_ACCOUNT_CLIENT_ID = "100200300400500600700";

export interface Call {
  method: string;
  url: URL;
  /** The parsed JSON body of a write, when there is one. */
  body: unknown;
  /** Who the access token on this request was minted for. */
  subject: string | null;
  /** The scopes that token was minted with. */
  scopes: string[];
}

export type Handler = (call: Call) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A Google-shaped error body. */
export const googleError = (status: number, message: string, reason: string) =>
  json({ error: { code: status, message, errors: [{ message, reason }] } }, status);

export class FakeGoogle {
  calls: Call[] = [];
  /** Token grants seen: who was impersonated, with which scopes. */
  grants: Array<{ subject: string; scopes: string[] }> = [];
  /**
   * Scopes this "tenant" has not authorised for the service account. Asking
   * for a token that includes one is refused the way Google refuses it.
   */
  unauthorizedScopes = new Set<string>();
  /** Makes every token request fail in some other way (a network fault, say). */
  tokenFailure: (() => Response) | null = null;
  private tokens = new Map<string, { subject: string; scopes: string[] }>();
  handler: Handler = () => undefined;

  reset(handler: Handler): void {
    this.calls = [];
    this.grants = [];
    this.unauthorizedScopes = new Set();
    this.tokenFailure = null;
    this.handler = handler;
  }

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (init.signal?.aborted) {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    }

    if (url.host === "oauth2.googleapis.com" || url.pathname.endsWith("/token")) {
      if (this.tokenFailure) return this.tokenFailure();
      const assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      const claims = JSON.parse(
        Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf-8")
      ) as { sub: string; scope: string };
      const grant = { subject: claims.sub, scopes: claims.scope.split(" ").sort() };
      if (grant.scopes.some((scope) => this.unauthorizedScopes.has(scope))) {
        return json(
          {
            error: "unauthorized_client",
            error_description:
              "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.",
          },
          401
        );
      }
      this.grants.push(grant);
      const token = `token-${this.tokens.size + 1}`;
      this.tokens.set(token, grant);
      return json({ access_token: token, expires_in: 3600, token_type: "Bearer" });
    }

    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /i, "");
    const grant = bearer ? this.tokens.get(bearer) : undefined;
    let parsedBody: unknown = null;
    if (init.body !== undefined && init.body !== null) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = String(init.body);
      }
    }
    const call: Call = {
      method,
      url,
      body: parsedBody,
      subject: grant?.subject ?? null,
      scopes: grant?.scopes ?? [],
    };
    this.calls.push(call);
    const response = await this.handler(call);
    if (!response) {
      return googleError(404, `no fake for ${method} ${url.pathname}`, "notFound");
    }
    return response;
  };

  callsTo(pathSuffix: string): Call[] {
    return this.calls.filter((c) => c.url.pathname.endsWith(pathSuffix));
  }
}

/**
 * Install the stand-in for the whole test file and make a tenant whose key
 * file is real enough to sign with. Call once, at the top level of a test
 * file; `tenant()` is valid from the first `before` hook onwards.
 */
export function installFakeGoogle(): { google: FakeGoogle; tenant: () => Tenant } {
  const google = new FakeGoogle();
  let tmpDir = "";
  let tenant: Tenant | null = null;

  before(() => {
    (globalThis as unknown as { window: unknown }).window = { fetch: google.fetch };
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-google-test-"));
    const keyFile = path.join(tmpDir, "key.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        type: "service_account",
        client_email: "scanner@test-project.iam.gserviceaccount.com",
        client_id: SERVICE_ACCOUNT_CLIENT_ID,
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      })
    );
    tenant = {
      id: "t1",
      name: "Test",
      color: "blue",
      credentialsFile: keyFile,
      adminEmail: ADMIN,
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  return {
    google,
    tenant: () => {
      if (!tenant) throw new Error("installFakeGoogle: tenant() called before the tests started");
      return tenant;
    },
  };
}
