"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

import { api } from "~/trpc/react";

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

/**
 * Magic-link sign-in. Optional: the whole app works without logging in.
 * Logging in lets you save your IBKR credentials to your account
 * (encrypted) instead of re-pasting them in every browser.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState("");
  const emailQ = api.auth.emailConfigured.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const configured = emailQ.data?.configured;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) {
      setErrorMsg("Enter a valid email address.");
      setState("error");
      return;
    }
    setState("sending");
    setErrorMsg("");
    try {
      const res = await signIn("email", {
        email: addr,
        callbackUrl: "/",
        redirect: false,
      });
      if (!res || res.error || res.url?.includes("/error")) {
        setState("error");
        setErrorMsg(
          "Couldn't send the sign-in email. The server may not have email configured yet.",
        );
      } else {
        setState("sent");
      }
    } catch {
      setState("error");
      setErrorMsg("Couldn't send the sign-in email. Please try again.");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100 antialiased">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center gap-3">
          <img
            src="/logo.webp"
            alt="Holdr logo"
            width={36}
            height={36}
            className="h-9 w-9 rounded-xl"
          />
          <h1 className="text-xl font-extrabold tracking-tight">Sign in</h1>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          We&apos;ll email you a magic link — no password needed. Signing in is
          optional; it just lets you save your IBKR connection to your account.
        </p>

        {emailQ.isSuccess && !configured && (
          <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-300">
            Email sign-in isn&apos;t set up on this server yet
            (RESEND_API_KEY missing).
          </p>
        )}

        {state === "sent" ? (
          <p className="mt-4 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
            Check your inbox — we sent a sign-in link to{" "}
            <b>{email.trim()}</b>. It expires in 24 hours.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className={`${inputCls} mt-1`}
              />
            </label>
            <button
              type="submit"
              disabled={state === "sending" || configured === false}
              className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {state === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
            {state === "error" && errorMsg && (
              <p className="text-sm text-rose-400">{errorMsg}</p>
            )}
          </form>
        )}

        <p className="mt-4 text-center text-sm">
          <a href="/" className="text-zinc-500 hover:text-zinc-300">
            ← Back to the portfolio
          </a>
        </p>
      </div>
    </main>
  );
}
