import { useEffect } from "react";

// Keeps the screen on (iPhone /input, iPad /output) where the Screen Wake Lock
// API exists (iOS Safari 16.4+, Chrome). The lock is released whenever the page
// is hidden, so it is re-requested when the page becomes visible again.
// Silently does nothing where unsupported — then turn off Auto-Lock in iOS Settings.
export function useWakeLock() {
  useEffect(() => {
    const wl = (navigator as any).wakeLock;
    if (!wl?.request) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        sentinel = await wl.request("screen");
        if (cancelled) sentinel?.release().catch(() => {});
      } catch {
        /* not allowed right now (e.g. before a user gesture) — retried on next visibility/tap */
      }
    };
    acquire();
    const onVisible = () => acquire();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pointerdown", onVisible, { once: true });
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, []);
}
