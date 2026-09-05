# Packaging: the single-file build

This folder turns Open Admin into one executable a Workspace admin can
download and double-click. No Node.js, no `npm install`, no `gws` CLI on the
target machine — the runtime and the whole application are inside the file.

Users don't need anything here. Point them at the release: **[Windows download
and run](../README.md#-windows-download-and-run)**.

## What gets built

| Artifact | Size | Notes |
|---|---|---|
| `dist/payload.zip` | ~6 MB | The `next build` standalone output plus `public/` and `.next/static` |
| `dist/sea-prep.blob` | ~6 MB | The bundled launcher plus that archive, as a Node single-executable blob |
| `dist/OpenAdmin-win-x64.exe` | ~93 MB | `node.exe` with the blob injected, icon and version stamped |
| `dist/open-admin` | ~125 MB | Same thing for Linux/macOS, used by CI to test the pipeline |

## Build it

Everything runs from the repository root.

```bash
npm ci
npm run package        # next build -> payload.zip -> sea-prep.blob
npm run package:exe    # Windows: assemble OpenAdmin-win-x64.exe
npm run package:bin    # Linux/macOS: assemble ./packaging/dist/open-admin
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
ask for an admin password        open the browser
```

The launcher starts Next.js **inside its own process** — there is no child
process, and nothing executable is ever written to disk. That is deliberate:
antivirus heuristics treat a program that drops and runs an `.exe` far more
suspiciously than one that writes `.js` files.

State lives in `%LOCALAPPDATA%\GoogleWorkspaceOpenAdmin\data`, separate from
the versioned `app\` directory, so an upgrade replaces the application and
keeps tenants, sign-on config, the audit log and imported keys.

## Three things that will bite you

**1. The bind address decides which URL works.** In a standalone build Next
treats the address it bound as the canonical host, and the app's CSRF check
compares the browser's `Origin` against it. Bind `0.0.0.0` and *every*
mutating request is rejected with 403. The launcher binds `127.0.0.1` and
advertises `http://localhost:<port>` — which is also what makes the `Secure`
session cookie work over plain HTTP, since browsers treat `localhost` as a
trustworthy origin. This applies to `next start` too, not just the exe.

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
| `smoke.mjs` | End-to-end test of a built binary (25 checks) |
| `launcher/src/` | The launcher itself — see below |
| `launcher/test/` | `node --test` suites for the pure parts |

| Launcher module | Role |
|---|---|
| `main.ts` | Start-up sequence and the console output the user reads |
| `args.ts` | Flag parsing and `--help` |
| `paths.ts` | Application-data vs portable layout, per-version app directory |
| `config.ts` | `launcher.json`, `launcher.env`, the password prompt |
| `extract.ts` | Zip extraction with a completion marker, retries and pruning |
| `instance.ts` | Lock file, liveness probe, port availability |
| `server.ts` | Environment contract, in-process start, readiness, shutdown |
| `payload.ts` | Reading the archive out of the executable |
| `browser.ts` | Opening the default browser |
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

Bump `version` in `package.json`, commit, then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release-windows.yml` builds the Linux binary and runs the
launcher tests and smoke test first, then builds, smoke-tests and publishes the
Windows executable with its `SHA256SUMS.txt`. `workflow_dispatch` runs the same
pipeline without publishing.

Design rationale, alternatives considered, and the measurements behind these
choices: [`docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md`](../docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md).
