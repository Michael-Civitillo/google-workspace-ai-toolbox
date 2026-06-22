<p align="left">
  <img src="public/logo.svg" alt="Google Workspace AI Toolbox" width="80" />
</p>

<h1 align="left">Google Workspace AI Toolbox</h1>

<p align="left">
  <strong>If you grew up on <a href="https://github.com/GAM-team/GAM">GAM</a>, this is what comes next.</strong><br/>
  A modern web UI for Google Workspace admin tasks — powered by Google's official <a href="https://github.com/googleworkspace/cli">Workspace CLI</a> and Gemini AI.
</p>

For years, [GAM](https://github.com/GAM-team/GAM) was *the* tool every Workspace admin had in their back pocket. It's a legend. But now Google has released their own [Workspace CLI](https://github.com/googleworkspace/cli) (`gws`) — built in Rust, schema-driven, officially maintained — and suddenly we've got a proper foundation to build on.

This project takes `gws` and wraps it in a clean web UI with AI superpowers. Instead of memorizing command flags or digging through the Admin Console, just type what you need in plain English, paste a bulk list, or click through the forms. It's GAM for the AI era.

![Dashboard](docs/screenshots/dashboard.png)

## ✨ What it does

### Workspace operations

- 📧 **Email Delegation** — Give someone access to another user's mailbox. No password sharing, no drama.
- 📅 **Calendar Delegation** — Share a calendar with configurable permissions (free/busy, read, edit, full control).
- 🔄 **Calendar Transfer** — Hand off calendar ownership to another user. Great for offboarding.
- 📬 **Email Transfer** — Set up auto-forwarding from one mailbox to another. External-domain transfers require explicit confirmation.
- 🌐 **Domain Change** — Switch a user's primary email to a different domain in your tenant. Server-side preflight + read-after-write verification.
- 👋 **Offboarding** — One screen, one click. Vacation responder, mail forwarding, calendar + Drive ownership transfer, OAuth token revocation, sign-out, and account suspension — in the right order, with full diff preview before anything fires.
- 💾 **Mailbox Export** — Back up a user's entire Gmail mailbox to a portable file. Choose **NDJSON** for a full-fidelity backup (raw MIME with labels and dates preserved, restorable via Mailbox Import) or **mbox** for a standard mailbox file you can open in Thunderbird, Apple Mail, or convert to PST. Walks the mailbox page by page, streams straight to disk, cancellable mid-run (you keep what's gathered).
- 📥 **Mailbox Import** — Restore a mailbox export into another user. Recreates the source's labels by name, then inserts every message via IMAP-style append (no re-delivery, no spam reclassification) with original dates intact — gated behind a typed confirmation since it writes into a live mailbox.
- 🔍 **External Sharing Audit** — Per-user or tenant-wide Drive scan that surfaces every file shared outside your verified domains, including link-shared / "anyone with link" content. Cancellable, progress-tracked, CSV export, and one-click "revoke external sharing" per file or in bulk — strips only external permissions, leaves internal collaborators alone.
- 🏢 **Multi-Tenant Support** — Configure multiple Google Workspace environments (Production, Sandbox, etc.) and switch between them instantly from the sidebar. Per-request tenant isolation — nothing carries over between tenants.

### AI-powered (Gemini)

- ✨ **AI Command** (right on the dashboard) — Type what you need in plain English. *"Give sarah access to john's mailbox"* → it parses the intent, validates the params, shows you what it'll do, and waits for your OK. No menu hunting, no extra clicks.
- 🛡️ **User Audit** — Enter a user's email and get a full AI-generated report: who has access to their mailbox, calendar sharing rules, forwarding config, and security flags.

### Safety & ops

- 🔐 **Password gate + signed sessions** — App refuses to serve any route without `APP_PASSWORD` set. HMAC-signed session cookies, 12h TTL, rate-limited login.
- 🛡️ **CSRF protection** — Same-origin Origin/Referer check on every mutating API route, validated against the canonical request host.
- ⚠️ **Confirmation dialogs** — Every destructive action (domain change, calendar transfer, external email transfer, offboarding, account suspension) shows a before→after diff and requires you to type the target email/identifier to confirm.
- 📜 **Audit log** — Append-only JSON-lines log of every mutation, with secrets redacted (`AUDIT_LOG_PATH` env var to control location).
- 🧪 **Atomic tenant config writes** — `tenants.json` is written via tmp-file + rename with an in-process mutex so a crash mid-write can't corrupt your config.

### Polish

- 🌗 **Dark mode** — Auto-detects your system preference, persists across reloads, one-click toggle in the sidebar.
- 🪟 **Cross-platform** — Tested on macOS, Linux, and Windows 11 (handles `gws.cmd` shim, CRLF line endings, AV-related file lock retries).

<details>
<summary>🌗 Dashboard in dark mode</summary>

![Dashboard — dark mode](docs/screenshots/dashboard-dark.png)

</details>

<details>
<summary>📸 More screenshots</summary>

### User Audit
![User Audit](docs/screenshots/audit.png)

### Email Delegation
![Email Delegation](docs/screenshots/email-delegation.png)

### Calendar Delegation
![Calendar Delegation](docs/screenshots/calendar-delegation.png)

### Calendar Transfer
![Calendar Transfer](docs/screenshots/calendar-transfer.png)

### Email Transfer
![Email Transfer](docs/screenshots/email-transfer.png)

### Domain Change
![Domain Change](docs/screenshots/domain-change.png)

### Offboarding
![Offboarding](docs/screenshots/offboarding.png)

### External Sharing Audit
![Sharing Audit](docs/screenshots/sharing-audit.png)

### Tenants
![Tenants](docs/screenshots/tenants.png)

### Setup
![Setup](docs/screenshots/setup.png)

</details>

## 🚀 Getting started

You'll need:
- Node.js 18+
- The [gws CLI](https://github.com/googleworkspace/cli)
- A Google Workspace admin account

```bash
# Grab the gws CLI
npm install -g @googleworkspace/cli

# Auth up (easiest way, needs gcloud)
gws auth setup

# Or do it manually
gws auth login -s gmail,calendar

# Then run this thing
git clone https://github.com/Michael-Civitillo/google-workspace-ai-toolbox.git
cd google-workspace-ai-toolbox
npm install

# Required: set the password gate before starting the server
export APP_PASSWORD='something-long-and-random'

npm run dev
```

Hit [http://localhost:3000](http://localhost:3000), log in with your `APP_PASSWORD`, and you're in. 🎉

### 🪟 Windows 11 (PowerShell)

Same flow, just different env-var syntax. Open **PowerShell** (or Windows Terminal):

```powershell
# Install Node.js 18+ from https://nodejs.org and the gws CLI:
npm install -g @googleworkspace/cli

# Auth up
gws auth setup    # needs gcloud (winget install Google.CloudSDK)
# or:
gws auth login -s gmail,calendar

# Clone and install
git clone https://github.com/Michael-Civitillo/google-workspace-ai-toolbox.git
cd google-workspace-ai-toolbox
npm install

# Required: password gate (current PowerShell session only)
$env:APP_PASSWORD = "something-long-and-random"

# Optional: service-account / Gemini setup
$env:GOOGLE_WORKSPACE_ADMIN_EMAIL = "admin@yourdomain.com"
$env:GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = "C:\path\to\service-account.json"
$env:GOOGLE_GENERATIVE_AI_API_KEY = "your-key-here"

# Fire it up
npm run dev
```

To make env vars persist across sessions, use the **Settings → System → About → Advanced system settings → Environment Variables** dialog, or run `setx APP_PASSWORD "..."` in PowerShell (closes/reopens the terminal to take effect).

If you'd rather use **Command Prompt** (`cmd.exe`), swap `$env:NAME = "value"` for `set NAME=value`. **Git Bash** uses the same `export NAME=value` syntax shown in the macOS/Linux instructions above.

## 🔐 Auth setup (the important part)

The app runs `gws` commands and `googleapis` SDK calls on the server side. For real admin work, you'll want a **service account with domain-wide delegation** so you can act on behalf of any user in your org:

1. Create a service account in your GCP project
2. Turn on domain-wide delegation in the Admin Console
3. Add these OAuth scopes:
   - `https://www.googleapis.com/auth/gmail.settings.sharing`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
   - `https://www.googleapis.com/auth/gmail.readonly` (Mailbox Export)
   - `https://www.googleapis.com/auth/gmail.insert` (Mailbox Import)
   - `https://www.googleapis.com/auth/gmail.labels` (Mailbox Import — recreate labels)
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/admin.directory.user` (Domain Change, Offboarding)
   - `https://www.googleapis.com/auth/admin.directory.user.security` (Offboarding — OAuth token revoke, sign-out)
   - `https://www.googleapis.com/auth/admin.directory.domain.readonly` (Domain Change, Sharing Audit)
   - `https://www.googleapis.com/auth/admin.datatransfer` (Offboarding — Drive ownership transfer)
   - `https://www.googleapis.com/auth/drive.metadata.readonly` (Sharing Audit)
   - `https://www.googleapis.com/auth/drive` (Sharing Audit — revoke external sharing)
4. Set an admin email for impersonation (Domain Change and Admin SDK calls need this):
   ```bash
   export GOOGLE_WORKSPACE_ADMIN_EMAIL=admin@yourdomain.com
   ```
5. Tell the CLI where to find your service account JSON:
   ```bash
   export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
   ```

For the AI features, you'll also need a [Gemini API key](https://aistudio.google.com/apikey):
```bash
export GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
```

> **Tip:** If you're using multi-tenant support, set credentials per tenant directly in the UI instead of relying on env vars.

## 🔒 Production deployment

The toolbox is designed to be safe to run against a real tenant, but a few env vars matter:

| Variable | Required | What it does |
|---|---|---|
| `APP_PASSWORD` | ✅ | Password gate. App refuses to serve any route without it. |
| `GOOGLE_WORKSPACE_ADMIN_EMAIL` | ✅ for Admin SDK ops | Subject for service account impersonation. |
| `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` | ⚠️ if not using per-tenant config | Path to service account JSON. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ⚠️ for AI features | Gemini API key. |
| `AUDIT_LOG_PATH` | optional | Override location of the append-only audit log (defaults to `./audit.log`). |
| `GWS_CREDENTIALS_DIR` | optional | Allowlist a directory; tenant credential paths must live underneath it. |

Run behind HTTPS in production. The app sets HSTS, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy on every response.

## 🏢 Multiple tenants (Production, Sandbox, etc.)

Got more than one Workspace environment? Go to **Tenants** in the sidebar and add each one with its own service account and admin email. The active tenant is always visible in the sidebar — switch between them with one click.

Each tenant is fully isolated: every command, delegation, audit, and transfer targets whichever tenant is active at the time. The active tenant ID is sent on every request via an `x-tenant-id` header and frozen at confirmation time, so a tenant switch mid-action can't accidentally fire against the wrong environment.

Tenant config is saved to `tenants.json` locally (gitignored — your credential paths stay on your machine).

## 🧰 Built with

- [Next.js](https://nextjs.org/) 16 (App Router)
- [Tailwind CSS](https://tailwindcss.com/) v4
- [shadcn/ui](https://ui.shadcn.com/) + [@base-ui/react](https://base-ui.com/)
- [Vercel AI SDK](https://sdk.vercel.ai/) + [Gemini](https://ai.google.dev/)
- [googleapis](https://www.npmjs.com/package/googleapis) — direct Gmail, Calendar, Admin SDK, Drive, and Data Transfer calls (no CLI hop, fewer args quirks)
- [gws CLI](https://github.com/googleworkspace/cli) — used for everything outside the Google APIs we wrap directly
- Web Crypto API (Edge-runtime safe HMAC sessions)

## 💻 Dev stuff

```bash
npm run dev          # fire it up
npm run build        # production build
npm run lint         # check your work
npm run screenshots  # regenerate docs/screenshots/* in light + dark modes (needs dev server + APP_PASSWORD)
```

## ⚠️ Heads up

This tool makes real changes to real Google Workspace accounts. Mistakes can lock people out, break email routing, or cause other headaches that are annoying to undo. Use it carefully, test in a sandbox first, and make sure whoever's running it knows what they're doing.

**This is provided as-is. No warranty, no guarantees, not my problem if something goes wrong.** You're responsible for what you do with it.

## 📄 License

MIT — do whatever you want with it.
