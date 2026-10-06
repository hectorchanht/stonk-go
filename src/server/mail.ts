import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Shared Resend email sender (Cloudflare Workers have no SMTP).
 * Used by price alerts; the magic-link flow in ~/server/auth.ts has its own
 * copy so a change here can never break sign-in.
 */

function getResendKey(): string | null {
  let key: unknown;
  try {
    // On Cloudflare Workers, dashboard secrets live on the worker env.
    key = getCloudflareContext().env.RESEND_API_KEY;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  key ??= process.env.RESEND_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function getEmailFrom(): string {
  let from: unknown;
  try {
    from = getCloudflareContext().env.EMAIL_FROM;
  } catch {
    // ignore — fall through to process.env
  }
  from ??= process.env.EMAIL_FROM;
  return typeof from === "string" && from.length > 0
    ? from
    : "Holdr <login@holdr.lol>";
}

/** Send a transactional email via Resend. Throws when unconfigured or rejected. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const apiKey = getResendKey();
  if (!apiKey) {
    throw new Error("Email is not configured: set the RESEND_API_KEY secret.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: getEmailFrom(),
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      ...(opts.html ? { html: opts.html } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Never include the API key in the error.
    throw new Error(
      `Could not send email (Resend responded ${res.status}). ${body.slice(0, 200)}`,
    );
  }
}
