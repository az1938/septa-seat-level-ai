// ─────────────────────────────────────────────────────────────────────────────
// Interaction state machine — Week 3 refined Seat-Level ETA
//
//   IDLE ──PERSON_DETECTED──▶ PERSON_DETECTED ──PROMPT_FINISHED──▶ LISTENING
//     ▲                                                              │
//     │                                                      SPEECH_CAPTURED
//     │                                                              ▼
//   RECOMMENDATION ◀──RECOMMENDATION_READY── PROCESSING ◀────────────┘
//     │
//     └──SESSION_END──▶ IDLE
//
//   RETRY_NEEDED (LISTENING / PROCESSING: silence, needs_clarification,
//     not_a_destination) ──▶ PERSON_DETECTED(prompt "retry") ──PROMPT_FINISHED──▶ LISTENING
//     …after MAX_RETRIES (2): PERSON_DETECTED(prompt "giveup") ──PROMPT_FINISHED──▶ IDLE
//   RESET (from any state) ──▶ IDLE
//   PERSON_LEFT (from PERSON_DETECTED / LISTENING / PROCESSING) ──▶ IDLE
//
// Who will send each event later (none are wired yet — this step is manual):
//   PERSON_DETECTED       ← camera / person detection
//   PROMPT_FINISHED       ← spoken "Where are you going?" finished playing
//   SPEECH_CAPTURED       ← microphone + speech recognition (carries transcript)
//   RECOMMENDATION_READY  ← AI destination interpretation + SEPTA route/ETA
//   SESSION_END           ← spoken recommendation finished / timeout
//   PERSON_LEFT           ← camera no longer sees the rider mid-conversation
//
// The reducer is pure: no timers, audio, or network here. Side effects will
// be attached later by watching `ctx.state` in App (one effect per state).
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeTranscript } from "../lib/normalizeTranscript";

export type InteractionState =
  | "IDLE"
  | "PERSON_DETECTED"
  | "LISTENING"
  | "PROCESSING"
  | "RECOMMENDATION";

export const STATE_ORDER: InteractionState[] = [
  "IDLE",
  "PERSON_DETECTED",
  "LISTENING",
  "PROCESSING",
  "RECOMMENDATION",
];

export interface Recommendation {
  route: string; // e.g. "21"
  etaMinutes: number; // whole minutes; < 1 means "arriving"
}

// AI destination interpretation (see src/lib/interpretApi.ts). Filled while
// PROCESSING; it does not change the state by itself.
export type Interpretation =
  | { phase: "pending" }
  | { phase: "done"; result: DestinationResult }
  | { phase: "error"; code: string; message: string };

export interface DestinationResult {
  status: "ok" | "needs_clarification" | "not_a_destination";
  raw_transcript: string;
  destination_type: "address" | "intersection" | "landmark" | "area" | "unknown";
  destination_text: string | null;
  intersection_or_address: string | null;
  place_name: string | null;
  confidence: number;
  clarification_question: string | null;
  model?: string;
}

// Transit routing result from the backend (static GTFS + live SEPTA).
// Filled while PROCESSING; carried into RECOMMENDATION for the DEV panel.
export interface RouteEta {
  route: string;
  eta_minutes: number;
  eta_source: "LIVE" | "SCHEDULED";
  arrival_time: string;
  trip_id: string | null;
}

export interface RouteResult {
  status: "ok" | "opposite_direction" | "no_direct_route" | "destination_not_found" | "no_eta_available";
  origin_stop: string;
  origin_name?: string;
  match_method: "place_alias" | "place_alias+geocoder" | "intersection_name" | "address_grid" | "geocode" | null;
  destination_input?: {
    destination_text?: string;
    intersection_or_address?: string;
    place_name?: string;
    destination_type?: string;
  };
  resolved_place?: string | null;
  resolved_address?: string | null;
  matched_alias?: string;
  match_query?: string | null;
  candidate_stops?: { stop_id: string; name: string; distance_m: number }[];
  destination_stop?: string;
  destination_name?: string;
  destination_distance_m?: number;
  // opposite_direction only
  current_stop_id?: string;
  current_stop_name?: string;
  recommended_stop_id?: string;
  recommended_stop_name?: string;
  valid_routes?: string[];
  route_etas?: RouteEta[];
  selected_route?: string;
  eta_minutes?: number;
  eta_source?: "LIVE" | "SCHEDULED";
  predicted_arrival?: string;
  selected_trip_id?: string | null;
  live_error?: string;
  match_errors?: string[];
}

export type Routing =
  | { phase: "pending" }
  | { phase: "done"; result: RouteResult }
  | { phase: "error"; code: string; message: string };

/**
 * Guidance instead of a route (never goes to the LED):
 *   opposite_direction — "use the other stop" (stopId/stopName = that stop)
 *   no_direct_route    — no route 9/21/42 from either stop (stop fields empty)
 */
export interface Redirect {
  kind: "opposite_direction" | "no_direct_route";
  stopId: string;
  stopName: string;
  validRoutes: string[];
}

/** What PERSON_DETECTED is asking: the first question, a retry, or a final give-up. */
export type PromptKind = "ask" | "retry" | "giveup";
export type RetryReason = "no_speech" | "needs_clarification" | "not_a_destination";

/** Clarification retries allowed per session (after that: "Please try again." → IDLE). */
export const MAX_RETRIES = 2;

export interface InteractionContext {
  state: InteractionState;
  transcript: string | null; // RAW SpeechRecognition transcript (kept for debugging)
  normalizedTranscript: string | null; // after local place-name cleanup — what is sent to OpenAI
  recommendation: Recommendation | null; // what Frame 1 shows; handed to the LED on RECOMMENDATION
  redirect: Redirect | null; // RECOMMENDATION variant: guidance instead of a route (never goes to the LED)
  interpretation: Interpretation | null; // AI-normalized destination for this session
  routing: Routing | null; // GTFS + SEPTA routing for this session
  prompt: PromptKind; // which prompt PERSON_DETECTED shows/speaks
  retryCount: number; // clarification retries used in this session (0…MAX_RETRIES)
  retryReason: RetryReason | null; // why the last retry happened (DEV)
  enteredAt: number; // ms timestamp the current state was entered
}

export type InteractionEvent =
  | { type: "PERSON_DETECTED" }
  | { type: "PROMPT_FINISHED" }
  | { type: "SPEECH_CAPTURED"; transcript?: string }
  | { type: "INTERPRETATION_STARTED" }
  | { type: "INTERPRETATION_READY"; result: DestinationResult }
  | { type: "INTERPRETATION_FAILED"; code: string; message: string }
  | { type: "ROUTING_STARTED" }
  | { type: "ROUTING_RESULT"; result: RouteResult }
  | { type: "ROUTING_FAILED"; code: string; message: string }
  | { type: "RECOMMENDATION_READY"; recommendation: Recommendation }
  | { type: "REDIRECT_READY"; redirect: Redirect }
  | { type: "RETRY_NEEDED"; reason: RetryReason }
  | { type: "SESSION_END" }
  | { type: "PERSON_LEFT" }
  | { type: "RESET" }
  // Developer-only: jump straight to any state (bypasses the transition table).
  | { type: "DEV_JUMP"; to: InteractionState; recommendation?: Recommendation };

export const initialContext: InteractionContext = {
  state: "IDLE",
  transcript: null,
  normalizedTranscript: null,
  recommendation: null,
  redirect: null,
  interpretation: null,
  routing: null,
  prompt: "ask",
  retryCount: 0,
  retryReason: null,
  enteredAt: Date.now(),
};

function enter(
  prev: InteractionContext,
  state: InteractionState,
  patch: Partial<InteractionContext> = {}
): InteractionContext {
  const next: InteractionContext = { ...prev, ...patch, state, enteredAt: Date.now() };
  // Returning to IDLE clears the AI interaction session (transcript + the
  // recommendation shown in Frame 1). The LED tile has its own persistent
  // state (ledMachine.ts) and is NOT cleared here.
  if (state === "IDLE") {
    next.transcript = null;
    next.normalizedTranscript = null;
    next.recommendation = null;
    next.redirect = null;
    next.interpretation = null;
    next.routing = null;
    next.prompt = "ask";
    next.retryCount = 0;
    next.retryReason = null;
  }
  return next;
}

// Legal transitions. Anything not listed is ignored (state stays the same).
export function interactionReducer(
  ctx: InteractionContext,
  event: InteractionEvent
): InteractionContext {
  if (event.type === "RESET") return enter(ctx, "IDLE");

  if (event.type === "DEV_JUMP") {
    const idx = STATE_ORDER.indexOf(event.to);
    return enter(ctx, event.to, {
      // Only keep a recommendation when jumping to RECOMMENDATION.
      recommendation:
        event.to === "RECOMMENDATION" ? event.recommendation ?? ctx.recommendation : null,
      redirect: null,
      transcript: idx >= STATE_ORDER.indexOf("PROCESSING") ? ctx.transcript : null,
      normalizedTranscript: idx >= STATE_ORDER.indexOf("PROCESSING") ? ctx.normalizedTranscript : null,
      interpretation: idx >= STATE_ORDER.indexOf("PROCESSING") ? ctx.interpretation : null,
      routing: idx >= STATE_ORDER.indexOf("PROCESSING") ? ctx.routing : null,
      prompt: "ask",
    });
  }

  // Retry: silence, "needs clarification" or "not a destination" → ask again
  // (back through PERSON_DETECTED with the retry prompt, which then re-enters
  // LISTENING). After MAX_RETRIES, say "Please try again." and end the session.
  if (event.type === "RETRY_NEEDED" && (ctx.state === "LISTENING" || ctx.state === "PROCESSING")) {
    const exhausted = ctx.retryCount >= MAX_RETRIES;
    return enter(ctx, "PERSON_DETECTED", {
      prompt: exhausted ? "giveup" : "retry",
      retryCount: exhausted ? ctx.retryCount : ctx.retryCount + 1,
      retryReason: event.reason,
      // keep the last transcript / AI result visible in DEV until the next capture
      routing: null,
    });
  }

  switch (ctx.state) {
    case "IDLE":
      if (event.type === "PERSON_DETECTED") return enter(ctx, "PERSON_DETECTED", { prompt: "ask" });
      break;

    case "PERSON_DETECTED":
      // After "Where are you going?" or the retry prompt → listen (again).
      // After the final "Please try again." → back to IDLE.
      if (event.type === "PROMPT_FINISHED")
        return ctx.prompt === "giveup" ? enter(ctx, "IDLE") : enter(ctx, "LISTENING");
      if (event.type === "PERSON_LEFT") return enter(ctx, "IDLE");
      break;

    case "LISTENING":
      if (event.type === "SPEECH_CAPTURED")
        return enter(ctx, "PROCESSING", {
          transcript: event.transcript ?? null,
          normalizedTranscript: event.transcript ? normalizeTranscript(event.transcript).text : null,
          interpretation: null,
          routing: null,
        });
      if (event.type === "PERSON_LEFT") return enter(ctx, "IDLE");
      break;

    case "PROCESSING":
      // Interpretation results update data only; the state stays PROCESSING.
      if (event.type === "INTERPRETATION_STARTED") return { ...ctx, interpretation: { phase: "pending" } };
      if (event.type === "INTERPRETATION_READY")
        return { ...ctx, interpretation: { phase: "done", result: event.result } };
      if (event.type === "INTERPRETATION_FAILED")
        return { ...ctx, interpretation: { phase: "error", code: event.code, message: event.message } };
      if (event.type === "ROUTING_STARTED") return { ...ctx, routing: { phase: "pending" } };
      if (event.type === "ROUTING_RESULT") return { ...ctx, routing: { phase: "done", result: event.result } };
      if (event.type === "ROUTING_FAILED")
        return { ...ctx, routing: { phase: "error", code: event.code, message: event.message } };
      if (event.type === "RECOMMENDATION_READY")
        return enter(ctx, "RECOMMENDATION", { recommendation: event.recommendation, redirect: null });
      // Opposite direction: same RECOMMENDATION state, but guidance instead of a route.
      if (event.type === "REDIRECT_READY")
        return enter(ctx, "RECOMMENDATION", { recommendation: null, redirect: event.redirect });
      if (event.type === "PERSON_LEFT") return enter(ctx, "IDLE");
      break;

    case "RECOMMENDATION":
      if (event.type === "SESSION_END") return enter(ctx, "IDLE");
      break;
  }

  if (import.meta.env.DEV) {
    console.warn(`[interaction] ignored ${event.type} while in ${ctx.state}`);
  }
  return ctx;
}

// The single "happy path" event that advances each state — used by the
// developer controller's "Next" button.
export function nextEventFor(
  state: InteractionState,
  mock: Recommendation
): InteractionEvent {
  switch (state) {
    case "IDLE":
      return { type: "PERSON_DETECTED" };
    case "PERSON_DETECTED":
      return { type: "PROMPT_FINISHED" };
    case "LISTENING":
      return { type: "SPEECH_CAPTURED" };
    case "PROCESSING":
      return { type: "RECOMMENDATION_READY", recommendation: mock };
    case "RECOMMENDATION":
      return { type: "SESSION_END" };
  }
}
