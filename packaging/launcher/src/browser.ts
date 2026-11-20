import { spawn, type ChildProcess } from "node:child_process";

/**
 * Open the app in the user's default browser. Never throws: failing to open a
 * window is a nuisance, not a reason to stop the server the user asked for.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const options = { detached: true, stdio: "ignore" as const };
    let child: ChildProcess;
    if (platform === "win32") {
      // The empty string is cmd's window title, which `start` would otherwise
      // take from the URL and then treat the URL as a file path.
      child = spawn("cmd", ["/c", "start", "", url], { ...options, windowsHide: true });
    } else if (platform === "darwin") {
      child = spawn("open", [url], options);
    } else {
      child = spawn("xdg-open", [url], options);
    }
    // A missing opener (a server with no desktop, say) is reported as an
    // 'error' event after spawn returns, which the try/catch here never sees.
    // Unhandled, it lands in the server's uncaught-exception log as a stack
    // trace. The "Ready: <url>" line already tells the user where to go.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Reported by the caller's "Ready: <url>" message instead.
  }
}
