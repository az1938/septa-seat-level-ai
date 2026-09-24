import { useEffect, useRef } from "react";
import type { LedEvent, LedState } from "../state/ledMachine";

// ─────────────────────────────────────────────────────────────────────────────
// useLedEtaRefresh — keeps the seat-level LED's ETA live, independently of the
// AI panel (which may already be back in IDLE serving someone else).
//
// • Runs only while the LED is ASSIGNED with a refreshable `tracking`
//   (real recommendations; DEV mock recommendations have none).
// • Every POLL_MS it calls GET /api/eta for the SAME route/stop/destination
//   (and the same bus trip when known). No AI, matching or route selection.
// • A failed poll never blanks the LED: the last ETA stays, the error is
//   recorded for the DEV panel, and the next poll simply tries again.
// • Once the tracked bus has reached the stop (ETA ≤ 1 min and then it drops
//   out of the live feed), the tile holds ARRIVING and polling stops. The tile
//   is NOT auto-cleared (that's still the DEV "Clear LED" button for now).
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;

export function useLedEtaRefresh(led: LedState, ledDispatch: (e: LedEvent) => void) {
  const ledRef = useRef(led);
  ledRef.current = led;

  const assignedAt = led.status === "ASSIGNED" ? led.assignedAt : null;
  const refreshable = led.status === "ASSIGNED" && led.tracking !== null;

  useEffect(() => {
    if (!refreshable || assignedAt === null) return;

    let stopped = false;
    let inFlight: AbortController | null = null;

    const poll = async () => {
      const cur = ledRef.current;
      if (stopped || cur.status !== "ASSIGNED" || cur.assignedAt !== assignedAt || !cur.tracking) return;
      const { route, etaMinutes: lastEta } = cur.recommendation;
      const { stop, dest, tripId } = cur.tracking;

      const q = new URLSearchParams({ route, stop });
      if (dest) q.set("dest", dest);
      if (tripId) q.set("trip_id", tripId);

      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timeout = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(`/api/eta?${q}`, { signal: ctrl.signal, cache: "no-store" });
        let body: any = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON (e.g. backend down behind the Vite proxy) */
        }
        if (stopped) return;
        if (!res.ok || !body || body.status === "error") {
          throw new Error(body?.error ?? `HTTP ${res.status} (backend down?)`);
        }
        if (body.status !== "ok") throw new Error(body.live_error ?? "no live or scheduled ETA right now");

        if (body.tracked_trip_missing && lastEta <= 1) {
          // Our bus was ~1 min out and is no longer predicted → it's at / past the stop.
          ledDispatch({ type: "LED_UPDATE_ETA", etaMinutes: 0 });
          stopped = true; // hold ARRIVING; don't jump to the next bus
          window.clearInterval(timer);
          return;
        }
        ledDispatch({
          type: "LED_UPDATE_ETA",
          etaMinutes: body.eta_minutes,
          tripId: body.trip_id ?? null,
          source: body.eta_source,
        });
      } catch (e) {
        if (stopped) return;
        const msg =
          (e as Error).name === "AbortError" ? "ETA refresh timed out" : (e as Error).message || String(e);
        ledDispatch({ type: "LED_REFRESH_FAILED", message: msg });
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      inFlight?.abort();
    };
  }, [assignedAt, refreshable, ledDispatch]);
}
