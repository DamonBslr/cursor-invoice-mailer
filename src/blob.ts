import { list, put } from "@vercel/blob";

/**
 * Thin wrapper around @vercel/blob shared by the session and ledger stores.
 * Blobs are written with a stable pathname (no random suffix) so subsequent
 * runs can find the same object again via `list({ prefix })`.
 */

export async function readBlob(pathname: string, token: string): Promise<string | null> {
  const { blobs } = await list({ prefix: pathname, token, limit: 1 });
  const match = blobs.find((b) => b.pathname === pathname);
  if (!match) return null;

  const res = await fetch(match.url);
  if (!res.ok) {
    throw new Error(`Failed to fetch blob "${pathname}": ${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function writeBlob(
  pathname: string,
  contents: string,
  token: string,
  contentType = "text/plain",
): Promise<void> {
  // With addRandomSuffix: false, Vercel Blob overwrites any existing blob at
  // the same pathname, which is exactly what we want for a stable session/ledger key.
  await put(pathname, contents, {
    access: "public",
    addRandomSuffix: false,
    contentType,
    token,
  });
}
