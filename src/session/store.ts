import type { Config } from "../config.js";
import { readBlob, writeBlob } from "../blob.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * Loads the encrypted Playwright storageState from Vercel Blob and decrypts
 * it. Returns null if no session has been bootstrapped yet.
 */
export async function loadSession(config: Config): Promise<string | null> {
  const encrypted = await readBlob(config.SESSION_BLOB_KEY, config.BLOB_READ_WRITE_TOKEN);
  if (!encrypted) return null;
  return decrypt(encrypted, config.SESSION_ENCRYPTION_KEY);
}

/**
 * Encrypts and persists a Playwright storageState JSON string to Vercel Blob.
 * Called by the local bootstrap-login script after a successful interactive
 * login.
 */
export async function saveSession(storageStateJson: string, config: Config): Promise<void> {
  const encrypted = encrypt(storageStateJson, config.SESSION_ENCRYPTION_KEY);
  await writeBlob(config.SESSION_BLOB_KEY, encrypted, config.BLOB_READ_WRITE_TOKEN);
}
