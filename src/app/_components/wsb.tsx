"use client";

import type { RouterOutputs } from "~/trpc/react";
import type { PositionFlair } from "~/server/wsb";

type Summary = RouterOutputs["portfolio"]["summary"];
type HoldingRow = Summary["rows"][number];

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const money = (v: number | null, opts?: { sign?: boolean }) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = opts?.sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const pct = (v: number | null, opts?: { sign?: boolean }) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = opts?.sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
};

/** Per-position 💎🙌 / 🧻 badge, judged from the trade log (server-side). */
export function FlairBadge({ flair }: { flair?: PositionFlair | null }) {
  if (!flair) return null;
  const styles =
    flair.badge === "diamond"
      ? "border-sky-700/60 bg-sky-900/40 text-sky-300"
      : flair.badge === "paper"
        ? "border-amber-700/60 bg-amber-900/40 text-amber-300"
        : "border-zinc-700/60 bg-zinc-800/60 text-zinc-400";
  return (
    <span
      title={flair.detail}
      className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${styles}`}
    >
      {flair.label}
    </span>
  );
}

/** The usual suspects. */
const MEME_STOCKS = new Set([
  "GME", "AMC", "BB", "DJT", "PLTR", "TSLA", "NVDA", "SMCI", "MSTR", "HOOD",
  "COIN", "RKLB", "ASTS", "IONQ", "SOFI", "NIO", "RIVN", "LCID", "TLRY",
  "BYND", "PTON", "SNAP", "AFRM", "UPST", "OPEN", "SPCE", "RKT", "CLOV",
  "WKHS", "BBBY", "NOK", "GPRO", "FUBO", "QS", "SKLZ", "ATER", "SNDL",
  "CEI", "MULN", "PROG", "KOSS", "EXPR", "DNUT", "DTC", "BBIG", "WISH",
  "RIDE", "GNUS", "ONDS", "LUNR",
]);

/** Portfolio-level degeneracy score: concentration + meme weight + all-in energy. */
export function YoloMeter({ rows }: { rows: HoldingRow[] }) {
  const priced = rows.filter(
    (r) => r.marketValue != null && r.marketValue > 0 && r.weightPct != null,
  );
  if (priced.length === 0) return null;

  const byWeight = [...priced].sort(
    (a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0),
  );
  const top = byWeight[0]!;
  const topW = top.weightPct ?? 0;
  const memeRows = priced.filter((r) => MEME_STOCKS.has(r.symbol));
  const memeW = memeRows.reduce((s, r) => s + (r.weightPct ?? 0), 0);

  let score = 0;
  score += topW >= 50 ? 40 : topW >= 35 ? 30 : topW >= 25 ? 20 : topW >= 15 ? 10 : 0;
  score += Math.min(30, memeW * 1.5);
  if (priced.length <= 3) score += 10; // all-in energy
  if (priced.length >= 12) score -= 5; // diversified = boring
  score = Math.max(0, Math.min(100, Math.round(score)));

  const rank =
    score >= 76
      ? "💥 APE MODE"
      : score >= 56
        ? "🚀 YOLO"
        : score >= 36
          ? "🎰 DEGEN"
          : score >= 16
            ? "🦍 CAUTIOUS APE"
            : "💼 BOOMER";

  const barColor =
    score >= 76
      ? "from-red-500 to-orange-400"
      : score >= 56
        ? "from-orange-500 to-amber-400"
        : score >= 36
          ? "from-amber-500 to-yellow-400"
          : score >= 16
            ? "from-lime-500 to-emerald-400"
            : "from-emerald-600 to-teal-500";

  return (
    <div className={card}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          🎲 YOLO meter
        </h2>
        <div className="text-sm font-bold text-zinc-300">{rank}</div>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className="text-5xl font-extrabold tabular-nums text-zinc-100">
          {score}
          <span className="text-lg font-semibold text-zinc-500">/100</span>
        </div>
        <div className="flex-1">
          <div className="h-4 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all ${barColor}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            top position {top.symbol} {topW.toFixed(1)}% · meme weight{" "}
            {memeW.toFixed(1)}%
            {memeRows.length > 0 &&
              ` (${memeRows.map((r) => r.symbol).join(", ")})`}{" "}
            · {priced.length} position{priced.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Biggest winner and biggest loser, immortalized as spotlight cards. */
export function GainLossPorn({ rows }: { rows: HoldingRow[] }) {
  const scored = rows.filter((r) => r.totalPL != null);
  if (scored.length === 0) return null;

  const winner = scored.reduce((a, b) =>
    (b.totalPL ?? 0) > (a.totalPL ?? 0) ? b : a,
  );
  const loser = scored.reduce((a, b) =>
    (b.totalPL ?? 0) < (a.totalPL ?? 0) ? b : a,
  );
  const hasGains = (winner.totalPL ?? 0) > 0;

  const num = (v: number | null) => money(v, { sign: true });
  const tone = (v: number | null) =>
    v == null ? "text-zinc-400" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-400";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className={`${card} border-emerald-800/60`}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-emerald-500">
          🏆 Gain porn
        </h2>
        {hasGains ? (
          <>
            <div className="mt-2 text-3xl font-extrabold tabular-nums text-emerald-400">
              {num(winner.totalPL)}
            </div>
            <div className="mt-1 text-lg font-bold text-zinc-100">
              {winner.symbol}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {pct(winner.totalPLPct, { sign: true })}
              </span>
            </div>
            {winner.name && (
              <div className="truncate text-xs text-zinc-500">{winner.name}</div>
            )}
            <div className={`mt-1 text-xs ${tone(winner.totalPL)}`}>
              mkt value {money(winner.marketValue)} · weight{" "}
              {pct(winner.weightPct)}
            </div>
          </>
        ) : (
          <div className="mt-2 text-2xl font-bold text-zinc-500">
            🪦 no gains
          </div>
        )}
        <div className="mt-2 text-xs text-zinc-600">
          {hasGains ? "post it on wsb, king" : "nobody made tendies today"}
        </div>
      </div>

      <div className={`${card} border-rose-800/60`}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-rose-500">
          💀 Loss porn
        </h2>
        <div className="mt-2 text-3xl font-extrabold tabular-nums text-rose-400">
          {num(loser.totalPL)}
        </div>
        <div className="mt-1 text-lg font-bold text-zinc-100">
          {loser.symbol}
          <span className="ml-2 text-sm font-normal text-zinc-500">
            {pct(loser.totalPLPct, { sign: true })}
          </span>
        </div>
        {loser.name && (
          <div className="truncate text-xs text-zinc-500">{loser.name}</div>
        )}
        <div className={`mt-1 text-xs ${tone(loser.totalPL)}`}>
          mkt value {money(loser.marketValue)} · weight {pct(loser.weightPct)}
        </div>
        <div className="mt-2 text-xs text-zinc-600">
          press F to pay respects
        </div>
      </div>
    </div>
  );
}

/** Total profit, denominated in chicken tenders. */
const TENDER_PRICE_USD = 1.99;

export function TendiesCounter({ totalPL }: { totalPL: number | null }) {
  const tendies =
    totalPL == null || !Number.isFinite(totalPL)
      ? null
      : Math.round(totalPL / TENDER_PRICE_USD);

  return (
    <div className={card}>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        🍗 Tendies counter
      </h2>
      {tendies == null ? (
        <>
          <div className="mt-2 text-3xl font-extrabold text-zinc-500">—</div>
          <div className="mt-1 text-sm text-zinc-500">
            log cost basis to count your tendies
          </div>
        </>
      ) : tendies > 0 ? (
        <>
          <div className="mt-2 text-4xl font-extrabold tabular-nums text-amber-300">
            🍗 {tendies.toLocaleString("en-US")} tendies
          </div>
          <div className="mt-1 text-sm text-zinc-500">
            your gains buy ~{tendies.toLocaleString("en-US")} chicken tenders
            at ${TENDER_PRICE_USD.toFixed(2)} a pop
          </div>
        </>
      ) : tendies < 0 ? (
        <>
          <div className="mt-2 text-4xl font-extrabold tabular-nums text-zinc-400">
            🧾 {tendies.toLocaleString("en-US")} tendies
          </div>
          <div className="mt-1 text-sm text-zinc-500">
            you OWE the tendies man {Math.abs(tendies).toLocaleString("en-US")}{" "}
            tenders
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 text-3xl font-extrabold text-zinc-400">
            🍗 0 tendies
          </div>
          <div className="mt-1 text-sm text-zinc-500">
            flat — no tendies won, none owed
          </div>
        </>
      )}
    </div>
  );
}
