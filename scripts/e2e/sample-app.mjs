// Bring up the packaged app with a sample organisation behind it, and leave it
// running: 131 made-up accounts at example.com, with forwarding, connected
// apps, licences, shared drives and DNS records to find. For taking the README
// screenshots, and for trying a page by hand against something that looks like
// a real tenant without going near one.
//
//   node scripts/e2e/sample-app.mjs
//
// It prints the address and the password, then stays up until Ctrl+C. Every
// "Google" answer comes from fake-google.mjs; nothing leaves this machine.
import fs from "node:fs";
import path from "node:path";
import { ADMIN, OWN_CLIENT_ID } from "./dataset.mjs";
import { claimWorkDir, defaultBinary, parseArgs, requireBinary, signIn, startApp, startStandIn, writeServiceAccountKey } from "./harness.mjs";

const USAGE = `Usage: node scripts/e2e/sample-app.mjs [options]

  --binary <path>        the packaged app to start
                         (default: the one in packaging/dist for this platform)
  --work <folder>        where the app keeps its data (default: a temporary folder)
  --key-path <file>      where to write the sample service-account key. The
                         Tenants page shows this path, so a realistic one
                         makes a better screenshot. Must not exist yet; it is
                         deleted again on exit (default: inside --work)
  --password <text>      the sign-in password (default: sample-app-password)
  --app-port <n>         port for the app (default 3079)
  --stand-in-port <n>    port for the stand-in for Google, which also uses
                         the next port up for DNS (default 4450)`;

const args = parseArgs(
  process.argv.slice(2),
  { binary: defaultBinary(), work: "", "key-path": "", password: "sample-app-password", "app-port": "3079", "stand-in-port": "4450" },
  USAGE
);
const binary = requireBinary(args.binary);
// Checked before anything is created: this script writes a file there, and it
// must never be the one that overwrites somebody's real key.
if (args["key-path"] && fs.existsSync(path.resolve(args["key-path"]))) {
  console.error(`${path.resolve(args["key-path"])} already exists, and --key-path is written to. Name a file that doesn't exist yet.`);
  process.exit(2);
}
const { dir: workDir, temporary } = claimWorkDir(args.work);
const keyFile = path.resolve(args["key-path"] || path.join(workDir, "keys", "example-corp.json"));

let standIn;
let app;
const stop = (code = 0) => {
  app?.stop();
  standIn?.stop();
  // Leave nothing behind: the sample key this run wrote, and the work folder
  // if it was a temporary one. Best effort; the app may still be closing files.
  try {
    fs.rmSync(keyFile, { force: true });
    if (temporary) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Not worth failing an exit over.
  }
  process.exit(code);
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

try {
  standIn = await startStandIn({ dir: path.join(workDir, "tls"), port: Number(args["stand-in-port"]) });
  writeServiceAccountKey(keyFile, { clientId: OWN_CLIENT_ID, clientEmail: "open-admin@example-corp.iam.gserviceaccount.com" });
  app = await startApp({ binary, root: path.join(workDir, "root"), port: Number(args["app-port"]), password: args.password, standIn });

  const { post } = await signIn(app.base, args.password);
  // Two tenants, so the tenant switcher has something to switch between.
  for (const tenant of [
    { name: "Example Corp", adminEmail: ADMIN, credentialsFile: keyFile, color: "blue" },
    { name: "Example Sandbox", adminEmail: "admin@sandbox.example.com", credentialsFile: keyFile, color: "amber" },
  ]) {
    const made = await post("/api/tenants", tenant);
    if (made.status !== 201) throw new Error(`Could not add the tenant "${tenant.name}": ${made.status} ${await made.text()}`);
  }
  // Skip the first-run wizard: this install is already "set up".
  await post("/api/config/onboarding", { completed: true });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  stop(1);
}

console.log(`READY  ${app.base}  (password: ${args.password})`);
console.log("Ctrl+C to stop.");
// Stay up until told to stop.
setInterval(() => {}, 1 << 30);
