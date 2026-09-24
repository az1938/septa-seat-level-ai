// ─────────────────────────────────────────────────────────────────────────────
// LED waiting session — persistent state for the seat-level LED tile (Frame 2)
//
//   EMPTY ──LED_ASSIGN(route, eta)──▶ ASSIGNED ──LED_UPDATE_ETA──▶ ASSIGNED
//     ▲                                  │
//     └──────────── LED_CLEAR ───────────┘
//
// This is deliberately SEPARATE from the AI interaction session
// (interactionMachine.ts). The AI panel returning to IDLE to serve the next
// person does NOT clear the LED — the rider who got the recommendation is
// now seated and still waiting. Only LED_CLEAR empties it (later: when the
// bus arrives, or an explicit reset).
//
// Who sends each event:
//   LED_ASSIGN          ← App, when the AI interaction produces a recommendation
//   LED_UPDATE_ETA      ← useLedEtaRefresh: live SEPTA poll for the assigned route
//   LED_REFRESH_FAILED  ← useLedEtaRefresh: a poll failed (last ETA is kept)
//   LED_CLEAR           ← developer "Clear LED" button (later: bus arrived)
// ─────────────────────────────────────────────────────────────────────────────

import type { Recommendation } from "./interactionMachine";

/** What the refresh poll needs to ask for the same route (and the same bus). */
export interface LedTracking {
  stop: string; // origin stop, e.g. "14079"
  dest: string | null; // destination stop — only trips reaching it count
  tripId: string | null; // the specific bus being tracked, if known
}

export type EtaSource = "LIVE" | "SCHEDULED";

export type LedState =
  | { status: "EMPTY" }
  | {
      status: "ASSIGNED";
      recommendation: Recommendation;
      assignedAt: number;
      /** null = not refreshable (e.g. a DEV mock recommendation) */
      tracking: LedTracking | null;
      source: EtaSource | null;
      lastRefreshAt: number | null;
      refreshError: string | null;
    };

export type LedEvent =
  | { type: "LED_ASSIGN"; recommendation: Recommendation; tracking?: LedTracking | null; source?: EtaSource | null }
  | { type: "LED_UPDATE_ETA"; etaMinutes: number; tripId?: string | null; source?: EtaSource }
  | { type: "LED_REFRESH_FAILED"; message: string }
  | { type: "LED_CLEAR" };

export const initialLedState: LedState = { status: "EMPTY" };

export function ledReducer(led: LedState, event: LedEvent): LedState {
  switch (event.type) {
    case "LED_ASSIGN":
      return {
        status: "ASSIGNED",
        recommendation: event.recommendation,
        assignedAt: Date.now(),
        tracking: event.tracking ?? null,
        source: event.source ?? null,
        lastRefreshAt: null,
        refreshError: null,
      };

    case "LED_UPDATE_ETA": {
      if (led.status !== "ASSIGNED") return led; // nothing to update
      const same = led.recommendation.etaMinutes === event.etaMinutes;
      return {
        ...led,
        recommendation: same ? led.recommendation : { ...led.recommendation, etaMinutes: event.etaMinutes },
        tracking:
          led.tracking && event.tripId !== undefined ? { ...led.tracking, tripId: event.tripId } : led.tracking,
        source: event.source ?? led.source,
        lastRefreshAt: Date.now(),
        refreshError: null,
      };
    }

    case "LED_REFRESH_FAILED":
      // Keep showing the last known ETA; the error is DEV-only.
      if (led.status !== "ASSIGNED") return led;
      return { ...led, refreshError: event.message };

    case "LED_CLEAR":
      return initialLedState;
  }
}

/** What the LED tile should display (null = dark). */
export function ledRecommendation(led: LedState): Recommendation | null {
  return led.status === "ASSIGNED" ? led.recommendation : null;
}
