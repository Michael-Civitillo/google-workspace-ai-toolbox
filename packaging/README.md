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
| `dist/payload-manifest.json` | ~0.3 MB | Every payload file's path, size and SHA-256, baked into the launcher |
| `dist/sea-prep.blob` | ~7 MB | The bundled launcher plus that archive, as a Node single-executable blob |
| `dist/OpenAdmin-win-x64.exe` | ~93 MB | `node.exe` with the blob injected, icon and version stamped |
| `dist/open-admin-linux-x64` | ~111 MB | The Linux runtime, symbols stripped, with the blob injected |
| `dist/open-admin-macos-arm64` | ~110 MB | The macOS runtime with the blob injected, ad-hoc signed |

What goes into the payload is an allow-list: `server.js`, `package.json`,
`.next/`, `node_modules/` and `public/`. Next's file tracer copies the whole
project folder into `.next/standalone`, so anything else beside the code (a
key file kept there, say) would otherwise ship; `npm run build` deletes
everything outside the list and fails if anything is left, or if `server.js`
is not at the top (`outputFileTracingRoot` is pinned to the project folder in
`next.config.ts` so the output is never nested). The build folder's absolute
path is replaced with `.` in the two files that record it.

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
extract payload.zip to           check the unpacked copy against the
%LOCALAPPDATA%\...\app\<ver>       manifest (unpack again if it fails)
generate a sign-in password      start the server in-process
                                 open the browser, signed in
```

The launcher starts Next.js **inside its own process** — there is no child
process, and nothing executable is ever written to disk. That is deliberate:
antivirus heuristics treat a program that drops and runs an `.exe` far more
suspiciously than one that writes `.js` files.

State lives in `%LOCALAPPDATA%\GoogleWorkspaceOpenAdmin\data`, separate from
the versioned `app\` directory, so an upgrade replaces the application and
keeps tenants, sign-on config, the audit log and imported keys. On macOS and
Linux the data folder is made private to its owner; on Windows the launcher
warns when it lies outside the user profile.

**The unpacked copy is checked before every start** against a manifest of
every file's size and SHA-256 that is baked into the launcher. In the
per-user folder every file must be present at its size (about 10 ms for the
2,340 files on Linux); outside it (portable mode, `--root`) every file is
read and hashed, nothing extra may be present and links are refused (about
70 ms warm, 220 ms from a cold disk). A copy that fails is replaced from the
embedded archive, whose hash is checked when it is unpacked; so is one whose
code fails to load. A check cannot stop a file being swapped after it, while
the server runs, so a folder other people can write to is still no place to
run the program from.

**Two launches at once take turns.** Everything from "is it already
running?" to "the server is up" happens under a lock file in the data folder
(created exclusively, taken over when its process is gone), and unpacking and
clean-up under another in the application folder. A second double-click
while the first is still unpacking waits for it, then opens it. Clean-up and
`--reset-app-cache` only ever delete the launcher's own folders
(`<version>-<hash12>` with its completion marker, and its temporary
`.tmp-<pid>` and `.del-` folders), never anything else that sits there.

**Signing in is automatic.** The launcher holds the sign-in password, so making
the person type it into the browser window the launcher just opened protects
nothing; it is only something to forget. Once the server is up, the launcher
trades the password for a one-time ticket (`POST /api/auth/launch-ticket`) and
opens the browser on the URL that redeems it (`/api/auth/launch?ticket=…`). A
second double-click while it is running does the same against the running
copy, which is also how someone gets back in after a session expires.

- The running copy has to prove itself first. Each start generates a random
  instance token, hands it to the server (`OPEN_ADMIN_INSTANCE_TOKEN`) and
  keeps it in `launcher.lock`, which only its owner can read. A later launch
  sends the server a fresh challenge (`GET /api/auth/launch-ticket?challenge=…`)
  and sends the password only if the answer is the HMAC of that challenge
  under the token. Anything else listening on the lock's port (a lock left
  behind by a closed window, a reused process id) gets nothing, and the
  launch starts a copy of its own on the next free port instead. The one
  exception is a copy from 0.2.0 or earlier that is still open (its lock has
  no token, and its port answers with Open Admin's sign-in page): the launch
  says so and stops, because two servers must not share one data folder.
- The ticket is 32 random bytes, works once, and dies after a minute, so the
  URL left in the browser's history is worthless.
- On macOS and Linux, where any local user can read other processes' command
  lines, the ticket URL is not passed to the browser opener: it goes into a
  small page in the data folder, readable by its owner only, that forwards the
  browser and is deleted two minutes later. (Not on Windows, which doesn't
  show one user's command lines to another. On Linux, only when `.html` files
  open in the default browser, and not when that browser is a snap, which
  can't read the hidden folder the page would be in; otherwise the URL is
  passed as before. On macOS, someone who has set `.html` files to open in
  another program gets that program: the console says which address to open
  by hand.)
  The opener and browser are started without the launcher's secrets in their
  environment.
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
`launcher.env` can set, and which is used for that run without being saved),
from `--set-password` (a no-echo prompt), or from the copy in `launcher.json`.
With `--no-auto-sign-in` the first run prompts for one, as it used to; with no
terminal to prompt on, one is generated and the launcher says where it is
saved rather than printing it. `--password` works too —
it is what the smoke test uses — but on a shared machine prefer any of the
others: argv is readable by every other user through `ps` or Task Manager, and
shells keep it in history. The launcher says so on stderr when you pass it, and
deliberately not into `launcher.log`.

Two behaviours exist for the person who double-clicked the file and has no
command line to fall back on:

- **A busy port moves to the next free one**, for that run only — the remembered
  port isn't changed, so the usual address is back once it's free. Asking for a
  port by name with `--port` is different: that is refused if it's taken (exit
  code 3), because whoever typed it wants that port or an error. A loopback
  port also counts as taken when another program listens on it at the other
  loopback address (`::1` beside `127.0.0.1`), since a browser sent to
  `localhost` may try either.
- **On Windows, a failed start waits for a key.** A double-clicked console
  window closes the moment the process exits, taking the explanation with it.
  "No arguments on an interactive console" is the stand-in for "double-clicked"
  (`launcher/src/window.ts`); anything scripted passes arguments or has no
  terminal, and never waits.

**Portable mode** — everything beside the executable instead of in the user
profile — is switched on by a `portable.txt` next to it. A `data` folder there
counts too, but only if it holds a `launcher.json` from an earlier portable run.
A bare `data` folder is ignored: the file is usually run from Downloads or the
Desktop, where a folder with that name probably belongs to something else. The
launcher says when portable mode is on and which file turned it on, and checks
every unpacked file by hash before each start (see above).

**`launcher.env` may not** set anything that turns off or widens certificate
checks or chooses code to load or run: `NODE_TLS_REJECT_UNAUTHORIZED`,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_OPTIONS`,
`NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_COMPILE_CACHE`, `OPENSSL_*`
(`CONF`, `MODULES`, `ENGINES`), `LD_*`, `DYLD_*`, `PATH`, `PATHEXT`, `COMSPEC`
and `GWS_BIN`. They are ignored with a warning; set them in the environment
if you really need one. Proxy settings (`HTTPS_PROXY`, `NO_PROXY`, …) are
accepted.

## Three things that will bite you

**1. The bind address decides which URL works.** In a standalone build Next
treats the address it bound as the canonical host, and the app's CSRF check
compares the browser's `Origin` against it. Anything that isn't the local
machine — a LAN address, a public hostname through a tunnel — is rejected with
403 unless the operator lists it in `APP_ALLOWED_ORIGINS`. The launcher binds
`127.0.0.1` and advertises `http://localhost:<port>` — which is also what makes
the `Secure` session cookie work over plain HTTP, since browsers treat
`localhost` as a trustworthy origin. This applies to `next start` too, not
just the exe; see `docs/DEPLOY-CLOUDFLARE.md`. Bound to every address
(`--host 0.0.0.0` or `::`), the launcher waits for the server, and opens it, on
loopback: Windows refuses connections to `0.0.0.0` itself.

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
| `build-payload.mjs` | Stage the standalone output + static + public, allow-list, scrub the build path, zip, hash, write the file manifest |
| `build-launcher.mjs` | esbuild the launcher (with the manifest baked in), write `sea-config.json`, produce the blob |
| `build-exe.ps1` | Windows: copy `node.exe`, strip its signature, stamp, inject, hash |
| `build-bin.sh` | Linux/macOS equivalent, without the resource stamping; strips the Linux runtime's symbols |
| `stamp-exe.mjs` | Icon and version resource, via `resedit` (pure JS, no native tool) |
| `make-icon.mjs` | `public/logo.svg` → `assets/icon.ico` |
| `smoke.mjs` | End-to-end test of a built binary (62 checks, four of them skipped on Windows) |
| `launcher/src/` | The launcher itself — see below |
| `launcher/test/` | `node --test` suites for the pure parts |

| Launcher module | Role |
|---|---|
| `main.ts` | Start-up sequence and the console output the user reads |
| `args.ts` | Flag parsing and `--help` |
| `paths.ts` | Application-data vs portable layout, per-version app directory |
| `datadir.ts` | Creating the data folder privately, and warning when others can read it |
| `config.ts` | `launcher.json`, `launcher.env` (and what it may not set), the password prompt |
| `settings.ts` | Merging stored, environment and command-line settings; what gets saved |
| `extract.ts` | Zip extraction with a completion marker, retries, and deleting only our own folders |
| `verify.ts` | Checking an unpacked copy against the manifest baked in at build time |
| `lock.ts` | Exclusive lock files, so two launches take turns |
| `instance.ts` | Lock file, liveness probe, the instance-token proof, port availability and fallback |
| `address.ts` | Bind address vs the address to reach and to open |
| `server.ts` | Environment contract, in-process start, readiness, shutdown |
| `payload.ts` | Reading the archive out of the executable |
| `browser.ts` | Opening the default browser, without secrets on its command line or in its environment |
| `signin.ts` | Trading the password for a one-time ticket, so the browser opens signed in |
| `fsutil.ts` | Retries for Windows file locks, owner-only atomic writes |
| `window.ts` | Keeping a double-clicked Windows console open when a start fails |
| `log.ts` | Console plus a rotating file in the data folder |

Exit codes: 2 bad arguments, 3 port taken, 4 unpacking failed, 5 the server
did not start, 6 another copy has been starting for more than three minutes,
7 an older version (0.2.0 or earlier) is still running on the same data
folder: close its window first.

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
- **From git:** `git tag v0.3.0 && git push origin v0.3.0`, on a commit that is
  on the default branch.

`.github/workflows/release.yml` runs the Linux job first (lint, launcher unit
tests, build, smoke test), then the macOS and Windows builds and a Docker image
build in parallel — each executable smoke-tested on its own OS, the image probed
as a running container — and finally publishes every binary with its `.sha256`
to the release, under download instructions written for the admins who will
read that page.

Only those two kinds of run publish. The first job decides, and refuses
early, before anything is built, when the release could not be right: a
pushed tag that doesn't match `package.json` or whose commit is not on the
default branch, a Publish run from anything but the default branch, a
version that already has a tag (for a Publish run) or a release (for either),
or a check that could not be made. The publish job checks again, one run per
version at a time, so a re-pushed tag or two runs at once never overwrite a
release. Running the workflow with **Publish** unticked builds and tests
everything and publishes nothing, even when started from a tag, which is how
to try a branch on real Windows and macOS.

Actions are pinned by commit, with the release they are in a comment beside
each; Node is pinned to an exact version (`22.23.5`). Update both on purpose.

The download link in the top-level README points at
`releases/latest/download/OpenAdmin-win-x64.exe`, which only works because the
file name carries no version. Keep it that way.

Design rationale, alternatives considered, and the measurements behind these
choices: [`docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md`](../docs/WINDOWS-SINGLE-EXE-ARCHITECTURE.md).
