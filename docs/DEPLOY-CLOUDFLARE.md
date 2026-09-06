# Deploying behind Cloudflare

How to give a team a URL like `https://admin.example.com` for Open Admin, with
Cloudflare handling TLS, the front door and the guest list — without opening a
single inbound port on the machine that runs it.

The short version: run the app wherever you like (a Linux VM with Docker, a
Windows PC with the single-file build, a server running `npm start`), connect
it to Cloudflare with a **Tunnel**, and put **Cloudflare Access** in front so
only your admins get through. The app then sits behind two locks — Access, and
its own sign-in.

## Which Cloudflare product

Open Admin keeps its state in files (`tenants.json`, `sso.json`, the audit
log, service-account keys), talks to Google's APIs with the `googleapis` SDK,
and runs long operations as many short requests driven by the browser. That
shape decides what fits.

| Product | Fit | Why |
|---|---|---|
| **Cloudflare Tunnel + Access** (Zero Trust) | ✅ **Use this** | The app runs unchanged on any machine; Cloudflare provides the hostname, TLS, identity checks and a WAF. Free for up to 50 users. |
| Cloudflare Containers | ⚠️ Not yet | Runs containers on Cloudflare's network, but container disk is ephemeral — the app's files would vanish on every restart. Possible once state can live in R2/D1; that's a code change, not a deployment step. |
| Workers / Pages (via OpenNext) | ❌ No | Workers have no writable filesystem or `child_process`, the server bundle (`googleapis` alone is large) exceeds Worker size limits, and mailbox export/import write files. Running here means rewriting the storage layer. |

If you came looking for "deploy to Workers": the honest answer is that this
app isn't a Worker-shaped app, and pretending otherwise would cost you your
tenant list on the first redeploy. The Tunnel route below takes about twenty
minutes and gives you everything Workers would have — the URL, the TLS, the
identity layer — plus a filesystem.

## What you'll have at the end

```
 admin on a laptop                                       your machine
 ──────────────────  https://admin.example.com  ─────────────────────────────
 browser  ──────►  Cloudflare edge  ──────►  cloudflared  ──►  Open Admin
                    • TLS               (outbound tunnel,     127.0.0.1:3000
                    • Access policy:     no open ports)        or app:3000
                      @example.com only
                    • WAF, logging
```

- `https://admin.example.com` with a valid certificate, automatically renewed.
- Only people your Access policy allows ever reach the app's login page.
- The machine running Open Admin accepts no inbound connections at all; the
  tunnel is an outbound connection from `cloudflared`.
- Everything the app stores stays on that machine (or its Docker volume).

## Before you start

- A Cloudflare account with your domain on it (any plan; the Zero Trust free
  tier covers Tunnel and Access for up to 50 users).
- A machine that stays on: a small Linux VM anywhere, a NAS, or a Windows PC
  that doesn't sleep. Open Admin is light — ~200 MB of RAM.
- The usual Open Admin prerequisites: a Google Cloud service account with
  domain-wide delegation ([Auth setup](../README.md#-auth-setup-the-important-part)).

## Step 1 — Run the app

Pick one. All three end with Open Admin listening on port 3000 on the machine.

### Option A: Docker Compose on a Linux host (recommended for teams)

`deploy/cloudflare-tunnel/` has a Compose file that runs the app and
`cloudflared` side by side. The app container publishes **no ports**; the only
way in is the tunnel.

```bash
git clone https://github.com/Michael-Civitillo/google-workspace-ai-toolbox.git
cd google-workspace-ai-toolbox/deploy/cloudflare-tunnel
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `PUBLIC_HOSTNAME` | `admin.example.com` — the hostname you'll route (no `https://`) |
| `APP_PASSWORD` | the web UI password, 12+ characters |
| `APP_SESSION_SECRET` | `openssl rand -hex 32` |
| `CLOUDFLARE_TUNNEL_TOKEN` | from Step 2 — leave blank for now |
| `GOOGLE_GENERATIVE_AI_API_KEY` | optional; tenants can carry their own key in the UI |

Come back after Step 2 and run:

```bash
docker compose up -d --build
docker compose logs -f cloudflared     # "Registered tunnel connection" = connected
```

The Compose file sets the two settings a proxied deployment needs:

- `APP_ALLOWED_ORIGINS=https://admin.example.com` — see [the one setting that matters](#the-one-setting-that-matters) below.
- `TRUSTED_PROXY=true` — only `cloudflared` can reach the app, so its
  `X-Forwarded-For` is honest and per-address login rate limiting works.

State lives in the `data` volume. Getting a service-account key into the
container: restore a **configuration backup** exported from another install
(it carries the key files), or `docker compose cp sa.json app:/data/credentials/`
and point the tenant at `/data/credentials/sa.json`.

### Option B: the single-file build on a Windows PC

Useful when the admin's own always-on desktop is the server.

1. Run `OpenAdmin-win-x64.exe` once so it creates its data folder, then stop it.
2. Create `%LOCALAPPDATA%\GoogleWorkspaceOpenAdmin\data\launcher.env` containing:

   ```
   APP_ALLOWED_ORIGINS=https://admin.example.com
   TRUSTED_PROXY=true
   ```

3. Start the exe again. It still binds `127.0.0.1:3000` — `cloudflared` on the
   same machine connects to it locally; nothing is exposed on the LAN.
4. Install `cloudflared` as a Windows service in Step 2 so both survive a reboot
   (the exe itself can go in `shell:startup`, or run it as a scheduled task at
   logon with `--no-browser`).

### Option C: from source with a process manager

On any OS with Node 20+:

```bash
npm ci && npm run build
APP_PASSWORD='…' APP_SESSION_SECRET='…' \
APP_ALLOWED_ORIGINS=https://admin.example.com TRUSTED_PROXY=true \
OPEN_ADMIN_DATA_DIR=/var/lib/open-admin \
npm start
```

Wrap that in systemd, pm2 or a Windows service so it restarts. `npm start`
binds `localhost`, which is what you want with `cloudflared` on the same host.

### The one setting that matters

**`APP_ALLOWED_ORIGINS` must name the public URL.** Without it, every POST —
including sign-in — is refused with `403 Cross-origin request blocked`.

The reason: the app's CSRF protection compares the browser's `Origin` header
with the host the server *bound*, not the `Host` header a client sends (which
an attacker controls). Behind a proxy the bound address is `localhost` or
`0.0.0.0`, and the browser's Origin is `https://admin.example.com`; the two can
never match on their own. The app can't safely learn its public name from a
request, so you tell it. Multiple names are comma-separated.

## Step 2 — Create the tunnel

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**.

1. Name it (`open-admin`) and save.
2. On the *Install and run a connector* page, copy the token — the long string
   after `--token` in any of the install commands.
   - **Docker (Option A):** paste it into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`,
     then `docker compose up -d --build`.
   - **Windows (Option B):** in an elevated PowerShell:
     ```powershell
     winget install Cloudflare.cloudflared
     cloudflared service install <token>
     ```
   - **Linux (Option C):** `cloudflared service install <token>` after installing
     the package for your distribution.
3. **Public Hostname** tab → *Add a public hostname*:
   - Subdomain `admin`, domain `example.com`.
   - Service type **HTTP**, URL:
     - Docker: `app:3000` (the Compose service name — the containers share a network)
     - Same machine (Options B, C): `localhost:3000`
4. Save. Cloudflare creates the DNS record for you.

The tunnel status turns **Healthy** once the connector is running. At this point
`https://admin.example.com` reaches the app — for anyone. Do Step 3 now.

## Step 3 — Put Access in front

**Zero Trust → Access → Applications → Add an application → Self-hosted.**

1. **Application name** `Open Admin`; **Session duration** — `24 hours` is a
   reasonable default for an admin tool.
2. **Application domain**: `admin.example.com`.
3. **Identity providers**: the default *One-time PIN* emails a code to any
   allowed address and needs no setup. For real SSO, add Google Workspace
   (**Settings → Authentication → Login methods → Google Workspace**) so
   people sign in with the accounts they already have.
4. **Policy**: name `Admins`, action **Allow**, include rule
   **Emails ending in** `@example.com` — or **Emails** with the specific
   admins' addresses, which is tighter and what an admin tool deserves.
5. Save.

Now `https://admin.example.com` shows Cloudflare's sign-in page first. Only
after Access is satisfied does a request ever reach `cloudflared`, let alone
the app. Cloudflare's own logs (**Zero Trust → Logs → Access**) record who
came through.

### Two logins, or one?

With Access in front, people sign in twice: once to Cloudflare, once to the
app. Three ways to think about that:

| Setup | Effect |
|---|---|
| **Access + app password** (default) | Two prompts. Access proves *who*; the shared password proves they were *given* the tool. Simple, and fine for a small team. |
| **Access + the app's own Google SSO** | Two prompts, both against Google, both usually silent after the first time. Run the app's SSO wizard **through the public URL** — it derives the redirect URI `https://admin.example.com/api/auth/oidc/callback` from the address bar, and that's what you register in Google Cloud Console. The audit log then records the signed-in email on every action. |
| **Access as the app's identity provider** | One prompt. Create an *Access for SaaS* application with the OIDC protocol, then in the app's SSO wizard choose *Other OpenID Connect provider* and paste the issuer, client ID and client secret Cloudflare shows. Copy the issuer URL exactly from that page. More setup; use it once the simpler options feel repetitive. |

Whatever you choose, keep `APP_PASSWORD` set — the app refuses to start
without it, and it is your way back in if the identity provider has a bad day
(`APP_SSO_DISABLED=true` brings the password form back).

## Step 4 — Check it

From any machine:

```bash
# Access is in front: unauthenticated requests are redirected to Cloudflare's login
curl -sI https://admin.example.com/login | grep -i -E "^(HTTP|location)"
```

Then in a browser: `https://admin.example.com` → Cloudflare sign-in → the app's
sign-in → dashboard. Create a tenant, run **Setup → Check DWD scopes**, and
look at the audit log page: entries should show, and on the server
`audit.log` should be growing in the data folder (Docker: `docker compose exec app ls -la /data`).

If sign-in returns **403 Cross-origin request blocked**, `APP_ALLOWED_ORIGINS`
is missing or doesn't match the address bar exactly (scheme and host; no path,
no trailing slash).

## Running it

- **Backups.** Everything is in the data folder / `data` volume, and **App
  Settings → Configuration backup** exports the same thing as one file — keys
  included — which is also how you move to a new machine.
- **Upgrades.** Docker: `git pull && docker compose up -d --build`. Windows:
  replace the exe. Source: `git pull && npm ci && npm run build`, restart.
  Data is untouched in all three.
- **Logs.** `docker compose logs app` / the console window / your process
  manager. The app's own audit log is separate and append-only.
- **Long operations.** Cloudflare returns a `524` if the origin sends nothing
  for 100 seconds. Open Admin's long jobs (tenant-wide sharing audits, mailbox
  export) are browser-driven loops of short requests, and the AI audit is
  bounded at 60 s, so this doesn't bite in practice.
- **Uploads.** Cloudflare caps request bodies (100 MB on Free and Pro). A
  configuration backup is tiny; a **Mailbox import** of a very large export may
  exceed it — run those from the machine itself on `localhost:3000`.
- **Never publish port 3000.** The Compose file doesn't, and the single-file
  build binds loopback. If you add `ports:` for debugging, take it out again:
  Access only protects what comes through the tunnel.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in → `403 Cross-origin request blocked` | `APP_ALLOWED_ORIGINS` unset or not matching the address bar | Set it to the exact origin, e.g. `https://admin.example.com`; restart |
| Tunnel shows *Healthy* but the site returns `502` | Service URL wrong | Docker: `app:3000` (service name, not `localhost`). Same host: `localhost:3000`. Check the app is actually running |
| Cloudflare error `1033` | Connector not running | `docker compose logs cloudflared`; on Windows check the `cloudflared` service |
| Signed in to Cloudflare, but the app asks for a password | Expected — see *Two logins, or one?* | |
| SSO test in the wizard fails with a redirect mismatch | Wizard was run via `localhost`, so the redirect URI is wrong | Re-run the wizard through the public URL; register that redirect URI with the provider |
| After an SSO error the browser lands on `localhost` | Old version | Upgrade: error redirects have been relative since this guide was added |
| Uploading a mailbox export fails through the tunnel | Cloudflare body-size limit | Import from the machine itself on `localhost:3000` |
| The app works on `localhost` but nothing else | That's the default, and correct | Everything else goes through the tunnel |

## Appendix: what Workers would take

For the record, and for whoever picks it up later. Running Open Admin on
Workers via [OpenNext](https://opennext.js.org/cloudflare) would need:

1. A storage abstraction over the five file-backed stores (`tenants.json`,
   `app-config.json`, `sso.json`, `audit.log`, imported keys), with KV or D1
   and R2 implementations. The stores already share one JSON-store module, so
   the seam exists.
2. Removing the `gws` status probe's `child_process` use (it's the CLI's only
   remaining call site) or feature-flagging it off.
3. Splitting or trimming the `googleapis` import to the per-API packages so
   route bundles fit Worker limits.
4. Reworking mailbox export/import, which stream to and from files.
5. Re-validating the auth middleware in the Workers runtime, since it is the
   security boundary.

That's a project, not a deployment. The tunnel is the deployment.
