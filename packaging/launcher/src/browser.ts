import { spawn } from "node:child_process";

/**
 * Open the app in the user's default browser. Never throws: failing to open a
 * window is a nuisance, not a reason to stop the server the user asked for.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const options = { detached: true, stdio: "ignore" as const };
    if (platform === "win32") {
      // The empty string is cmd's window title, which `start` would otherwise
      // take from the URL and then treat the URL as a file path.
      spawn("cmd", ["/c", "start", "", url], { ...options, windowsHide: true }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], options).unref();
    } else {
      spawn("xdg-open", [url], options).unref();
    }
  } catch {
    // Reported by the caller's "open <url>" message instead.
  }
}
