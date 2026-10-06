import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createD1Db } from "~/server/d1db";
import { sendPush } from "~/server/push";
import { getQuotes } from "~/server/market";

/**
 * Background alert checker — called by Cloudflare Cron Trigger.
 * Checks price alerts and sends push notifications.
 *
 * Configure cron in wrangler.jsonc triggers.
 */
export async function GET(req: NextRequest) {
  // Simple auth: require cron secret
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { env } = getCloudflareContext();
    const db = createD1Db((env as { DB: unknown }).DB as never);

    // Get active price alerts
    const alerts = await db.priceAlert.findMany({
      where: { active: true },
    });
    if (alerts.length === 0) {
      return NextResponse.json({ checked: 0 });
    }

    // Get current prices
    const symbols = [...new Set(alerts.map((a) => a.symbol))];
    const quotes = await getQuotes(symbols);
    const priceMap = new Map(quotes.map((q) => [q.symbol, q.price]));

    // Get push subscriptions
    const subs = await db.pushSubscription.findMany();

    let triggered = 0;
    let pushed = 0;

    for (const alert of alerts) {
      const price = priceMap.get(alert.symbol);
      if (price == null) continue;

      const hit =
        alert.direction === "above"
          ? price >= alert.targetPrice
          : price <= alert.targetPrice;
      if (!hit) {
        // Update lastPrice
        await db.priceAlert.update({
          where: { id: alert.id },
          data: { lastPrice: price },
        });
        continue;
      }

      // Triggered!
      triggered++;
      await db.priceAlert.update({
        where: { id: alert.id },
        data: { triggeredAt: new Date(), lastPrice: price, active: false },
      });

      // Send push to all subscribers
      const title = `${alert.symbol} ${alert.direction === "above" ? "↑" : "↓"} $${price.toFixed(2)}`;
      const body = `Target ${alert.direction} $${alert.targetPrice.toFixed(2)} hit`;
      for (const sub of subs) {
        const ok = await sendPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          title,
          body,
        );
        if (ok) pushed++;
        else {
          // Clean up dead subscription
          try {
            await db.pushSubscription.delete({ where: { endpoint: sub.endpoint } });
          } catch {
            /* ignore */
          }
        }
      }
    }

    return NextResponse.json({ checked: alerts.length, triggered, pushed });
  } catch (e) {
    console.error("Alert check failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
