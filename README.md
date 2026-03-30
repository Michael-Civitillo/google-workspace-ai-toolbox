<p align="center">
  <img src="public/logo.svg" alt="Google Workspace AI Toolbox" width="80" />
</p>

<h1 align="center">Google Workspace AI Toolbox</h1>

<p align="center">
  <strong>If you grew up on <a href="https://github.com/GAM-team/GAM">GAM</a>, this is what comes next.</strong><br/>
  A modern web UI for Google Workspace admin tasks — powered by Google's official <a href="https://github.com/googleworkspace/cli">Workspace CLI</a> and Gemini AI.
</p>

For years, [GAM](https://github.com/GAM-team/GAM) was *the* tool every Workspace admin had in their back pocket. It's a legend. But now Google has released their own [Workspace CLI](https://github.com/googleworkspace/cli) (`gws`) — built in Rust, schema-driven, officially maintained — and suddenly we've got a proper foundation to build on.

This project takes `gws` and wraps it in a clean web UI with AI superpowers. Instead of memorizing command flags or digging through the Admin Console, just type what you need in plain English, paste a bulk list, or click through the forms. It's GAM for the AI era.

![Dashboard](docs/screenshots/dashboard.png)

## ✨ What it does

- 📧 **Email Delegation** — Give someone access to another user's mailbox. No password sharing, no drama.
- 📅 **Calendar Delegation** — Share a calendar with configurable permissions (free/busy, read, edit, full control).
- 🔄 **Calendar Transfer** — Hand off calendar ownership to another user. Great for offboarding.
- 📬 **Email Transfer** — Set up auto-forwarding from one mailbox to another. Also great for offboarding.
- 🌐 **Domain Change** — Switch a user's primary email to a different domain in your tenant. Handy when you've got 50 domains and someone needs to move.
- 🏢 **Multi-Tenant Support** — Configure multiple Google Workspace environments (Production, Sandbox, etc.) and switch between them instantly from the sidebar. Nothing carries over between tenants.

### AI-Powered (Gemini)

- ✨ **AI Command** — Type what you need in plain English. "Give sarah access to john's mailbox" → it parses the intent, shows you what it'll do, and waits for your OK.
- 📋 **Bulk Operations** — Paste a list of tasks (one per line, however you want) and the AI breaks them into individual operations you can run all at once.
- 🛡️ **User Audit** — Enter a user's email and get a full AI-generated report: who has access to their mailbox, calendar sharing rules, forwarding config, and security flags.

<details>
<summary>📸 More screenshots</summary>

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
npm run dev
```

Hit [http://localhost:3000](http://localhost:3000) and you're in. 🎉

## 🔐 Auth setup (the important part)

The app runs `gws` commands on the server side. For real admin work, you'll want a **service account with domain-wide delegation** so you can act on behalf of any user in your org:

1. Create a service account in your GCP project
2. Turn on domain-wide delegation in the Admin Console
3. Add these OAuth scopes:
   - `https://www.googleapis.com/auth/gmail.settings.sharing`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/admin.directory.user` (for Domain Change)
   - `https://www.googleapis.com/auth/admin.directory.domain.readonly` (for Domain Change)
4. Set an admin email for impersonation (Domain Change needs this):
   ```bash
   export GOOGLE_WORKSPACE_ADMIN_EMAIL=admin@yourdomain.com
   ```
5. Tell the CLI where to find it:
   ```bash
   export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
   ```

For the AI features, you'll also need a [Gemini API key](https://aistudio.google.com/apikey):
```bash
export GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
```

> **Tip:** If you're using multi-tenant support, you can set credentials per tenant directly in the UI instead of relying on env vars.

## 🏢 Multiple tenants (Production, Sandbox, etc.)

Got more than one Workspace environment? Go to **Tenants** in the sidebar and add each one with its own service account and admin email. The active tenant is always visible in the sidebar — switch between them with one click.

Each tenant is fully isolated: every command, delegation, audit, and transfer targets whichever tenant is active at the time. Nothing bleeds over.

Tenant config is saved to `tenants.json` locally (gitignored — your credential paths stay on your machine).

## 🧰 Built with

- [Next.js](https://nextjs.org/) 15
- [Tailwind CSS](https://tailwindcss.com/) v4
- [shadcn/ui](https://ui.shadcn.com/)
- [Vercel AI SDK](https://sdk.vercel.ai/) + [Gemini](https://ai.google.dev/)
- [gws CLI](https://github.com/googleworkspace/cli)

## 💻 Dev stuff

```bash
npm run dev     # fire it up
npm run build   # production build
npm run lint    # check your work
```

## ⚠️ Heads up

This tool makes real changes to real Google Workspace accounts. Mistakes can lock people out, break email routing, or cause other headaches that are annoying to undo. Use it carefully, test in a sandbox first, and make sure whoever's running it knows what they're doing.

**This is provided as-is. No warranty, no guarantees, not my problem if something goes wrong.** You're responsible for what you do with it.

## 📄 License

MIT — do whatever you want with it.
