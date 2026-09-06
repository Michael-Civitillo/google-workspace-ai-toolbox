#!/usr/bin/env node
/**
 * Give the Windows executable its icon and version resource, so Explorer shows
 * a logo instead of the Node.js one and the Properties dialog names the app.
 *
 * Runs before postject: this rewrites the PE resource section, and doing it
 * after a blob has been appended risks disturbing the injected section.
 *
 * Usage: node packaging/stamp-exe.mjs <exe> <version> [icon.ico]
 */
import fs from "node:fs";
import {
  Data,
  NtExecutable,
  NtExecutableResource,
  Resource,
} from "resedit";

const [exePath, version, iconPath] = process.argv.slice(2);
if (!exePath || !version) {
  console.error("usage: node stamp-exe.mjs <exe> <version> [icon.ico]");
  process.exit(2);
}

const [major = 0, minor = 0, patch = 0] = version.split(".").map((n) => Number(n) || 0);

const executable = NtExecutable.from(fs.readFileSync(exePath));
const resources = NtExecutableResource.from(executable);

if (iconPath && fs.existsSync(iconPath)) {
  const icon = Data.IconFile.from(fs.readFileSync(iconPath));
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    1033, // en-US
    icon.icons.map((i) => i.data)
  );
}

const versionInfo = Resource.VersionInfo.createEmpty();
versionInfo.setFileVersion(major, minor, patch, 0, 1033);
versionInfo.setProductVersion(major, minor, patch, 0, 1033);
versionInfo.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    ProductName: "Google Workspace Open Admin",
    FileDescription: "Google Workspace Open Admin (single-file build)",
    CompanyName: "Google Workspace Open Admin contributors",
    LegalCopyright: "MIT License",
    OriginalFilename: "OpenAdmin-win-x64.exe",
    InternalName: "OpenAdmin",
  }
);
versionInfo.outputToResourceEntries(resources.entries);

resources.outputResource(executable);
fs.writeFileSync(exePath, Buffer.from(executable.generate()));

console.log(
  `stamp-exe: ${exePath} is now version ${version}` +
    (iconPath && fs.existsSync(iconPath) ? " with an icon" : " (no icon file)")
);
