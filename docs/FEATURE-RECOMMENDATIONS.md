# Codebase Review & Feature Recommendations

A review of where Open Admin stands today, followed by a prioritized set of new features. Each recommendation maps onto the extension points the codebase already has, so the implementation sketches reference real files and established patterns rather than green-field designs.

## Where the codebase stands

The app is in good shape: a Next.js 16 / React 19 App Router UI over a single core library, with an unusually strong safety story for an admin tool.

**Architecture in one paragraph.** Every real Workspace operation goes through `src/lib/admin-sdk.ts` (~2,950 lines) using the `googleapis` SDK with domain-wide-delegation service accounts — Gmail v1, Calendar v3, Admin Directory v1, Admin Data Transfer v1, and Drive v3. The `gws` CLI is now vestigial: its only live call site is the Setup page status check (`checkGwsStatus` in `src/lib/gws.ts`); the exported `gws()` runner has zero callers. Long-running work (sharing audit, mailbox export, drive transfer) uses stateless, resumable server endpoints driven by a client-side loop with cancel refs and tenant pinning — there is no server-side job store, queue, or streaming channel. Offboarding is the flagship orchestration: a fixed step order executed one idempotent server call at a time, with irreversible steps held back after any failure.

**The feature template.** New features consistently follow this path, and everything recommended below rides on it:

1. Add the SDK call to `src/lib/admin-sdk.ts`, reusing `buildAuth` / `getAdminClient` / `withGoogleRetry`.
2. Register any new OAuth scope in `REQUIRED_SCOPES` (`src/lib/preflight.ts`) so the Setup preflight catches missing domain-wide-delegation grants.
3. Add a route under `src/app/api/...` following the standard shape: `readCappedJson` → `tenantFromRequest` → `require*` validators → SDK call → `audit()` → `errorResponse`.
4. Add a client page using `tfetch` / `useCurrentTenant` + `ConfirmActionDialog` (typed confirmation for destructive paths), and a sidebar entry.
5. Optionally expose it to the dashboard command bar by adding an entry to `ADMIN_ACTIONS` plus a Zod schema in `ACTION_PARAM_SCHEMAS` (`src/lib/ai.ts`).

**Confirmed gaps** (each verified against the code, not just the README):

- No Groups, Org Units, licenses, devices, roles, or aliases — Admin Directory usage is limited to `users` (get/list/update/signOut), `domains.list`, and `tokens`.
- No Reports API: the User Audit sees Gmail/Calendar *configuration* but never actual sign-in or admin-console activity.
- No user provisioning: the existing `/onboarding` page is app setup (install CLI, service account, first tenant), not a new-hire counterpart to Offboarding.
- The sharing audit queries `corpora: "user"` only — shared drives are a blind spot.
- The append-only `audit.log` has no in-app viewer.
- Gmail settings coverage stops short of sendAs/signatures, filters, and IMAP/POP.
- Zero automated tests; quality is maintained through review passes.

## Recommendations, in priority order

### 1. Groups & membership management

**What:** List/search groups, view members with roles, add/remove members, and a per-user "which groups is this person in" view.

**Why first:** It is the single biggest Admin Directory gap and a daily admin task. It also feeds two existing features immediately: an offboarding step ("remove from all groups") and a "Group memberships" section in the User Audit report.

**How:**
- Lib fns on `directory_v1`: `groups.list` (by domain and by `userKey` for memberships), `members.list/insert/delete`.
- Scopes `https://www.googleapis.com/auth/admin.directory.group` + `.readonly` added to `REQUIRED_SCOPES`.
- Routes under `src/app/api/admin/groups/`, page at `src/app/groups/page.tsx`.
- Offboarding: new step between Drive transfer and token revocation in `STEPS` (`src/app/offboarding/page.tsx`) and the switch in `src/app/api/offboarding/step/route.ts`. Removal is idempotent (treat "member not found" like the existing `isAlreadyExistsError` handling).
- Command bar intents: `group_member_add`, `group_member_remove`, `group_member_list`. Removal is destructive → route through the dedicated page like the existing `DESTRUCTIVE_ACTIONS` set.

**Effort:** Medium.

### 2. In-app audit log viewer

**What:** A read-only page over the existing `audit.log`: filter by tenant, action, outcome, and date range; paginate backwards from the tail; export the filtered view as CSV.

**Why:** The log already captures every mutation with secret redaction, but it is invisible without shell access to the host. This is the cheapest feature on the list and directly serves the compliance story the tool sells.

**How:**
- New route `src/app/api/admin/audit-log/route.ts` reading `AUDIT_LOG_PATH` (default `<cwd>/audit.log`): read a bounded byte window from the end of the file, split lines, JSON-parse defensively (skip corrupt lines), filter server-side, return a cursor (byte offset) for older pages.
- Page `src/app/audit-log/page.tsx` with a table, filter controls, and the existing CSV-export approach from the sharing audit.
- No new Google scopes; no mutation, so no confirmation dialog needed. Gate it behind the normal session auth like everything else.

**Effort:** Small.

### 3. Sign-in & admin activity reports + security digest

**What:** Surface `admin.reports_v1` activity: per-user login history (failed and suspicious logins, 2SV challenges) and a tenant-wide admin-console action feed. Offer a Gemini "security digest" that summarizes the last N days, and fold login history into the existing User Audit report.

**Why:** The User Audit currently answers "who *could* touch this mailbox" but not "what actually happened." Reports API is read-only, so the risk profile is low while the value is high.

**How:**
- Lib fns on `admin.reports_v1`: `activities.list` for `applications=login` and `applications=admin`, paginated with the usual `withGoogleRetry`.
- Scope `https://www.googleapis.com/auth/admin.reports.audit.readonly` in `REQUIRED_SCOPES`.
- Extend `src/app/api/ai/audit/route.ts`: add login events as a fifth `readOrError` input, cap the slice via the existing `boundPromptData` approach, and keep the `<audit_data>` untrusted-data framing — event payloads contain attacker-controllable strings (device names, IPs) and must stay quarantined in the prompt.
- Standalone digest: new route + page mirroring the audit page, using `generateText` with the same timeout discipline.

**Effort:** Medium.

### 4. Bulk CSV operations

**What:** Paste or upload a CSV (`user,delegate`, `user,forwardTo`, …), get a validated preview table, confirm once with a typed phrase showing the row count, then execute sequentially with per-row status, cancellation, and a downloadable results CSV.

**Why:** Bulk lists are the GAM muscle memory this project inherits, and the intro promises them — but today only the tenant-wide sharing audit fans out. Everything needed already exists: the per-item endpoints are the API, and the sharing audit's per-user status list is the runner pattern.

**How:**
- Client-orchestrated: a reusable `BulkRunner` component modeled on the tenant-wide loop in `src/app/sharing-audit/page.tsx` (pending/running/done/error rows, cancel ref, tenant pinning, abort on unmount). Each row calls the existing route (`/api/gws/email-delegation`, `/api/gws/email-transfer`, …) — no new server infrastructure and every row still lands in the audit log individually.
- Validation before execution: reuse `validate.ts` email checks client-side for the preview, and let the server revalidate per row as it already does.
- Start with delegation add/remove and forwarding; the runner generalizes to signatures (#5) and provisioning (#6).

**Effort:** Medium (mostly one reusable component).

### 5. Gmail sendAs & signature management

**What:** View and edit a user's sendAs aliases and signatures; deploy an org-wide or per-OU signature template with variables (`{{name}}`, `{{title}}`, `{{phone}}`) filled from Directory profile fields.

**Why:** Standardized signatures are one of the most common Workspace admin requests and a classic GAM job. The Gmail client and settings scopes are already wired for delegation/forwarding, so the marginal cost is low.

**How:**
- Lib fns: `gmail.users.settings.sendAs.list/patch` impersonating the target user (scope `gmail.settings.basic` is already in `REQUIRED_SCOPES`; sendAs creation would need `gmail.settings.sharing`, also present).
- Template rendering: fetch the Directory user (`getUser` in `src/lib/admin-sdk.ts` already exists), substitute variables server-side, and show a rendered preview for one sample user before the bulk run.
- Bulk deployment rides the #4 runner; per-user failures stay per-row.

**Effort:** Medium.

### 6. User onboarding (the missing lifecycle half)

**What:** A provisioning wizard mirroring Offboarding: create the user (name, primary email, org unit, generated temp password with change-at-next-login) → add to groups → optional initial settings. Plus small standalone actions that belong with it: unsuspend/restore and force password reset.

**Why:** The tool currently ends careers but cannot start them. The offboarding architecture (preflight → diff confirmation → sequential idempotent steps with hold-back) transplants cleanly, and #1 supplies the group-add step.

**How:**
- Lib fns: `users.insert`, `users.update` (suspended flag, password), on the existing `admin.directory.user` scope.
- Clone the orchestration shape: `src/app/user-onboarding/page.tsx` with a `STEPS` array, and a step-executor route like `src/app/api/offboarding/step/route.ts`. Name the page route distinctly from the existing `/onboarding` setup wizard (or rename that page to `/setup-wizard` in the same change to remove the ambiguity).
- Generated passwords are sensitive: display once client-side, never write to the audit log — `redactSensitive` in `src/lib/audit.ts` already strips `password` keys, but verify the step payload uses that key name so redaction actually bites.

**Effort:** Medium-large.

### 7. License management + offboarding reclaim step

**What:** Show license assignments per user (Enterprise License Manager API), assign/remove licenses, and add an offboarding step that reclaims paid licenses after suspension (or swaps to Archived User where available).

**Why:** Unreclaimed licenses are the most measurable cost of sloppy offboarding. This turns the existing offboarding flow into a direct money saver.

**How:**
- Lib fns on `licensing_v1`: `licenseAssignments.listForProductAndSku/insert/delete`; scope `https://www.googleapis.com/auth/apps.licensing` in `REQUIRED_SCOPES`.
- New final offboarding step after `suspend` in `STEPS` — license removal is safe post-suspension, unlike the settings steps that must run before cutoff.
- Small standalone panel on a user-detail view or its own page for ad-hoc assignment changes.

**Effort:** Small-medium.

### 8. Shared-drive coverage for the sharing audit

**What:** Extend the external sharing audit to shared drives: enumerate them, scan their contents for external permissions, and reuse the existing revoke flow.

**Why:** `listExternallySharedFiles` scans with `corpora: "user"`, so content in shared drives — often the *most* shared surface in a tenant — never appears in the audit. That is a blind spot in the exact risk the feature exists to catch.

**How:**
- Enumerate with `drives.list` (admin mode `useDomainAdminAccess: true`), then scan each drive with `corpora: "drive"` + `driveId`, keeping the existing page-token loop, caps, and cancel semantics in `src/app/sharing-audit/page.tsx`.
- Membership of the drive itself (`permissions.list` on the drive id) should be audited too — an external member of a shared drive out-scores any single shared file.
- Revoke reuses `revokeExternalPermissions` with `supportsAllDrives` (already set on the Drive calls).

**Effort:** Medium.

### Cross-cutting: command-bar and model upgrades

Not a standalone feature, but worth folding into each of the above:

- **Register every new operation in `ADMIN_ACTIONS`** so the dashboard command bar keeps pace with the UI. The registry + Zod-schema pattern in `src/lib/ai.ts` makes this a few lines per intent.
- **Make the Gemini model configurable** — it is hardcoded to `gemini-2.0-flash` in `src/lib/ai.ts`. A per-tenant `geminiModel` field (defaulting to the current value) slots into the existing per-tenant `geminiApiKey` plumbing in `tenants.json`.
- **Stream the audit report** with `streamText` instead of the buffered `generateText` — the 60-second worst case currently renders as a spinner; streaming makes the same latency feel fast.

### Engineering hygiene note

The repo has no automated tests. The runtime defensiveness is genuinely good, but the highest-risk logic — `validate.ts`, the `redactSensitive` walker in `src/lib/audit.ts`, `isExternalTarget`, and the `ACTION_PARAM_SCHEMAS` — is exactly the kind of pure, dependency-free code a small Vitest suite covers cheaply. Worth doing before the feature list above doubles the surface area.

## Suggested build order

| Order | Feature | Rationale |
|---|---|---|
| 1 | Audit log viewer (#2) | Smallest, zero new scopes, immediate ops value |
| 2 | Groups (#1) | Unlocks offboarding step, audit section, and onboarding wizard |
| 3 | Reports API + digest (#3) | Read-only, completes the audit story |
| 4 | Bulk CSV runner (#4) | Reusable component that #5 and #6 build on |
| 5 | Signatures (#5), then onboarding (#6) | Both ride the runner and groups work |
| 6 | Licenses (#7), shared-drive audit (#8) | Independent; schedule by demand |
