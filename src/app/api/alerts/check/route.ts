import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getDb } from "~/server/db";
import { getQuotes, inferCurrency } from "~/server/market";
import { sendEmail } from "~/server/mail";

/**
 * Price-alert checker. Called by a scheduled job (not by users):
 *   GET /api/alerts/check?key=<ALERTS_CRON_KEY>
 *
 * For every active alert it fetches a live quote, records the last price,
 * and when the target is hit it emails the owner (Resend) and deactivates
 * the alert. Alerts are one-shot by design.
 */

function getCronKey(): string | null {
  let key: unknown;
  try {
    key = getCloudflareContext().env.ALERTS_CRON_KEY;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  key ??= process.env.ALERTS_CRON_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

const curSym = (symbol: string) => (inferCurrency(symbol) === "HKD" ? "HK$" : "$");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = getCronKey();
  if (!expected || url.searchParams.get("key") !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const alerts = await db.priceAlert.findMany({ where: { active: true } });
  if (alerts.length === 0) {
    return Response.json({ checked: 0, triggered: [] });
  }

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const quotes = await getQuotes(symbols);
  const priceOf = new Map(
    quotes.map((q) => [q.symbol.trim().toUpperCase(), q.price]),
  );

  const triggered: string[] = [];
  for (const a of alerts) {
    const px = priceOf.get(a.symbol.trim().toUpperCase()) ?? null;
    await db.priceAlert.update({
      where: { id: a.id },
      data: { lastPrice: px },
    });
    if (px == null) continue;
    const hit =
      a.direction === "above" ? px >= a.targetPrice : px <= a.targetPrice;
    if (!hit) continue;

    await db.priceAlert.update({
      where: { id: a.id },
      data: { active: false, triggeredAt: new Date() },
    });
    const cs = curSym(a.symbol);
    const verb = a.direction === "above" ? "hit" : "dropped to";
    const subject = `🔔 ${a.symbol} ${verb} ${cs}${a.targetPrice}`;
    try {
      await sendEmail({
        to: a.email,
        subject,
        text:
          `Holdr price alert\n\n` +
          `${a.symbol} is now ${cs}${px} — it ${verb} your ${cs}${a.targetPrice} target.\n\n` +
          `View your portfolio: https://holdr.lol`,
        html:
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">` +
          `<h2>🔔 ${esc(a.symbol)} ${verb} ${esc(cs)}${a.targetPrice}</h2>` +
          `<p>Now <b>${esc(cs)}${px}</b> (your target: ${esc(cs)}${a.targetPrice}).</p>` +
          `<p><a href="https://holdr.lol" style="display:inline-block;padding:10px 20px;background:#059669;color:#fff;text-decoration:none;border-radius:8px">Open Holdr</a></p>` +
          `</div>`,
      });
      triggered.push(a.symbol);
    } catch (e) {
      // The alert did trigger — keep it deactivated, but report the mail failure.
      triggered.push(
        `${a.symbol} (triggered, email failed: ${e instanceof Error ? e.message : "unknown"})`,
      );
    }
  }

  return Response.json({ checked: alerts.length, triggered });
}
