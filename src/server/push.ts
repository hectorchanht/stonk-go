import "server-only";

/**
 * Minimal Web Push sender for Cloudflare Workers.
 * Uses VAPID authentication (JWT signed with the private key).
 */

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(b64 + pad);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function createVapidJwt(
  audience: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: "mailto:hello@holdr.lol",
  };
  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(`${headerB64}.${payloadB64}`);

  // Import private key (raw 32 bytes) for ECDSA
  const privBytes = base64UrlDecode(privateKey);
  const pubBytes = base64UrlDecode(publicKey);
  // Construct JWK from raw keys (P-256)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(pubBytes.slice(1, 33)),
    y: base64UrlEncode(pubBytes.slice(33, 65)),
    d: base64UrlEncode(privBytes),
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  // Convert DER to raw R||S (WebCrypto gives DER for ECDSA)
  const der = new Uint8Array(sig);
  // Simple DER parse (assumes 70-72 byte signature)
  let offset = 4;
  const rLen = der[offset - 1]!;
  const r = der.slice(offset, offset + rLen);
  offset += rLen + 2;
  const sLen = der[offset - 1]!;
  const s = der.slice(offset, offset + sLen);
  const raw = new Uint8Array(64);
  raw.set(r.slice(-32), 32 - Math.min(32, r.length));
  raw.set(s.slice(-32), 64 - Math.min(32, s.length));
  const sigB64 = base64UrlEncode(raw);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send a push notification. Note: this sends unencrypted (no payload encryption)
 * — the service worker shows a generic message. For full payload encryption,
 * we'd need AES-GCM with the p256dh key.
 */
export async function sendPush(
  sub: PushSubscription,
  title: string,
  body: string,
  url = "/",
): Promise<boolean> {
  try {
    const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublic || !vapidPrivate) {
      console.error("VAPID keys not configured");
      return false;
    }
    const endpoint = new URL(sub.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;
    const jwt = await createVapidJwt(audience, vapidPublic, vapidPrivate);

    // For simplicity, send without payload (service worker shows default).
    // Full implementation would encrypt with p256dh/auth via AES-GCM.
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapidPublic}`,
        TTL: "86400",
      },
    });
    if (res.status === 410 || res.status === 404) {
      // Subscription expired — caller should delete it.
      return false;
    }
    return res.ok;
  } catch (e) {
    console.error("Push send failed:", e);
    return false;
  }
}
