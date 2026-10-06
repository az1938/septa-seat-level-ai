import { useEffect, useRef, useState, type ReactNode } from "react";
import { AiResult, RoutingResult } from "../components/DevController";
import { POLL_MS, fetchFullSession, mockLed, resetSession, type SharedSession } from "../lib/sessionApi";
import { usePoll } from "../hooks/usePoll";
import { API_BASE_URL } from "../lib/apiBase";
import type { Interpretation, Routing } from "../state/interactionMachine";

// ─────────────────────────────────────────────────────────────────────────────
// /monitor — researcher-only laptop view. Never shown to participants.
// Polls the FULL shared session (GET /api/session) every 1 s and shows the whole
// pipeline: input device (camera / mic / speech), transcript, AI recovery,
// walking + Route 21 routing, the LED on /output, and errors.
// Controls: Reset Input · Clear Session / LED · test mode (mock Route 21 ETA).
// ─────────────────────────────────────────────────────────────────────────────

const ETA_CHOICES = [5, 4, 3, 2, 1, 0];
const COUNTDOWN_CHOICES = [
  { label: "count down in real time (60 s / min)", value: 60 },
  { label: "fast countdown (10 s / min)", value: 10 },
  { label: "static (no countdown)", value: 0 },
];

function splitErr(e: string | null): { code: string; message: string } {
  const i = (e ?? "").indexOf(":");
  return i > 0 ? { code: e!.slice(0, i), message: e!.slice(i + 1).trim() } : { code: "error", message: e ?? "" };
}

function interpretationOf(s: SharedSession): Interpretation | null {
  if (s.interpretation_phase === "pending") return { phase: "pending" };
  if (s.interpretation_phase === "error") return { phase: "error", ...splitErr(s.interpretation_error) };
  if (s.interpretation) return { phase: "done", result: s.interpretation };
  // the request never reached the backend (network) — only /input knows
  if (s.input.interpretation_phase === "error")
    return { phase: "error", ...splitErr(`client ${s.input.interpretation_error ?? ""}`) };
  return null;
}

function routingOf(s: SharedSession): Routing | null {
  if (s.routing_phase === "pending") return { phase: "pending" };
  if (s.routing_phase === "error") return { phase: "error", ...splitErr(s.routing_error) };
  if (s.routing) return { phase: "done", result: s.routing };
  if (s.input.routing_phase === "error") return { phase: "error", ...splitErr(`client ${s.input.routing_error ?? ""}`) };
  return null;
}

function age(now: number, t: number | null): string {
  if (!t) return "never";
  const d = Math.max(0, now - t);
  return d < 1.5 ? "just now" : d < 90 ? `${Math.round(d)} s ago` : `${Math.round(d / 60)} min ago`;
}

function clock(t: number | string | null): string {
  if (!t) return "—";
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  return d.toLocaleTimeString();
}

function Card({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className="mon-card" data-wide={wide}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function On({ on, children }: { on: boolean; children: ReactNode }) {
  return <strong data-on={on}>{children}</strong>;
}

function direction(s: SharedSession): string {
  const r = s.routing;
  if (!r) return "—";
  if (r.status === "ok") return `from current stop ${r.origin_stop} (${r.origin_name ?? ""})`;
  if (r.status === "opposite_direction")
    return `OPPOSITE — current ${r.current_stop_id} (${r.current_stop_name}) → use ${r.recommended_stop_id} (${r.recommended_stop_name})`;
  if (r.status === "walk_recommended") {
    const t = r.route21_if_not_walking;
    return t ? `(walk suggested) Route 21 would be: ${t.status}${t.from_stop ? ` from ${t.from_stop}` : ""}` : "—";
  }
  return r.status;
}

export function MonitorPage() {
  const { data: s, error, lastOkAt } = usePoll(fetchFullSession, POLL_MS);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [mockEta, setMockEta] = useState(5);
  const [countdown, setCountdown] = useState(60);

  // several backend processes would each have their OWN session → warn
  const pidsRef = useRef<Set<number>>(new Set());
  const [pidWarning, setPidWarning] = useState(false);
  useEffect(() => {
    if (!s) return;
    pidsRef.current.add(s.server.pid);
    if (pidsRef.current.size > 1) setPidWarning(true);
  }, [s]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      setActionMsg(`${label} ✓ ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setActionMsg(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const inp = s?.input ?? {};
  const now = s?.now ?? Date.now() / 1000;
  const mobile = inp.input_mode === "mobile-recorder";
  const speechUnsupported = !mobile && inp.speech_supported === false;

  return (
    <main className="page-monitor">
      <header className="mon-head">
        <div>
          <h1>Seat-Level ETA · MONITOR</h1>
          <p>researcher only — not shown to participants</p>
        </div>
        <p className="mon-conn">
          BACKEND: <On on={!error && !!s}>{error ? `UNREACHABLE (${error})` : s ? "OK" : "connecting…"}</On>
          <br />
          {API_BASE_URL || "local (Vite proxy → :8788)"} · poll {POLL_MS / 1000} s · last ok{" "}
          {lastOkAt ? new Date(lastOkAt).toLocaleTimeString() : "—"}
          <br />
          SESSION {s?.session_id ?? "—"} · v{s?.version ?? "—"} · updated {clock(s?.updated_at ?? null)} · pid{" "}
          {s?.server.pid ?? "—"}
        </p>
      </header>

      {pidWarning && (
        <p className="mon-alert">
          Responses came from more than one backend process — the in-memory session is NOT shared. Run the backend
          with ONE worker: gunicorn app:app --workers 1 --threads 8
        </p>
      )}
      {speechUnsupported && (
        <p className="mon-alert">
          INPUT DEVICE: this browser does not support the Web Speech recognition API (SpeechRecognition /
          webkitSpeechRecognition). The rider cannot speak a destination on this device. ({inp.user_agent})
        </p>
      )}

      <section className="mon-controls">
        <button className="dev-btn" disabled={!!busy} onClick={() => act("Reset Input", () => resetSession("input"))}>
          Reset Input
          <small>/input → IDLE · LED kept</small>
        </button>
        <button className="dev-btn" disabled={!!busy} onClick={() => act("Clear Session / LED", () => resetSession("led"))}>
          Clear Session / LED
          <small>route · ETA · trip cleared → /output blank</small>
        </button>
        <fieldset className="dev-mock mon-mock">
          <legend>TEST MODE (no SEPTA)</legend>
          <label>
            ETA
            <select value={mockEta} onChange={(e) => setMockEta(Number(e.target.value))}>
              {ETA_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "ARRIVING" : `${m} min`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Countdown
            <select value={countdown} onChange={(e) => setCountdown(Number(e.target.value))}>
              {COUNTDOWN_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="dev-btn primary"
            disabled={!!busy}
            onClick={() => act("Mock Route 21", () => mockLed(mockEta, countdown || null))}
          >
            Mock Route 21
          </button>
        </fieldset>
        <p className="mon-action">{busy ? `${busy}…` : actionMsg ?? ""}</p>
      </section>

      {!s ? (
        <p className="mon-empty">Waiting for the backend session…</p>
      ) : (
        <div className="mon-grid">
          <Card title={`Input device · ${mobile ? "/input-mobile" : inp.input_mode ? "/input-desktop" : "/input"}`}>
            <p className="dev-cam-status">
              CONNECTED: last report {age(now, s.input_last_update)} · last poll {age(now, s.input_last_poll)}
              <br />
              INPUT MODE: <On on={!!inp.input_mode}>{inp.input_mode ?? "—"}</On>
              <br />
              STATUS: <On on={s.status !== "idle"}>{s.status.toUpperCase()}</On> · STATE: {inp.state ?? "—"}
              <br />
              PROMPT: {inp.prompt ?? "—"} · RETRIES: {inp.retry_count ?? 0}
              {inp.retry_reason ? ` (last: ${inp.retry_reason})` : ""}
              <br />
              MESSAGE: {s.message ? `“${s.message}”` : "—"}
              <br />
              <br />
              CAMERA: {inp.camera_status ?? "—"} · MODEL: {inp.model_status ?? "—"}
              <br />
              PERSON DETECTED: <On on={!!inp.person_present}>{inp.person_present ? "YES" : inp.raw_detected ? "CONFIRMING…" : "NO"}</On>
              {inp.score != null ? ` (${inp.score.toFixed(1)})` : ""}
              <br />
              SPEECH STATUS: {inp.speech_status ?? "—"} · audio unlocked: {inp.speech_unlocked ? "yes" : "NO (tap /input once)"}
              <br />
              VOICE: {inp.voice ?? "—"}
              <br />
              {mobile ? (
                <>
                  RECORDER: <On on={inp.recorder_status === "recording"}>{(inp.recorder_status ?? "—").toUpperCase()}</On>
                  {" · "}AUDIO MIME: {inp.audio_mime ?? "—"}
                  <br />
                  UPLOAD: <On on={inp.upload_status === "done"}>{(inp.upload_status ?? "—").toUpperCase()}</On>
                  <br />
                  TRANSCRIPTION: {inp.transcription != null ? `“${inp.transcription}”` : "—"}
                  {inp.transcription_model ? ` · ${inp.transcription_model}` : ""}
                  {inp.transcription_ms != null ? ` · ${inp.transcription_ms} ms` : ""}
                </>
              ) : (
                <>
                  SPEECH RECOGNITION:{" "}
                  <On on={inp.speech_supported === true}>{inp.speech_supported === false ? "UNSUPPORTED" : inp.speech_supported ? "SUPPORTED" : "—"}</On>
                </>
              )}
              <br />
              MICROPHONE: <On on={inp.mic_status === "granted"}>{(inp.mic_status ?? "—").toUpperCase()}</On>
              {inp.listening ? " · listening" : ""}
              {inp.listening && (
                <>
                  <br />
                  HEARING: “{inp.interim || "…"}”
                </>
              )}
              <br />
              DEVICE: {inp.viewport ?? "—"} · {inp.user_agent ?? "—"}
            </p>
            {inp.camera_error && <p className="dev-cam-error">CAMERA: {inp.camera_error}</p>}
            {!mobile && inp.speech_error && <p className="dev-cam-error">SPEECH: {inp.speech_error}</p>}
            {mobile && inp.transcription_error && <p className="dev-cam-error">RECORDER / TRANSCRIPTION: {inp.transcription_error}</p>}
          </Card>

          <Card title="Output device · iPad /output (LED)">
            <p className="dev-cam-status">
              CONNECTED: last poll {age(now, s.output_last_poll)}
              <br />
              LED: <On on={s.led_active}>{s.led_active ? (s.led_arrived ? "ACTIVE · ARRIVING (held)" : "ACTIVE") : "BLANK"}</On>
              {s.led_mock ? ` · MOCK${s.mock_seconds_per_min ? ` (${s.mock_seconds_per_min} s / min)` : " (static)"}` : ""}
              <br />
              ROUTE: {s.route ?? "—"} · ETA: {s.eta_minutes == null ? "—" : s.eta_minutes < 1 ? "ARRIVING" : `${s.eta_minutes} MIN`} · ETA SOURCE:{" "}
              {s.eta_source ?? "—"}
              <br />
              TRIP: {s.trip_id ?? "—"} · ORIGIN: {s.origin_stop ?? "—"} · DEST STOP: {s.destination_stop ?? "—"}
              {s.destination_name ? ` (${s.destination_name})` : ""}
              <br />
              LED REFRESH: assigned {clock(s.led_assigned_at)} · last refresh {clock(s.led_refreshed_at)}
              {s.led_active && !s.led_mock && !s.led_arrived ? " · every 10 s (backend)" : ""}
            </p>
            {s.led_refresh_error && <p className="dev-cam-error">LED refresh failed (last ETA kept): {s.led_refresh_error}</p>}
          </Card>

          <Card title="Summary">
            <p className="dev-cam-status">
              RAW TRANSCRIPT: {s.raw_transcript ? <On on>“{s.raw_transcript}”</On> : inp.transcript ? `“${inp.transcript}” (input)` : "—"}
              <br />
              LOCAL HINT: {s.local_hint ? `“${s.local_hint}”` : "—"}
              <br />
              AI INTERPRETATION: {s.interpreted_destination ?? "—"}
              <br />
              AI CONFIDENCE: {s.interpretation?.ai_confidence != null ? s.interpretation.ai_confidence.toFixed(2) : "—"} · FINAL:{" "}
              {s.interpretation?.confidence != null ? s.interpretation.confidence.toFixed(2) : "—"}
              <br />
              PLACE VERIFICATION: {s.interpretation?.verification?.status ?? "—"}
              <br />
              RESOLVED PLACE: {s.resolved_place ?? "—"}
              <br />
              RESOLVED ADDRESS: {s.resolved_address ?? "—"}
              <br />
              WALKING RESULT:{" "}
              {s.routing?.walking
                ? `${s.routing.walking.minutes ?? "—"} min · ${s.routing.walking.distance_m ?? "—"} m · ${s.routing.walking.walkable ? "WALKABLE (≤10 min)" : "not walkable"}`
                : "—"}
              <br />
              ROUTING RESULT: <On on={s.routing?.status === "ok"}>{s.routing?.status?.toUpperCase() ?? "—"}</On>
              <br />
              DIRECTION: {direction(s)}
              <br />
              ROUTE: {s.routing?.selected_route ?? s.routing?.route ?? "—"} · ETA:{" "}
              {s.routing?.eta_minutes != null ? `${s.routing.eta_minutes} min` : "—"} · ETA SOURCE: {s.routing?.eta_source ?? "—"}
            </p>
          </Card>

          <Card title="AI destination recovery" wide>
            <AiResult interpretation={interpretationOf(s)} />
          </Card>

          <Card title="Walking + Route 21 routing" wide>
            <RoutingResult routing={routingOf(s)} />
          </Card>

          <Card title={`Errors (${s.errors.length})`} wide>
            {s.errors.length === 0 ? (
              <p className="dev-cam-status">none</p>
            ) : (
              s.errors.map((e, i) => (
                <p key={i} className="dev-cam-error">
                  {clock(e.at)} · {e.source}: {e.message}
                </p>
              ))
            )}
          </Card>
        </div>
      )}
    </main>
  );
}
