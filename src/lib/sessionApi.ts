import { apiUrl } from "./apiBase";
import type { DestinationResult, RouteResult } from "../state/interactionMachine";

// ─────────────────────────────────────────────────────────────────────────────
// Client for the ONE shared prototype session on the backend (server/session_store.py).
// Three devices, kept in sync by simple polling (no WebSockets):
//   /input   (iPhone)  POST /api/session/update with its client state; the backend's
//                      AI + routing endpoints write their results automatically.
//                      Polls ?view=input every 1 s only to notice "Reset Input".
//   /output  (iPad)    polls ?view=output every 1 s → LED (route + ETA)
//   /monitor (laptop)  polls the full session every 1 s
// ─────────────────────────────────────────────────────────────────────────────

export const POLL_MS = 1000;

export type RiderStatus =
  | "idle"
  | "person_detected"
  | "listening"
  | "processing"
  | "needs_clarification"
  | "recommendation"
  | "walk_recommended"
  | "opposite_direction"
  | "no_direct_route"
  | "error";

/** What /input reports about itself (client-only facts the backend can't see). */
export interface InputReport {
  state?: string;
  prompt?: string;
  retry_count?: number;
  retry_reason?: string | null;
  transcript?: string | null;
  normalized_transcript?: string | null;
  speech_status?: string;
  voice?: string;
  speech_supported?: boolean;
  mic_status?: string;
  listening?: boolean;
  interim?: string;
  speech_error?: string | null;
  camera_status?: string;
  model_status?: string;
  person_present?: boolean;
  raw_detected?: boolean;
  score?: number | null;
  camera_error?: string | null;
  interpretation_phase?: string | null;
  interpretation_error?: string | null;
  routing_phase?: string | null;
  routing_error?: string | null;
  speech_unlocked?: boolean;
  user_agent?: string;
  viewport?: string;
  // which rider input page drives the session + /input-mobile recorder diagnostics
  input_mode?: "desktop-speech" | "mobile-recorder";
  recorder_status?: string;
  audio_mime?: string;
  upload_status?: string;
  transcription?: string;
  transcription_model?: string;
  transcription_ms?: number;
  transcription_error?: string | null;
}

/** LED part — all /output needs. */
export interface OutputView {
  session_id: string;
  version: number;
  route: string | null;
  eta_minutes: number | null;
  eta_source: "LIVE" | "SCHEDULED" | "MOCK" | null;
  led_active: boolean;
  led_arrived: boolean;
  led_mock: boolean;
  updated_at: string;
  server: { pid: number; started_at: string };
}

export interface InputView {
  session_id: string;
  version: number;
  status: RiderStatus;
  input_reset_seq: number;
  server: { pid: number; started_at: string };
}

export interface SharedSession extends OutputView {
  status: RiderStatus;
  raw_transcript: string | null;
  local_hint: string | null;
  interpreted_destination: string | null;
  resolved_place: string | null;
  resolved_address: string | null;
  walking_minutes: number | null;
  message: string | null;
  interpretation: DestinationResult | null;
  interpretation_phase: "pending" | "done" | "error" | null;
  interpretation_error: string | null;
  routing: RouteResult | null;
  routing_phase: "pending" | "done" | "error" | null;
  routing_error: string | null;
  ride_started_at: string | null;
  trip_id: string | null;
  destination_stop: string | null;
  destination_name: string | null;
  origin_stop: string | null;
  led_assigned_at: number | null;
  led_refreshed_at: number | null;
  led_refresh_error: string | null;
  mock_seconds_per_min: number | null;
  input: InputReport;
  input_last_update: number | null;
  input_last_poll: number | null;
  output_last_poll: number | null;
  input_reset_seq: number;
  errors: { at: string; source: string; message: string }[];
  now: number; // server clock (s), for "last seen" ages
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: "no-store", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export const fetchFullSession = (signal?: AbortSignal) => getJson<SharedSession>("/api/session", signal);
export const fetchOutputView = (signal?: AbortSignal) => getJson<OutputView>("/api/session?view=output", signal);
export const fetchInputView = (signal?: AbortSignal) => getJson<InputView>("/api/session?view=input", signal);

export const postInputUpdate = (body: { input?: InputReport; status?: RiderStatus; message?: string | null }) =>
  postJson("/api/session/update", body);

/** "input" = RESET INPUT (LED kept) · "led" = CLEAR SESSION / LED (output goes blank) */
export const resetSession = (scope: "input" | "led") => postJson("/api/session/reset", { scope });

/** TEST MODE: Route 21 with a mock ETA; optional countdown (seconds per minute). */
export const mockLed = (etaMinutes: number, secondsPerMin: number | null) =>
  postJson("/api/session/mock", { eta_minutes: etaMinutes, seconds_per_min: secondsPerMin });
