import { useEffect, useReducer, useRef, useState } from "react";
import {
  initialContext,
  interactionReducer,
  type InteractionContext,
  type PromptKind,
  type Redirect,
} from "../state/interactionMachine";
import { AiPanel } from "../components/AiPanel";
import { usePersonDetection, type PersonDetection } from "../hooks/usePersonDetection";
import { cancelSpeech, currentVoiceLabel, installSpeechUnlock, speak } from "../lib/speech";
import { useSpeechCapture, type SpeechCapture } from "../hooks/useSpeechCapture";
import { InterpretError, interpretDestination } from "../lib/interpretApi";
import { RouteError, recommendRoute } from "../lib/routeApi";
import { POLL_MS, fetchInputView, postInputUpdate, type InputReport, type RiderStatus } from "../lib/sessionApi";
import { usePoll } from "../hooks/usePoll";
import { useWakeLock } from "../hooks/useWakeLock";

const PROMPT_TEXT: Record<PromptKind, string> = {
  ask: "Where are you going?",
  retry: "Sorry, I didn't catch that. Please say your destination again.",
  giveup: "Please try again.",
};
const GIVEUP_RETURN_TO_IDLE_MS = 1500; // after "Please try again."
const RETURN_TO_IDLE_MS = 2000; // after the spoken recommendation finishes
const SILENT_DISPLAY_MS = 6000; // if speech could not play, keep the text up longer
const REDIRECT_RETURN_TO_IDLE_MS: Record<Redirect["kind"], number> = {
  walk_recommended: 3000, // after "…Walking may be faster than waiting for the bus."
  opposite_direction: 3000, // after "…please use the … stop."
  no_direct_route: 2000, // after "…please try another destination."
};

/** "Walnut St & 37th St" → "Walnut Street and 37th Street" for the voice only. */
function spokenStopName(name: string): string {
  return name
    .replace(/\s+-\s+\w+$/, "")
    .replace(/&/g, "and")
    .replace(/\bSt\b\.?/g, "Street")
    .replace(/\bAve?\b\.?/g, "Avenue")
    .replace(/\bBlvd\b\.?/g, "Boulevard");
}

function redirectSentence(r: Redirect): string {
  // Walking is only a suggestion (some riders can't or don't want to walk): never "you should walk".
  if (r.kind === "walk_recommended") {
    const m = Math.max(1, Math.round(r.walkingMinutes ?? 0));
    return m <= 3
      ? "This destination is only a few minutes away on foot. Walking may be faster than waiting for the bus."
      : `This destination is about ${/^(8|11|18)/.test(String(m)) ? "an" : "a"} ${m} minute walk from here. Walking may be faster than waiting for the bus.`;
  }
  if (r.kind === "no_direct_route")
    return "There isn't a direct route from this stop. Please try another destination.";
  return `That destination is in the opposite direction. Please use the ${spokenStopName(r.stopName)} stop.`;
}

/** Natural spoken recommendation (never says "0 minutes"; never "have a seat" when arriving). */
function recommendationSentence(route: string, eta: number): string {
  const m = Math.max(0, Math.round(eta));
  if (m < 1) return `Route ${route} is arriving now. Please proceed to the boarding area.`;
  return `Take Route ${route}. It arrives in ${m} ${m === 1 ? "minute" : "minutes"}. Please have a seat and follow the display in front of you.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /input — the rider-facing conversational interface (iPhone on the bus-stop wall).
//
// Same interaction logic as before (camera → "Where are you going?" → speech →
// AI destination recovery → Route 21 / walking / opposite-stop decision → spoken
// result → IDLE), but ONLY the AI panel is shown. The LED lives on /output (iPad).
//
//   IDLE → PERSON_DETECTED → LISTENING → PROCESSING → RECOMMENDATION → IDLE
//
// Sync with the other devices (shared backend session, server/session_store.py):
//   • the backend's own endpoints record the transcript, AI result and routing
//     result; a Route 21 recommendation assigns the LED there (→ /output);
//   • this page reports its client-only state (state machine, camera, microphone,
//     speech) via POST /api/session/update, so /monitor can show it;
//   • it polls GET /api/session?view=input every 1 s only to notice the
//     researcher's "Reset Input" (input_reset_seq changes → RESET here).
// Returning to IDLE never clears the LED.
// ─────────────────────────────────────────────────────────────────────────────

/** Session status for /monitor, derived from the interaction state. */
function riderStatus(ctx: InteractionContext): RiderStatus {
  switch (ctx.state) {
    case "IDLE":
      return "idle";
    case "PERSON_DETECTED":
      return ctx.prompt === "ask" ? "person_detected" : "needs_clarification";
    case "LISTENING":
      return "listening";
    case "PROCESSING": {
      // errors keep the panel on PROCESSING (as before) but must show as "error" on /monitor
      const it = ctx.interpretation;
      const rt = ctx.routing;
      if (it?.phase === "error" || rt?.phase === "error") return "error";
      if (rt?.phase === "done" && (rt.result.status === "destination_not_found" || rt.result.status === "no_eta_available"))
        return "error";
      return "processing";
    }
    case "RECOMMENDATION":
      if (ctx.recommendation) return "recommendation";
      return ctx.redirect?.kind ?? "recommendation";
  }
}

/** The rider-facing words for the current state (what is shown / spoken). */
function riderMessage(ctx: InteractionContext): string | null {
  switch (ctx.state) {
    case "PERSON_DETECTED":
      return PROMPT_TEXT[ctx.prompt];
    case "LISTENING":
      return "Listening…";
    case "PROCESSING":
      return "Finding your route…";
    case "RECOMMENDATION":
      if (ctx.recommendation) return recommendationSentence(ctx.recommendation.route, ctx.recommendation.etaMinutes);
      return ctx.redirect ? redirectSentence(ctx.redirect) : null;
    default:
      return null;
  }
}

function inputReport(
  ctx: InteractionContext,
  detection: PersonDetection,
  speech: SpeechCapture,
  speechStatus: string,
  unlocked: boolean
): InputReport {
  const it = ctx.interpretation;
  const rt = ctx.routing;
  return {
    state: ctx.state,
    prompt: ctx.prompt,
    retry_count: ctx.retryCount,
    retry_reason: ctx.retryReason,
    transcript: ctx.transcript,
    normalized_transcript: ctx.normalizedTranscript,
    speech_status: speechStatus,
    voice: currentVoiceLabel(),
    speech_supported: speech.supported,
    mic_status: speech.micStatus,
    listening: speech.listening,
    interim: speech.interim,
    speech_error: speech.error,
    camera_status: detection.cameraStatus,
    model_status: detection.modelStatus,
    person_present: detection.personPresent,
    raw_detected: detection.rawDetected,
    score: detection.score,
    camera_error: detection.error,
    interpretation_phase: it?.phase ?? null,
    interpretation_error: it?.phase === "error" ? `${it.code}: ${it.message}` : null,
    routing_phase: rt?.phase ?? null,
    routing_error: rt?.phase === "error" ? `${rt.code}: ${rt.message}` : null,
    speech_unlocked: unlocked,
    user_agent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
  };
}

const REPORT_THROTTLE_MS = 500;
/** Larger face on the portrait phone so it stays the visual centre. */
const PHONE_FACE = { idle: "78%", active: "46%" };

export function InputPage() {
  const [ctx, dispatch] = useReducer(interactionReducer, initialContext);
  useWakeLock();

  // Camera → PERSON_DETECTED (only from IDLE, only once per arrival).
  // `personPresent` is already debounced inside the hook.
  // Re-arm rule: after a session returns to IDLE, the scene must first be
  // empty (personPresent = false) before the next trigger — so the rider who
  // just sat down doesn't immediately restart the conversation.
  // The camera never dispatches anything in the other states.
  const detection = usePersonDetection();
  const armedRef = useRef(true);
  useEffect(() => {
    if (!detection.personPresent) {
      armedRef.current = true;
      return;
    }
    if (ctx.state === "IDLE" && armedRef.current) {
      armedRef.current = false;
      dispatch({ type: "PERSON_DETECTED" });
    } else if (ctx.state !== "IDLE") {
      armedRef.current = false; // someone is in a session — don't re-trigger on return to IDLE
    }
  }, [detection.personPresent, ctx.state]);

  // Spoken prompt: once per ENTRY into PERSON_DETECTED.
  // Each entry into a state gets a new `ctx.enteredAt` timestamp, so we key the
  // speech on that value and remember the last one we spoke for. Re-renders
  // (and React StrictMode's double effect run) see the same value → no replay.
  // A new session later has a new `enteredAt` → speaks again.
  // Returning to IDLE (Reset / session end) cancels any speech in progress.
  const [speechStatus, setSpeechStatus] = useState("waiting for first click");
  const spokenForRef = useRef<number | null>(null);
  const enteredAtRef = useRef(ctx.enteredAt);
  enteredAtRef.current = ctx.enteredAt;
  const [unlocked, setUnlocked] = useState(false);
  useEffect(
    () =>
      installSpeechUnlock(() => {
        setSpeechStatus("ready");
        setUnlocked(true);
      }),
    []
  );
  useEffect(() => {
    if (ctx.state === "IDLE") {
      cancelSpeech();
      return;
    }
    if (ctx.state !== "PERSON_DETECTED" || spokenForRef.current === ctx.enteredAt) return;
    spokenForRef.current = ctx.enteredAt;
    const kind = ctx.prompt;
    setSpeechStatus(`speaking (${kind})`);
    const session = ctx.enteredAt;
    speak(PROMPT_TEXT[kind]).then((r) => {
      setSpeechStatus(r === "blocked" ? "blocked — click the page once (continuing silently)" : r);
      // Prompt finished → PROMPT_FINISHED. Only for THIS entry into PERSON_DETECTED
      // (a Reset cancels speech → "cancelled" → no transition). If speech was
      // blocked/unsupported, continue anyway — the text is on screen.
      //   ask / retry → LISTENING (SpeechRecognition starts again automatically)
      //   giveup      → IDLE, after a short pause
      if (r === "cancelled" || enteredAtRef.current !== session) return;
      const go = () => {
        if (enteredAtRef.current === session) dispatch({ type: "PROMPT_FINISHED" });
      };
      if (kind === "giveup") window.setTimeout(go, GIVEUP_RETURN_TO_IDLE_MS);
      else go();
    });
  }, [ctx.state, ctx.enteredAt]);

  // Spoken recommendation: once per ENTRY into RECOMMENDATION (same enteredAt
  // dedupe as the prompt). When it finishes, wait RETURN_TO_IDLE_MS, then
  // SESSION_END → Frame 1 goes back to IDLE for the next rider. The LED keeps
  // its own state and is not touched. If speech couldn't play (blocked /
  // unsupported), the recommendation stays on screen a bit longer instead.
  const returnTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (ctx.state !== "RECOMMENDATION") {
      window.clearTimeout(returnTimerRef.current); // Reset / manual change → no late SESSION_END
      return;
    }
    if ((!ctx.recommendation && !ctx.redirect) || spokenForRef.current === ctx.enteredAt) return;
    spokenForRef.current = ctx.enteredAt;
    const session = ctx.enteredAt;
    const isRedirect = !ctx.recommendation && !!ctx.redirect;
    const sentence = ctx.recommendation
      ? recommendationSentence(ctx.recommendation.route, ctx.recommendation.etaMinutes)
      : redirectSentence(ctx.redirect!);
    const redirectKind = ctx.redirect?.kind ?? "opposite_direction";
    setSpeechStatus(isRedirect ? `speaking ${redirectKind} guidance` : "speaking recommendation");
    speak(sentence).then((r) => {
      setSpeechStatus(r === "blocked" ? "blocked — click the page once" : r);
      if (r === "cancelled" || enteredAtRef.current !== session) return;
      const wait =
        r === "ended"
          ? isRedirect
            ? REDIRECT_RETURN_TO_IDLE_MS[redirectKind]
            : RETURN_TO_IDLE_MS
          : SILENT_DISPLAY_MS;
      window.clearTimeout(returnTimerRef.current);
      returnTimerRef.current = window.setTimeout(() => {
        if (enteredAtRef.current === session) dispatch({ type: "SESSION_END" });
      }, wait);
    });
  }, [ctx.state, ctx.enteredAt, ctx.recommendation, ctx.redirect]);

  // LISTENING → microphone + speech recognition → SPEECH_CAPTURED(transcript).
  // Starts once per LISTENING entry (keyed on enteredAt); aborted on leaving.
  const speech = useSpeechCapture({
    active: ctx.state === "LISTENING",
    sessionKey: ctx.enteredAt,
    onFinal: (transcript) => dispatch({ type: "SPEECH_CAPTURED", transcript }),
    // Silence → spoken retry prompt → LISTENING again (max MAX_RETRIES per session).
    onNoSpeech: () => dispatch({ type: "RETRY_NEEDED", reason: "no_speech" }),
  });

  // PROCESSING → AI destination interpretation (backend: POST /api/interpret-destination).
  // Runs once per PROCESSING entry; the request is aborted if the state leaves
  // PROCESSING (e.g. Reset). The result is stored in ctx.interpretation; the
  // state stays PROCESSING (no route / ETA yet — SEPTA comes next).
  useEffect(() => {
    if (ctx.state !== "PROCESSING") return;
    // Send the RAW transcript — the backend AI treats it as possibly misheard and
    // recovers real Philadelphia places, which are then verified against real
    // place data. The local alias normalization is only an optional hint.
    const transcript = (ctx.transcript ?? "").trim();
    const localHint = ctx.normalizedTranscript?.trim() || null;
    if (!transcript) {
      dispatch({
        type: "INTERPRETATION_FAILED",
        code: "empty_transcript",
        message: "No transcript — AI not called",
      });
      return;
    }
    const controller = new AbortController();
    dispatch({ type: "INTERPRETATION_STARTED" });
    interpretDestination(transcript, localHint, controller.signal)
      .then((result) => {
        dispatch({ type: "INTERPRETATION_READY", result });
        // The AI couldn't pin down a destination → ask the rider again.
        // (Routing outcomes like no_direct_route / opposite_direction and
        // backend errors are NOT retried.)
        if (result.status === "needs_clarification" || result.status === "not_a_destination") {
          dispatch({ type: "RETRY_NEEDED", reason: result.status });
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const code = e instanceof InterpretError ? e.code : "unknown";
        dispatch({ type: "INTERPRETATION_FAILED", code, message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [ctx.state, ctx.enteredAt, ctx.transcript, ctx.normalizedTranscript]);

  // AI destination (status ok) → backend transit routing (static GTFS Route 21
  // reachability from stop 623 Chestnut St & 37th St, or from the opposite stop
  // 21362 Walnut St & 37th St) + live SEPTA Route 21 ETA
  // → RECOMMENDATION_READY, or REDIRECT_READY ("walking may be faster" / "use the other stop").
  // The route/ETA come only from the backend's GTFS/SEPTA result; the AI never
  // picks a route. For status ok the BACKEND assigns the LED in the shared session (→ /output).
  // walk_recommended / opposite_direction / no_direct_route → REDIRECT_READY (spoken guidance, then
  // IDLE; the LED is never touched). Other non-ok results (destination_not_found,
  // no_eta_available) stay in PROCESSING and are shown in the DEV panel only.
  useEffect(() => {
    if (ctx.state !== "PROCESSING") return;
    const it = ctx.interpretation;
    if (it?.phase !== "done" || it.result.status !== "ok") return;
    const controller = new AbortController();
    dispatch({ type: "ROUTING_STARTED" });
    recommendRoute(it.result, controller.signal)
      .then((result) => {
        dispatch({ type: "ROUTING_RESULT", result });
        if (result.status === "ok" && result.selected_route && result.eta_minutes != null) {
          dispatch({
            type: "RECOMMENDATION_READY",
            recommendation: { route: result.selected_route, etaMinutes: result.eta_minutes },
          });
        } else if (result.status === "walk_recommended" && result.walking_minutes != null) {
          // Short walk from here: suggest walking (no bus recommendation, no ETA, no LED).
          dispatch({
            type: "REDIRECT_READY",
            redirect: { kind: "walk_recommended", stopId: "", stopName: "", walkingMinutes: result.walking_minutes },
          });
        } else if (result.status === "opposite_direction" && result.recommended_stop_name) {
          // Reachable only from the other stop: guide the rider there (no ETA, no LED).
          dispatch({
            type: "REDIRECT_READY",
            redirect: {
              kind: "opposite_direction",
              stopId: result.recommended_stop_id ?? "",
              stopName: result.recommended_stop_name,
            },
          });
        } else if (result.status === "no_direct_route") {
          // Route 21 doesn't reach it from either stop: tell the rider (no LED change).
          dispatch({
            type: "REDIRECT_READY",
            redirect: { kind: "no_direct_route", stopId: "", stopName: "" },
          });
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const code = e instanceof RouteError ? e.code : "unknown";
        dispatch({ type: "ROUTING_FAILED", code, message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [ctx.state, ctx.interpretation]);

  // ── Shared session: report this device's state (throttled, changes only) ──
  const report = inputReport(ctx, detection, speech, speechStatus, unlocked);
  const status = riderStatus(ctx);
  const message = riderMessage(ctx);
  const payload = JSON.stringify({ input: report, status, message });
  const lastSentRef = useRef<string>("");
  const sendTimerRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef(payload);
  pendingRef.current = payload;
  useEffect(() => {
    if (payload === lastSentRef.current || sendTimerRef.current !== undefined) return;
    sendTimerRef.current = window.setTimeout(() => {
      sendTimerRef.current = undefined;
      const body = pendingRef.current;
      if (body === lastSentRef.current) return;
      lastSentRef.current = body;
      postInputUpdate(JSON.parse(body)).catch(() => {
        lastSentRef.current = ""; // backend unreachable → resend on the next change
      });
    }, REPORT_THROTTLE_MS);
  }, [payload]);
  useEffect(() => () => window.clearTimeout(sendTimerRef.current), []);

  // ── Shared session: researcher "Reset Input" from /monitor ──
  const inputView = usePoll(fetchInputView, POLL_MS);
  const resetSeqRef = useRef<number | null>(null);
  useEffect(() => {
    const seq = inputView.data?.input_reset_seq;
    if (seq === undefined) return;
    if (resetSeqRef.current !== null && seq !== resetSeqRef.current) {
      cancelSpeech();
      dispatch({ type: "RESET" });
    }
    resetSeqRef.current = seq;
  }, [inputView.data?.input_reset_seq]);

  return (
    <main className="page-input">
      <AiPanel ctx={ctx} faceSize={PHONE_FACE} />
    </main>
  );
}
