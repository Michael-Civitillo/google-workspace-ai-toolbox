# Google Workspace Admin

A modern web app for day-to-day Google Workspace administration tasks. Built with Next.js and powered by the [Google Workspace CLI](https://github.com/googleworkspace/cli).

## Features

- **Email Delegation** — Grant mailbox access to another user without sharing passwords
- **Calendar Delegation** — Share calendar access with configurable permission levels
- **Calendar Transfer** — Transfer calendar ownership between users (offboarding, role changes)
- **Email Transfer** — Set up automatic email forwarding between users

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Google Workspace CLI](https://github.com/googleworkspace/cli) (`gws`)
- A Google Workspace admin account with appropriate API scopes

## Quick Start

```bash
# Install the gws CLI
npm install -g @googleworkspace/cli

# Authenticate (requires gcloud CLI)
gws auth setup

# Or authenticate manually with required scopes
gws auth login -s gmail,calendar

# Clone and run this app
git clone https://github.com/Michael-Civitillo/google-workspace-admin.git
cd google-workspace-admin
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the admin console.

## Authentication

This app executes `gws` CLI commands server-side. Authentication is handled by the CLI itself. For admin use, a **service account with domain-wide delegation** is recommended:

1. Create a service account in your GCP project
2. Enable domain-wide delegation in the Google Admin Console
3. Grant the required OAuth scopes:
   - `https://www.googleapis.com/auth/gmail.settings.sharing`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
   - `https://www.googleapis.com/auth/calendar`
4. Point the CLI to your service account key:
   ```bash
   export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
   ```

## Tech Stack

- [Next.js](https://nextjs.org/) 15 (App Router)
- [Tailwind CSS](https://tailwindcss.com/) v4
- [shadcn/ui](https://ui.shadcn.com/) components
- [Google Workspace CLI](https://github.com/googleworkspace/cli) for API operations

## Development

```bash
npm run dev     # Start dev server
npm run build   # Production build
npm run lint    # Run ESLint
```

## License

MIT
