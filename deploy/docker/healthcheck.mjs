// Docker health check for the Open Admin image (see the Dockerfile).
//
// Healthy means the server answers on the port it was configured with
// ($PORT), it is configured to serve at all (APP_PASSWORD is set: without it
// every API call answers 503), and it can save its state ($OPEN_ADMIN_DATA_DIR
// is writable by the user the server runs as - a volume mounted from the host
// with the wrong owner is the usual way that breaks). It needs no session: an
// API call without one answers 401 once the request gate is up and configured.

import fs from "node:fs";
import http from "node:http";

function unhealthy(reason) {
  console.error(`open-admin: unhealthy: ${reason}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  unhealthy(`PORT is not a usable port number (${process.env.PORT})`);
}

// Bound to every address (the image's default), the server is reached on loopback.
const bind = (process.env.HOSTNAME || "0.0.0.0").replace(/^\[(.*)\]$/, "$1");
const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;

const dataDir = process.env.OPEN_ADMIN_DATA_DIR;
if (dataDir) {
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    unhealthy(`${dataDir} is not writable, so settings, tenants and the audit log cannot be saved`);
  }
}

const request = http.get({ host, port, path: "/api/auth/session", timeout: 4000 }, (response) => {
  response.resume();
  if (response.statusCode === 401) process.exit(0);
  if (response.statusCode === 503) unhealthy("APP_PASSWORD is not set, so the app refuses to serve");
  unhealthy(`unexpected answer ${response.statusCode} from /api/auth/session`);
});
request.on("timeout", () => {
  request.destroy();
  unhealthy(`no answer on ${host}:${port} within 4 seconds`);
});
request.on("error", (e) => unhealthy(`cannot reach ${host}:${port} (${e.code || e.message})`));
