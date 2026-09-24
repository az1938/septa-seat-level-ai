import { useEffect, useReducer, useRef, useState } from "react";
import { initialContext, interactionReducer, type PromptKind, type Redirect } from "./state/interactionMachine";
import { initialLedState, ledReducer, ledRecommendation } from "./state/ledMachine";
import { AiPanel } from "./components/AiPanel";
import { LedTile } from "./components/LedTile";
import { DevController } from "./components/DevController";
import { usePersonDetection } from "./hooks/usePersonDetection";
import { cancelSpeech, installSpeechUnlock, speak } from "./lib/speech";
import { useSpeechCapture } from "./hooks/useSpeechCapture";
import { InterpretError, interpretDestination } from "./lib/interpretApi";
import { RouteError, recommendRoute } from "./lib/routeApi";
import { useLedEtaRefresh } from "./hooks/useLedEtaRefresh";

const PROMPT_TEXT: Record<PromptKind, string> = {
  ask: "Where are you going?",
  retry: "Sorry, I didn't catch that. Please say your destination again.",
  giveup: "Please try again.",
};
const GIVEUP_RETURN_TO_IDLE_MS = 1500; // after "Please try again."
const RETURN_TO_IDLE_MS = 2000; // after the spoken recommendation finishes
const SILENT_DISPLAY_MS = 6000; // if speech could not play, keep the text up longer
const REDIRECT_RETURN_TO_IDLE_MS: Record<Redirect["kind"], number> = {
  opposite_direction: 3000, // after "…please use the … stop."
  no_direct_route: 2000, // after "…please try another destination."
};

/** "Chestnut St & 15th St" → "Chestnut Street and 15th Street" for the voice only. */
function spokenStopName(name: string): string {
  return name
    .replace(/\s+-\s+\w+$/, "")
    .replace(/&/g, "and")
    .replace(/\bSt\b\.?/g, "Street")
    .replace(/\bAve?\b\.?/g, "Avenue")
    .replace(/\bBlvd\b\.?/g, "Boulevard");
}

function redirectSentence(r: Redirect): string {
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

// Two frames on a blank page, driven by TWO independent state domains:
//
//   A. AI interaction session (interactionMachine.ts) → Frame 1
//      IDLE → PERSON_DETECTED → LISTENING → PROCESSING → RECOMMENDATION → IDLE
//
//   B. LED waiting session (ledMachine.ts) → Frame 2
//      EMPTY → ASSIGNED(route, eta) → … → LED_CLEAR → EMPTY
//
// The only link between them: when the interaction produces a recommendation,
// it is handed to the LED (LED_ASSIGN). After that the LED is on its own —
// the AI panel returning to IDLE does not clear it.
//
// Future hookup points (not built yet), one effect per state:
//   IDLE             → camera watches for a person        → PERSON_DETECTED
//   PERSON_DETECTED  → speak "Where are you going?"       → PROMPT_FINISHED
//   LISTENING        → microphone + speech-to-text        → SPEECH_CAPTURED
//   PROCESSING       → AI destination → SEPTA route/ETA   → RECOMMENDATION_READY
//   RECOMMENDATION   → speak result; LED keeps live ETA   → SESSION_END
export default function App() {
  const [ctx, dispatch] = useReducer(interactionReducer, initialContext);
  const [led, ledDispatch] = useReducer(ledReducer, initialLedState);

  // Hand-off A → B: a new recommendation is assigned to the rider's LED tile.
  // (Also fires when the dev controller changes the mock while in RECOMMENDATION.)
  useEffect(() => {
    if (ctx.state === "RECOMMENDATION" && ctx.recommendation) {
      // Real recommendations carry what the LED needs to keep refreshing the SAME
      // route/destination (and bus). DEV mock recommendations have no tracking.
      const r = ctx.routing?.phase === "done" ? ctx.routing.result : null;
      const real = r?.status === "ok" && r.selected_route === ctx.recommendation.route;
      ledDispatch({
        type: "LED_ASSIGN",
        recommendation: ctx.recommendation,
        tracking: real
          ? { stop: r!.origin_stop, dest: r!.destination_stop ?? null, tripId: r!.selected_trip_id ?? null }
          : null,
        source: real ? r!.eta_source ?? null : null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state, ctx.recommendation]);

  // LED live ETA refresh (every 10 s, chosen route only) — independent of Frame 1.
  useLedEtaRefresh(led, ledDispatch);

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
  useEffect(() => installSpeechUnlock(() => setSpeechStatus("ready")), []);
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
    // Send the locally normalized transcript (known place-name fixes); raw is kept in ctx.transcript.
    const transcript = (ctx.normalizedTranscript ?? ctx.transcript ?? "").trim();
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
    interpretDestination(transcript, controller.signal)
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

  // AI destination (status ok) → backend transit routing (static GTFS reachability
  // from stop 14079, or from the opposite stop 6060) + live SEPTA ETA
  // → RECOMMENDATION_READY, or REDIRECT_READY ("use the other stop").
  // The route/ETA come only from the backend's GTFS/SEPTA result; the AI never
  // picks a route. RECOMMENDATION_READY also hands the route to the LED (see above).
  // opposite_direction / no_direct_route → REDIRECT_READY (spoken guidance, then
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
        } else if (result.status === "opposite_direction" && result.recommended_stop_name) {
          // Reachable only from the other stop: guide the rider there (no ETA, no LED).
          dispatch({
            type: "REDIRECT_READY",
            redirect: {
              kind: "opposite_direction",
              stopId: result.recommended_stop_id ?? "",
              stopName: result.recommended_stop_name,
              validRoutes: result.valid_routes ?? [],
            },
          });
        } else if (result.status === "no_direct_route") {
          // Not reachable from either stop on 9/21/42: tell the rider (no LED change).
          dispatch({
            type: "REDIRECT_READY",
            redirect: { kind: "no_direct_route", stopId: "", stopName: "", validRoutes: [] },
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

  return (
    <main className="page">
      <section className="frame">
        <h2 className="frame-label">
          <span>01</span> AI Interaction Panel
        </h2>
        <AiPanel ctx={ctx} />
      </section>

      <section className="frame">
        <h2 className="frame-label">
          <span>02</span> Seat-Level LED Tile
        </h2>
        <LedTile recommendation={ledRecommendation(led)} />
      </section>

      <DevController
        ctx={ctx}
        dispatch={dispatch}
        led={led}
        ledDispatch={ledDispatch}
        detection={detection}
        speechStatus={speechStatus}
        speech={speech}
      />
    </main>
  );
}
