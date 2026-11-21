# Packaging: the single-file build

This folder turns Open Admin into one executable a Workspace admin can
download and double-click. No Node.js, no `npm install`, no `gws` CLI on the
target machine — the runtime and the whole application are inside the file.

Users don't need anything here. Point them at the release: **[Single file:
download and run](../README.md#single-file-download-and-run)**, which covers
Windows, macOS and Linux.

## What gets built

| Artifact | Size | Notes |
|---|---|---|
| `dist/payload.zip` | ~6 MB | The `next build` standalone output plus `public/` and `.next/static` |
| `dist/sea-prep.blob` | ~6 MB | The bundled launcher plus that archive, as a Node single-executable blob |
| `dist/OpenAdmin-win-x64.exe` | ~93 MB | `node.exe` with the blob injected, icon and version stamped |
| `dist/open-admin-linux-x64` | ~125 MB | The Linux runtime with the blob injected |
| `dist/open-admin-macos-arm64` | ~110 MB | The macOS runtime with the blob injected, ad-hoc signed |

Each binary gets a `<name>.sha256` beside it. The release workflow builds all
three on their own operating systems and smoke-tests each before publishing.

## Build it

Everything runs from the repository root.

```bash
npm ci
npm run package        # next build -> payload.zip -> sea-prep.blob
npm run package:exe    # Windows: assemble OpenAdmin-win-x64.exe
npm run package:bin    # Linux/macOS: assemble dist/open-admin-<os>-<cpu>
npm run package:smoke  # start the built binary and check it end to end
```

Requires Node 22+ (the app itself only needs 20). `npm run package:exe` needs
PowerShell and, for the signature-removal step, the Windows SDK's `signtool`.

Two extras:

```bash
npm run test:launcher  # unit tests for the launcher (node --test)
npm run package:icon   # regenerate assets/icon.ico from public/logo.svg
```

`assets/icon.ico` is committed, so only re-run `package:icon` when the logo
changes.

## How it works

```
OpenAdmin-win-x64.exe
├── the Node.js runtime          (node.exe, unmodified except for the below)
└── NODE_SEA_BLOB section
    ├── launcher.cjs             launcher/src/*.ts, bundled by esbuild
    └── payload.zip              the application

first run                        every run after
─────────                        ───────────────
extract payload.zip to           skip extraction (completion marker)
%LOCALAPPDATA%\...\app\<ver>     start the server in-process
generate a sign-in password      open the browser, signed in
```

The launcher starts Next.js **inside its own process** — there is no child
process, and nothing executable is ever written to disk. That is deliberate:
antivirus heuristics treat a program that drops and runs an `.exe` far more
suspiciously than one that writes `.js` files.

State lives in `%LOCALAPPDATA%\GoogleWorkspaceOpenAdmin\data`, separate from
the versioned `app\` directory, so an upgrade replaces the application and
keeps tenants, sign-on config, the audit log and imported keys.

**Signing in is automatic.** The launcher holds the sign-in password, so making
the person type it into the browser window the launcher just opened protects
nothing; it is only something to forget. Once the server is up, the launcher
trades the password for a one-time ticket (`POST /api/auth/launch-ticket`) and
opens the browser on the URL that redeems it (`/api/auth/launch?ticket=…`). A
second double-click while it is running does the same against the running
copy, which is also how someone gets back in after a session expires.

- The ticket is 32 random bytes, works once, and dies after a minute, so the
  URL left in the browser's history is worthless.
- Getting a ticket is the login route with a different reward: same password
  check, same failure bucket and delay, same refusal when single sign-on is
  enforced. It is not a second place to guess the password.
- Both routes answer 404 unless this is the packaged build, so a server run
  from source, in Docker or behind a proxy doesn't have them at all.
- It only happens when bound to loopback. With `--host`, people sign in the
  ordinary way. `--no-auto-sign-in` turns it off on this machine too.
- If no ticket can be had, the browser opens on the sign-in page as before.

So the first run no longer asks for a password: one is generated and saved in
`launcher.json`. It is what the launcher proves itself with, and what another
browser would need.

The password reaches the app as `APP_PASSWORD` in the environment (which
`launcher.env` can set), from `--set-password` (a no-echo prompt), or from the
copy in `launcher.json`. With `--no-auto-sign-in` the first run prompts for
one, as it used to. `--password` works too —
it is what the smoke test uses — but on a shared machine prefer any of the
others: argv is readable by every other user through `ps` or Task Manager, and
shells keep it in history. The launcher says so on stderr when you pass it, and
deliberately not into `launcher.log`.

Two behaviours exist for the person who double-clicked the file and has no
command line to fall back on:

- **A busy port moves to the next free one**, for that run only — the remembered
  port isn't changed, so the usual address is back once it's free. Asking for a
  port by name with `--port` is different: that is refused if it's taken (exit
  code 3), because whoever typed it wants that port or an error.
- **On Windows, a failed start waits for a key.** A double-clicked console
  window closes the moment the process exits, taking the explanation with it.
  "No arguments on an interactive console" is the stand-in for "double-clicked"
  (`launcher/src/window.ts`); anything scripted passes arguments or has no
  terminal, and never waits.

**Portable mode** — everything beside the executable instead of in the user
profile — is switched on by a `portable.txt` next to it. A `data` folder there
counts too, but only if it holds a `launcher.json` from an earlier portable run.
A bare `data` folder is ignored: the file is usually run from Downloads or the
Desktop, where a folder with that name probably belongs to something else.

## Three things that will bite you

**1. The bind address decides which URL works.** In a standalone build Next
treats the address it bound as the canonical host, and the app's CSRF check
compares the browser's `Origin` against it. Anything that isn't the local
machine — a LAN address, a public hostname through a tunnel — is rejected with
403 unless the operator lists it in `APP_ALLOWED_ORIGINS`. The launcher binds
`127.0.0.1` and advertises `http://localhost:<port>` — which is also what makes
the `Secure` session cookie work over plain HTTP, since browsers treat
`localhost` as a trustworthy origin. This applies to `next start` too, not
just the exe; see `docs/DEPLOY-CLOUDFLARE.md`.

**2. `next build` does not copy everything.** The standalone output leaves out
`public/` and `.next/static`; `build-payload.mjs` copies both. Forget them and
you get an app with no stylesheet and no logo, which still returns HTTP 200 —
hence the smoke test asserting on both.

**3. The launcher's `argv` has two leading slots**, the same as `node
script.js`: `[resolved executable, invoked path, ...user arguments]`. Verified
against a real single-executable build. Don't "fix" `slice(2)` to `slice(1)`.

## Files

| File | Role |
|---|---|
| `build-payload.mjs` | Stage the standalone output + static + public, prune, zip, hash |
| `build-launcher.mjs` | esbuild the launcher, write `sea-config.json`, produce the blob |
| `build-exe.ps1` | Windows: copy `node.exe`, strip its signature, stamp, inject, hash |
| `build-bin.sh` | Linux/macOS equivalent, without the resource stamping |
| `stamp-exe.mjs` | Icon and version resource, via `resedit` (pure JS, no native tool) |
| `make-icon.mjs` | `public/logo.svg` → `assets/icon.ico` |
| `smoke.mjs` | End-to-end test of a built binary (33 checks, one Windows-only skip) |
| `launcher/src/` | The launcher itself — see below |
| `launcher/test/` | `node --test` suites for the pure parts |

| Launcher module | Role |
|---|---|
| `main.ts` | Start-up sequence and the console output the user reads |
| `args.ts` | Flag parsing and `--help` |
| `paths.ts` | Application-data vs portable layout, per-version app directory |
| `config.ts` | `launcher.json`, `launcher.env`, the password prompt |
| `extract.ts` | Zip extraction with a completion marker, retries and pruning |
| `instance.ts` | Lock file, liveness probe, port availability and fallback |
| `server.ts` | Environment contract, in-process start, readiness, shutdown |
| `payload.ts` | Reading the archive out of the executable |
| `browser.ts` | Opening the default browser |
| `signin.ts` | Trading the password for a one-time ticket, so the browser opens signed in |
| `window.ts` | Keeping a double-clicked Windows console open when a start fails |
| `log.ts` | Console plus a rotating file in the data folder |

## Code signing

Unsigned builds work but show a SmartScreen warning on first run, and a
Node single-executable binary (a real `node.exe` with an extra section) can
attract heuristic antivirus detections. Publishing the SHA-256 helps; a real
certificate helps more.

`build-exe.ps1` signs when `WINDOWS_SIGN_COMMAND` is set — it runs that command
with the executable path appended, so any signing tool fits:

```powershell
$env:WINDOWS_SIGN_COMMAND = 'signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /n "Your Company"'
npm run package:exe
```

Azure Trusted Signing is the low-friction option for a project this size: a
small monthly cost, no hardware token, and a GitHub Action that fits the
release workflow.

## Releasing

A release is always the version in `package.json` — that is what the executables
are stamped with — so bump `version` there first and get it onto the default
branch. Then either:

- **From the browser:** Actions → *Release builds* → *Run workflow*, leave the
  branch on `main`, tick **Publish**, run. The `v<version>` tag is created for
  you at the commit that was built.
- **From git:** `git tag v0.3.0 && git push origin v0.3.0`.

`.github/workflows/release.yml` runs the Linux job first (lint, launcher unit
tests, build, smoke test), then the macOS and Windows builds and a Docker image
build in parallel — each executable smoke-tested on its own OS, the image probed
as a running container — and finally publishes every binary with its `.sha256`
to the release, under download instructions written for the admins who will
read that page.

The first job refuses early, before anything is built, when the release could
not be right: a pushed tag that doesn't match `package.json`, a Publish run from
a branch other than the default one, or a version that already has a tag.
Running the workflow with **Publish** unticked builds and tests everything and
publishes nothing, which is how to try a branch on real Windows and macOS.

The download link in the top-level README points at
`releases/latest/download/OpenAdmin-win-x64.exe`, which only works because the
file name carries no version. Keep it that way.

Design rationale, alternatives considered, and the measurements behind these
choices: [`docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md`](../docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md).
