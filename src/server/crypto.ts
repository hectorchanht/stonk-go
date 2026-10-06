/**
 * AES-GCM-256 encryption for per-user IBKR Flex credentials.
 *
 * Runs on Cloudflare Workers (WebCrypto) and Node (globalThis.crypto).
 * The key is read per request — worker env first, process.env fallback —
 * so it works both on Workers (dashboard secrets) and local dev.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

/** base64-encoded 32-byte key, or null when not configured. */
function getKeyB64(): string | null {
  let key: unknown;
  try {
    // On Cloudflare Workers, dashboard secrets live on the worker env.
    key = getCloudflareContext().env.CREDENTIALS_KEY;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  key ??= process.env.CREDENTIALS_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function importKey(): Promise<CryptoKey> {
  const b64 = getKeyB64();
  if (!b64) {
    throw new Error(
      "CREDENTIALS_KEY is not configured. Generate one with `openssl rand -base64 32` and set it as a Worker secret.",
    );
  }
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(b64);
  } catch {
    throw new Error("CREDENTIALS_KEY is not valid base64.");
  }
  if (raw.length !== 32) {
    throw new Error("CREDENTIALS_KEY must decode to exactly 32 bytes.");
  }
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

const te = new TextEncoder();
const td = new TextDecoder();

export interface EncryptedCredentials {
  /** base64(ivToken 12B || ivQueryId 12B) — a fresh IV per field. */
  iv: string;
  encToken: string;
  encQueryId: string;
}

export async function encryptCredentials(
  token: string,
  queryId: string,
): Promise<EncryptedCredentials> {
  const key = await importKey();
  const ivToken = crypto.getRandomValues(new Uint8Array(12));
  const ivQueryId = crypto.getRandomValues(new Uint8Array(12));
  const [ctToken, ctQueryId] = await Promise.all([
    crypto.subtle.encrypt({ name: "AES-GCM", iv: ivToken }, key, te.encode(token)),
    crypto.subtle.encrypt({ name: "AES-GCM", iv: ivQueryId }, key, te.encode(queryId)),
  ]);
  const iv = new Uint8Array(24);
  iv.set(ivToken, 0);
  iv.set(ivQueryId, 12);
  return {
    iv: bytesToB64(iv),
    encToken: bytesToB64(new Uint8Array(ctToken)),
    encQueryId: bytesToB64(new Uint8Array(ctQueryId)),
  };
}

export async function decryptCredentials(
  iv: string,
  encToken: string,
  encQueryId: string,
): Promise<{ token: string; queryId: string }> {
  const key = await importKey();
  const ivBytes = b64ToBytes(iv);
  if (ivBytes.length !== 24) {
    throw new Error("Stored credentials are corrupt (bad IV length).");
  }
  const [token, queryId] = await Promise.all([
    crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv: ivBytes.slice(0, 12) },
        key,
        b64ToBytes(encToken),
      )
      .then((b) => td.decode(b)),
    crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv: ivBytes.slice(12, 24) },
        key,
        b64ToBytes(encQueryId),
      )
      .then((b) => td.decode(b)),
  ]);
  return { token, queryId };
}
