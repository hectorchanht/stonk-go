"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { api } from "~/trpc/react";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function PushToggle() {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  const vapidQuery = api.push.vapidKey.useQuery(undefined, { retry: false });
  const subscribeMut = api.push.subscribe.useMutation();
  const unsubscribeMut = api.push.unsubscribe.useMutation();

  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      setSupported(true);
      setPermission(Notification.permission);
      navigator.serviceWorker.ready.then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub);
      }).catch(() => {
        /* push unavailable — toggle stays off */
      });
    }
  }, []);

  if (!supported) return null;

  const enable = async () => {
    if (!vapidQuery.data?.publicKey) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidQuery.data.publicKey),
      });
      const keys = sub.toJSON().keys!;
      await subscribeMut.mutateAsync({
        endpoint: sub.endpoint,
        p256dh: keys.p256dh!,
        auth: keys.auth!,
      });
      setSubscribed(true);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribeMut.mutateAsync({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={subscribed ? disable : enable}
      disabled={busy || !vapidQuery.data}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
      title={subscribed ? "Disable push notifications" : "Enable push notifications"}
    >
      {subscribed ? <BellOff size={15} /> : <Bell size={15} />}
      {busy ? "Working…" : subscribed ? "Push: On" : "Push: Off"}
    </button>
  );
}
