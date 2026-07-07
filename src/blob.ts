import { get, put } from "@vercel/blob";

/**
 * Thin wrapper around @vercel/blob shared by the session and ledger stores.
 * Blobs are written with a stable pathname (no random suffix) so subsequent
 * runs can find the same object again by pathname.
 *
 * Both blobs live in a private store: reads require an authenticated
 * `get()` call (no public URL access), which matters since one of them is
 * the encrypted login session.
 */

export async function readBlob(pathname: string, token: string): Promise<string | null> {
  const result = await get(pathname, { access: "private", token });
  if (!result) return null;

  return new Response(result.stream).text();
}

export async function writeBlob(
  pathname: string,
  contents: string,
  token: string,
  contentType = "text/plain",
): Promise<void> {
  // We want a stable session/ledger key that gets overwritten on every
  // write, not a new randomly-suffixed blob each time — that requires both
  // addRandomSuffix: false AND allowOverwrite: true (the latter defaults to
  // false and otherwise throws once a blob already exists at this pathname).
  await put(pathname, contents, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    token,
  });
}
