import type { BrowserContext } from "playwright-core";

/**
 * Masks the most commonly checked automation fingerprints on every page in
 * the given context. Used both by the local bootstrap-login script and the
 * production job — the latter runs on `@sparticuz/chromium`, which only
 * supports `chrome-headless-shell` (a stripped-down, more easily
 * fingerprinted headless build), making it more likely than a locally
 * installed browser to be detected and served reduced/blocked content by a
 * site's bot-detection layer even with a valid, already-authenticated
 * session.
 *
 * This doesn't defeat every bot check (nothing short of a real, non-CDP
 * browser reliably does), but it removes the cheapest, most common signals.
 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - non-standard, only present when Chrome DevTools Protocol drives the page
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
}
