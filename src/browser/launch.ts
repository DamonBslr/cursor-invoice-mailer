import { dirname } from "node:path";
import type { Browser } from "playwright-core";

/**
 * Launches a Chromium instance appropriate for the current environment:
 *  - On Vercel (serverless): playwright-core + @sparticuz/chromium, a
 *    trimmed Chromium build suited to the Lambda/Vercel function runtime.
 *  - Locally (bootstrap-login, run-once, dev): the full `playwright` package
 *    using a normally-installed browser (`npx playwright install chromium`).
 *
 * Both branches resolve to the same `playwright-core` `Browser` type, so
 * callers don't need to care which environment they're in.
 */
export async function launchBrowser(options: { headless?: boolean } = {}): Promise<Browser> {
  const isServerless = Boolean(process.env.VERCEL);

  if (isServerless) {
    const [{ chromium }, chromiumBinary] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium"),
    ]);

    const executablePath = await chromiumBinary.default.executablePath();

    // Belt-and-suspenders: @sparticuz/chromium normally sets LD_LIBRARY_PATH
    // itself (based on detecting the Lambda/Vercel runtime at import time),
    // but that detection has broken before when Vercel changed which env
    // vars it sets (see https://github.com/Sparticuz/chromium/pull/340) —
    // the executable's shared libraries (e.g. libnss3.so) live alongside it,
    // so pointing the linker at that directory works regardless of whether
    // the package's own runtime detection succeeded.
    const executableDir = dirname(executablePath);
    process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
      ? [executableDir, ...new Set(process.env.LD_LIBRARY_PATH.split(":"))].join(":")
      : executableDir;

    return chromium.launch({
      args: chromiumBinary.default.args,
      executablePath,
      headless: options.headless ?? true,
    });
  }

  // Local: use the full `playwright` package (devDependency) with a browser
  // installed via `npx playwright install chromium`. `playwright`'s Browser
  // type is structurally identical to playwright-core's (it re-exports it).
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: options.headless ?? true });
  return browser as unknown as Browser;
}
