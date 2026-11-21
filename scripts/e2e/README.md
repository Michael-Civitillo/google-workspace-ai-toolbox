# End-to-end run

`npm run test:e2e` starts the packaged app exactly as it ships, drives it in a
real browser, and checks what it shows and what it asks Google to do. Google is
played by a small local server, so the run needs no tenant, no credentials and
no network, and it can do things you would never try on a real organisation:
suspend people, strip licences, overwrite signatures, fail half-way through.

Each line it prints is a statement about the app in plain words:

```
New User: create an account
  ok   offers the full domains and not the alias
  ok   suggests a plain username from the name
  ok   nothing can be created before the address is typed
  ok   creates exactly one account, as the admin
  ok   shows the same password Google was given
  ok   the password is not in the audit log
```

The exit code is 0 only if every line says `ok`.

## How it works

Nothing in the app is replaced or mocked. It is started with three settings any
install could have:

| Setting | Points at |
|---|---|
| `HTTPS_PROXY` | the stand-in (`fake-google.mjs`) |
| `NODE_EXTRA_CA_CERTS` | a certificate authority the stand-in makes on the spot |
| `OPEN_ADMIN_DNS_SERVERS` | the stand-in's DNS server, for SPF, DKIM and DMARC |

The app's real Google client then opens real TLS connections to
`admin.googleapis.com`, `gmail.googleapis.com` and the rest, and the stand-in
answers them from a made-up organisation (`dataset.mjs`: 131 accounts at
`example.com`, with forwarding rules, connected apps, licences, shared drives
and DNS records for the checks to find).

The stand-in also remembers everything it was asked. That is what lets a check
say not only "the page shows Jane was suspended" but "Google received one
request, to suspend Jane, as the admin, with this permission and no other".

## Running it

You need:

- **A packaged build** for this machine: `npm run package && npm run package:bin`
  (Windows: `npm run package:exe`). The run tests that file, not the source, so
  rebuild after changing the app.
- **Playwright and its Chromium.** They are deliberately not among the
  project's dependencies, since nothing that ships needs them:
  ```bash
  npm install --no-save playwright
  npx playwright install chromium
  ```
  To use a Chromium you already have, set `E2E_BROWSER` to its path.
- **The `openssl` command**, for the stand-in's throwaway certificates.
- Ports 3077, 4443 and 4444 free (or pass others).

Then:

```bash
npm run test:e2e
npm run test:e2e -- --help      # options: another binary, ports, where to keep files
```

It takes about a quarter of an hour and runs from top to bottom; there is no
way yet to run one section alone. When something fails, the app's data, its
audit log and the screenshots taken along the way are left in the folder the
last line names.

Written and run on Linux. It should work on macOS. It has not been tried on
Windows.

## What it covers

- **Security Check**: a full scan and each of its six checks, the CSV export,
  what is new since the last scan, every Fix button and what the server refuses,
  cancelling part-way, Google failing part-way, a permission missing for every
  account, an admin log that can't be read, a tenant with nothing wrong, the
  dark theme and a narrow window.
- **Sharing Audit**: shared drives.
- **New User**: creating an account and joining groups; resetting a password.
- **Bulk Operations**: group members, calendar sharing, suspend and re-enable.
- **Licences**, **Email Signatures**, and the **update notice**.
- That the browser console stayed free of errors throughout.

Pages older than this harness have no checks here yet: delegation, transfers,
Domain Change, Offboarding, Groups, mailbox export and import, Activity Reports,
User Audit, the Audit Log viewer, single sign-on and configuration backup.

## What it proves, and what it doesn't

It proves what the app sends and how it behaves given particular answers. It
cannot prove that Google gives those answers: the stand-in was written from
Google's documentation, not from watching a real tenant. Where it and Google
disagree, the app can pass here and still fail for real. The places most worth
a look against a real tenant are the admin log's names for domain-wide
delegation changes, and the wording of Google's refusals (the app recognises a
few by their text).

## The files

| File | What it is |
|---|---|
| `run.mjs` | The run itself: one section per feature, each a list of `check()` and `eq()` lines. |
| `fake-google.mjs` | The stand-in: an HTTPS proxy that answers as Google, a DNS server, and a plain-HTTP control channel. |
| `dataset.mjs` | The made-up organisation, and the answers a correct scan of it should reach. |
| `harness.mjs` | Start-up shared by the scripts: the stand-in, the app, signing in, the browser. |
| `sample-app.mjs` | The same app and organisation, left running, for trying things by hand. |
| `screenshots.mjs` | The three README screenshots that need a finished scan or a preview. |

## Adding a check

1. **Teach the stand-in the request**, if it doesn't know it: add a branch to
   `handle()` in `fake-google.mjs`, matched on the path. A request it doesn't
   know gets a 404 that names it, which shows up in the page and the log.
   Record writes in `changes`, so the check can read back what was asked.
2. **Add sample data** to `dataset.mjs` if the feature needs some. Compute what
   the page should show from that data, in the check, with separate logic;
   don't copy the app's own rule.
3. **Add a section** to `run.mjs`. Start it by resetting whatever earlier
   sections changed (`control("/__tenant")`, `control("/__changes?clear=true")`),
   so it doesn't depend on them. Check both sides: what the page shows, and what
   the stand-in received.

The control channel is plain HTTP on the stand-in's port:

| Request | What it does |
|---|---|
| `/__settings?name=value` | Change how "Google" behaves: `latencyMs`, `failAllTokens`, `failDirectoryAfterPages`, `failReports`, `noDelegation`, `groupDelayMs`, `failSignOut`, `refuseLicensing`, `licensingApiOff`, `failVoice`, `licensePageSize`. |
| `/__tenant?count=N` | Start again with a fresh organisation of N accounts (130 plus the admin by default). |
| `/__log` | Every request the app has made: method, host, path, who it was made as, with which permissions. `?clear=true` empties it. |
| `/__changes` | Every write the app has made, plus group memberships and who is suspended. `?clear=true` empties the list of writes. |
| `/__tokens` | Access tokens asked for, granted and refused. |
| `/__dns` | DNS questions asked. |
| `/__new` | Make a few things change, as if time had passed between two scans. |
| `/__licenses`, `/__unlicense?user=` | Read the licences held; take one account's away behind the app's back. |
| `/__setrelease?tag=&html=&status=`, `/__releasehits` | What the update check's release server answers, and the requests it has had. |

## The sample app, and the README screenshots

`node scripts/e2e/sample-app.mjs` starts the same app with the same made-up
organisation and leaves it running, printing the address and password. Use it
to look at a page with realistic data in it, or to click through a change
without touching a real tenant.

The README screenshots are taken from it:

```bash
npm run package && npm run package:bin
node scripts/e2e/sample-app.mjs          # leave running

# in another terminal
SCREENSHOT_BASE_URL=http://localhost:3079 APP_PASSWORD=sample-app-password npm run screenshots
node scripts/e2e/screenshots.mjs
```

`npm run screenshots` photographs every page as it loads. `screenshots.mjs`
then takes the three that need something to have happened first: a finished
Security Check, a finished licence check, and a signature preview.

The Tenants page shows where each tenant's key file is, which by default is
inside a temporary folder. For a picture that looks like a real install, pass
`--key-path` with a path you can write to (the committed screenshots used
`/srv/open-admin/keys/example-corp.json`). The file must not exist already, and
is removed again when the sample app stops.
