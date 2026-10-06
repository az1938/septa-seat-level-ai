import { useMemo } from "react";
import { LedScreen } from "../components/LedScreen";
import { POLL_MS, fetchOutputView } from "../lib/sessionApi";
import { usePoll } from "../hooks/usePoll";
import { useWakeLock } from "../hooks/useWakeLock";
import type { Recommendation } from "../state/interactionMachine";

// ─────────────────────────────────────────────────────────────────────────────
// /output — the seat-level LED only (iPad near the seat). The whole viewport is
// the LED panel (LedScreen): no card, frame or margin; idle = dark, blank panel.
//
// Polls GET /api/session?view=output every 1 s and shows the LED part of the
// shared session: route + ETA while led_active, otherwise the dark, blank tile.
// The backend refreshes the ETA (live SEPTA every 10 s) and decides ARRIVING;
// this page only displays. It does NOT follow the rider status, so /input going
// back to IDLE leaves the tile lit — only "Clear Session / LED" (or a new
// recommendation) changes it. Walking / opposite-direction / clarification never
// light it. If the backend can't be reached, the last ETA stays on screen.
// ─────────────────────────────────────────────────────────────────────────────

export function OutputPage() {
  useWakeLock();
  const { data } = usePoll(fetchOutputView, POLL_MS);

  const route = data?.route ?? null;
  const eta = data?.eta_minutes ?? null;
  const active = !!data?.led_active && route !== null && eta !== null;
  // stable object identity per (route, eta) so the tile only re-renders on real changes
  const recommendation = useMemo<Recommendation | null>(
    () => (active ? { route: route!, etaMinutes: eta! } : null),
    [active, route, eta]
  );

  return (
    <main className="page-output">
      <LedScreen recommendation={recommendation} />
    </main>
  );
}
