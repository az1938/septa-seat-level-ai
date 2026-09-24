import { useEffect, useState } from "react";
import {
  STATE_ORDER,
  MAX_RETRIES,
  nextEventFor,
  type InteractionContext,
  type InteractionEvent,
  type Recommendation,
  type RouteResult,
} from "../state/interactionMachine";
import type { LedEvent, LedState } from "../state/ledMachine";
import type { PersonDetection } from "../hooks/usePersonDetection";
import { CameraPreview } from "./CameraPreview";
import { currentVoiceLabel } from "../lib/speech";
import type { SpeechCapture } from "../hooks/useSpeechCapture";

const MIC_LABEL: Record<SpeechCapture["micStatus"], string> = {
  unknown: "—",
  listening: "STARTING…",
  granted: "READY",
  denied: "PERMISSION DENIED",
  "no-microphone": "NOT FOUND",
};

// Developer-only controller. Not part of the rider-facing design.
//
//   Next ▸   — sends the normal event for the current state (legal path only)
//   1–5      — jump straight to a state (bypasses the transition table)
//   Reset    — AI panel back to IDLE (the LED is NOT cleared)
//   Clear LED — empties the seat-level LED tile (separate LED session)
//
// Keyboard: → / Space = Next · 1–5 = jump · Esc = Reset · ` = hide/show
//
// The mock route/ETA below exists ONLY so the RECOMMENDATION state and the
// LED colors can be previewed before SEPTA is connected. It is clearly
// labelled as mock and will be replaced by real routing + live ETA.

const ETA_PRESETS = [
  { label: "12 min (red)", value: 12 },
  { label: "6 min (yellow)", value: 6 },
  { label: "2 min (green)", value: 2 },
  { label: "arriving (white)", value: 0 },
];

interface Props {
  ctx: InteractionContext;
  dispatch: (e: InteractionEvent) => void;
  led: LedState;
  ledDispatch: (e: LedEvent) => void;
  detection: PersonDetection;
  speechStatus: string;
  speech: SpeechCapture;
}

export function DevController({
  ctx,
  dispatch,
  led,
  ledDispatch,
  detection,
  speechStatus,
  speech,
}: Props) {
  const [open, setOpen] = useState(true);
  const [mock, setMock] = useState<Recommendation>({ route: "21", etaMinutes: 6 });

  // Keep the lit tile in sync when the mock values change during RECOMMENDATION.
  useEffect(() => {
    if (ctx.state === "RECOMMENDATION") {
      dispatch({ type: "DEV_JUMP", to: "RECOMMENDATION", recommendation: mock });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLSelectElement) return;
      if (e.key === "`") return setOpen((o) => !o);
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        dispatch(nextEventFor(ctx.state, mock));
      } else if (e.key === "Escape") {
        dispatch({ type: "RESET" });
      } else if (/^[1-5]$/.test(e.key)) {
        dispatch({ type: "DEV_JUMP", to: STATE_ORDER[Number(e.key) - 1], recommendation: mock });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx.state, mock, dispatch]);

  if (!open) {
    return (
      <button className="dev-toggle" onClick={() => setOpen(true)} title="Show dev controller (`)">
        DEV
      </button>
    );
  }

  return (
    <aside className="dev" aria-label="Developer controller">
      <header className="dev-head">
        <span>DEV · state machine</span>
        <button className="dev-x" onClick={() => setOpen(false)} title="Hide (`)">
          ×
        </button>
      </header>

      <CameraPreview detection={detection} />
      <p className="dev-foot">
        SPEECH: {speechStatus} · {currentVoiceLabel()}
        <br />
        PROMPT: {ctx.prompt} · RETRIES: {ctx.retryCount}/{MAX_RETRIES}
        {ctx.retryReason ? ` (last: ${ctx.retryReason})` : ""}
      </p>
      <div className="dev-mic">
        <p className="dev-cam-status">
          MICROPHONE:{" "}
          <strong data-on={speech.micStatus === "granted"}>
            {speech.supported ? MIC_LABEL[speech.micStatus] : "UNSUPPORTED BROWSER"}
          </strong>
          {speech.listening && <span className="dev-cam-score"> · listening (try {speech.attempt})</span>}
          <br />
          {speech.listening && (
            <>
              HEARING: “{speech.interim || "…"}”
              <br />
            </>
          )}
          RAW TRANSCRIPT: {ctx.transcript ? <strong data-on="true">“{ctx.transcript}”</strong> : "—"}
          {ctx.transcript && (
            <>
              <br />
              NORMALIZED TRANSCRIPT:{" "}
              <strong data-on={ctx.normalizedTranscript !== ctx.transcript}>“{ctx.normalizedTranscript}”</strong>
              {ctx.normalizedTranscript === ctx.transcript && <span className="dev-cam-score"> (unchanged)</span>}
            </>
          )}
        </p>
        {speech.error && <p className="dev-cam-error">{speech.error}</p>}
        <AiResult ctx={ctx} />
        <RoutingResult ctx={ctx} />
        {ctx.state === "LISTENING" && !speech.listening && speech.supported && (
          <button className="dev-btn" onClick={speech.retry}>
            Listen again
          </button>
        )}
      </div>

      <div className="dev-states">
        {STATE_ORDER.map((s, i) => (
          <button
            key={s}
            className="dev-state"
            data-active={ctx.state === s}
            onClick={() => dispatch({ type: "DEV_JUMP", to: s, recommendation: mock })}
          >
            <kbd>{i + 1}</kbd> {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="dev-row">
        <button className="dev-btn primary" onClick={() => dispatch(nextEventFor(ctx.state, mock))}>
          Next ▸
        </button>
        <button className="dev-btn" onClick={() => dispatch({ type: "RESET" })}>
          Reset
        </button>
      </div>

      <div className="dev-row">
        <button
          className="dev-btn"
          onClick={() => ledDispatch({ type: "LED_CLEAR" })}
          disabled={led.status === "EMPTY"}
        >
          Clear LED
        </button>
      </div>
      <p className="dev-foot">
        LED:{" "}
        {led.status === "ASSIGNED"
          ? `ASSIGNED · ${led.recommendation.route} / ${led.recommendation.etaMinutes} min` +
            (led.source ? ` · ${led.source}` : "") +
            (led.tracking
              ? ` · refreshed ${
                  led.lastRefreshAt ? new Date(led.lastRefreshAt).toLocaleTimeString() : "— (every 10 s)"
                }`
              : " · mock (no refresh)")
          : "EMPTY"}
      </p>
      {led.status === "ASSIGNED" && led.refreshError && (
        <p className="dev-cam-error">LED refresh failed (keeping last ETA): {led.refreshError}</p>
      )}

      <fieldset className="dev-mock">
        <legend>Mock recommendation (no SEPTA yet)</legend>
        <label>
          Route
          <select value={mock.route} onChange={(e) => setMock({ ...mock, route: e.target.value })}>
            {["9", "21", "42"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          ETA
          <select
            value={mock.etaMinutes}
            onChange={(e) => setMock({ ...mock, etaMinutes: Number(e.target.value) })}
          >
            {ETA_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <p className="dev-foot">→/Space next · 1–5 jump · Esc reset · ` hide</p>
    </aside>
  );
}

// DEV-only view of the AI destination interpretation.
function AiResult({ ctx }: { ctx: InteractionContext }) {
  const it = ctx.interpretation;
  if (!it) return null;
  if (it.phase === "pending") return <p className="dev-cam-status">AI DESTINATION: interpreting…</p>;
  if (it.phase === "error")
    return <p className="dev-cam-error">AI ERROR ({it.code}): {it.message}</p>;
  const r = it.result;
  return (
    <p className="dev-cam-status">
      {r.status === "ok" ? (
        <>
          AI DESTINATION: <strong data-on="true">{r.intersection_or_address ?? r.place_name ?? r.destination_text}</strong>
          <br />
          {r.place_name && r.intersection_or_address && (
            <>
              PLACE: {r.place_name}
              <br />
            </>
          )}
          TYPE: {r.destination_type} · CONFIDENCE: {r.confidence.toFixed(2)}
        </>
      ) : (
        <>
          AI: <strong>{r.status === "needs_clarification" ? "NEEDS CLARIFICATION" : "NOT A DESTINATION"}</strong>
          <br />“{r.clarification_question}”
        </>
      )}
    </p>
  );
}

// DEV-only: how the AI's destination was resolved to a place / address / stops.
function DestinationResolution({ r }: { r: RouteResult }) {
  const inp = r.destination_input ?? {};
  const raw = inp.place_name || inp.destination_text || inp.intersection_or_address || "—";
  return (
    <>
      RAW DESTINATION: {raw}
      <br />
      RESOLVED PLACE: {r.resolved_place ?? "—"}
      {r.matched_alias ? ` (alias “${r.matched_alias}”)` : ""}
      <br />
      RESOLVED ADDRESS: {r.resolved_address ?? "—"}
      <br />
      MATCH METHOD: {r.match_method ?? "none"}
      <br />
      NEARBY STOPS:{" "}
      {r.candidate_stops && r.candidate_stops.length
        ? r.candidate_stops
            .slice(0, 4)
            .map((c) => `${c.stop_id} ${c.name} (${c.distance_m} m)`)
            .join(" · ")
        : "none"}
      <br />
    </>
  );
}

// DEV-only view of the transit routing (static GTFS + live SEPTA).
function RoutingResult({ ctx }: { ctx: InteractionContext }) {
  const rt = ctx.routing;
  if (!rt) return null;
  if (rt.phase === "pending") return <p className="dev-cam-status">ROUTING: checking GTFS + live SEPTA…</p>;
  if (rt.phase === "error") return <p className="dev-cam-error">ROUTING ERROR ({rt.code}): {rt.message}</p>;
  const r = rt.result;
  if (r.status === "opposite_direction") {
    return (
      <p className="dev-cam-status">
        <DestinationResolution r={r} />
        ROUTING: <strong data-on="true">OPPOSITE DIRECTION</strong>
        <br />
        CURRENT STOP: {r.current_stop_id} ({r.current_stop_name})
        <br />
        RECOMMENDED STOP: {r.recommended_stop_id} ({r.recommended_stop_name})
        <br />
        DESTINATION STOP: {r.destination_stop} ({r.destination_name}
        {r.destination_distance_m ? `, ${r.destination_distance_m} m away` : ""})
        <br />
        VALID ROUTES FROM OTHER STOP: {(r.valid_routes ?? []).join(", ") || "none"}
      </p>
    );
  }
  const label: Record<string, string> = {
    no_direct_route: "NO DIRECT ROUTE (9/21/42, either direction)",
    destination_not_found: "DESTINATION NOT MATCHED TO A STOP",
    no_eta_available: "NO LIVE OR SCHEDULED ETA",
  };
  return (
    <div>
      <p className="dev-cam-status">
        <DestinationResolution r={r} />
        ROUTING: <strong data-on={r.status === "ok"}>{r.status === "ok" ? "OK" : label[r.status]}</strong>
        {r.destination_stop ? (
          <>
            <br />
            DESTINATION STOP: {r.destination_stop} ({r.destination_name}
            {r.destination_distance_m ? `, ${r.destination_distance_m} m away` : ""})
          </>
        ) : (
          r.candidate_stops &&
          r.candidate_stops.length > 0 && (
            <>
              <br />
              NEAR STOPS: {r.candidate_stops.slice(0, 3).map((c) => c.stop_id).join(", ")}
            </>
          )
        )}
        <br />
        VALID ROUTES: {r.valid_routes && r.valid_routes.length ? r.valid_routes.join(", ") : "none"}
        {r.route_etas && r.route_etas.length > 0 && (
          <>
            <br />
            ETAS: {r.route_etas.map((e) => `${e.route}=${e.eta_minutes}m ${e.eta_source}`).join(" · ")}
          </>
        )}
        {r.status === "ok" && (
          <>
            <br />
            SELECTED: <strong data-on="true">{r.selected_route}</strong> · ETA: {r.eta_minutes} min · SOURCE:{" "}
            {r.eta_source}
          </>
        )}
      </p>
      {r.live_error && <p className="dev-cam-error">{r.live_error}</p>}
      {r.match_errors?.map((m) => (
        <p key={m} className="dev-cam-error">
          {m}
        </p>
      ))}
    </div>
  );
}
