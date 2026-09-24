import { useCallback, useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// useSpeechCapture — one spoken destination phrase → transcript string.
//
// Browser Web Speech API (SpeechRecognition / webkitSpeechRecognition),
// lang en-US, continuous = false, interimResults = true.
//
// Lifecycle (duplicate-safe):
//   • Recognition runs only while `active` is true, and is keyed on
//     `sessionKey` (the timestamp of this LISTENING entry). Re-renders don't
//     change either value, so the effect doesn't re-run → exactly one instance.
//   • Start is deferred by START_DELAY_MS; the effect cleanup cancels that
//     timer, so React StrictMode's mount→unmount→mount never starts two.
//   • The single live instance is kept in a ref; cleanup (leaving LISTENING,
//     Reset, unmount) calls abort() on it and ignores its late events.
//
// Silence: if an attempt ends with no words (silence / "no-speech"), it calls
// onNoSpeech() — the app then speaks the retry prompt and re-enters LISTENING
// (see RETRY_NEEDED in interactionMachine.ts). Real errors (mic denied, no mic,
// other recognition errors) do NOT auto-retry; the DEV controller can "Listen again".
//
// Privacy: no audio is recorded or saved by this app. Only the transcript
// string is kept, in memory, for the current interaction. (Note: in Chrome,
// the browser's own speech service processes the audio to produce the text.)
// ─────────────────────────────────────────────────────────────────────────────

// Minimal typings — the Web Speech recognition API isn't in TS's DOM lib.
interface RecAlternative { transcript: string }
interface RecResult { isFinal: boolean; 0: RecAlternative; length: number }
interface RecResultEvent { resultIndex: number; results: { length: number; [i: number]: RecResult } }
interface RecErrorEvent { error: string; message?: string }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecResultEvent) => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | null =
  typeof window === "undefined"
    ? null
    : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

const LANG = "en-US";
const START_DELAY_MS = 250; // small gap after the spoken prompt ends
const MAX_ATTEMPTS = 1; // silence is handled by the app's spoken retry prompt

export type MicStatus = "unknown" | "listening" | "granted" | "denied" | "no-microphone";

export interface SpeechCapture {
  supported: boolean;
  micStatus: MicStatus;
  /** true while an attempt is actively running */
  listening: boolean;
  /** live partial words (DEV display only) */
  interim: string;
  /** which attempt is running (1 or 2), 0 when idle */
  attempt: number;
  /** DEV-facing error / status message */
  error: string | null;
  /** DEV: start listening again after the automatic retry was used up */
  retry: () => void;
}

export function useSpeechCapture(opts: {
  active: boolean;
  sessionKey: number;
  onFinal: (transcript: string) => void;
  onNoSpeech?: () => void;
}): SpeechCapture {
  const { active, sessionKey } = opts;
  const onFinalRef = useRef(opts.onFinal);
  onFinalRef.current = opts.onFinal;
  const onNoSpeechRef = useRef(opts.onNoSpeech);
  onNoSpeechRef.current = opts.onNoSpeech;

  const [micStatus, setMicStatus] = useState<MicStatus>("unknown");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((n) => n + 1), []);

  const instanceRef = useRef<Recognition | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!Ctor) {
      setError("SpeechRecognition not supported in this browser (use Chrome or Edge)");
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    setError(null);
    setInterim("");

    const run = (n: number) => {
      if (cancelled) return;
      const rec = new Ctor();
      instanceRef.current = rec;
      rec.lang = LANG;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let finalText = "";
      let lastInterim = "";
      let lastError: string | null = null;

      rec.onaudiostart = () => {
        if (!cancelled) setMicStatus("granted");
      };
      rec.onresult = (e) => {
        if (cancelled) return;
        let partial = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else partial += r[0].transcript;
        }
        lastInterim = partial;
        setInterim(partial || finalText);
      };
      rec.onerror = (e) => {
        lastError = e.error;
      };
      rec.onend = () => {
        if (instanceRef.current === rec) instanceRef.current = null;
        if (cancelled) return;
        setListening(false);

        const text = (finalText || lastInterim).trim();
        if (text) {
          setAttempt(0);
          onFinalRef.current(text);
          return;
        }
        if (lastError === "not-allowed" || lastError === "service-not-allowed") {
          setMicStatus("denied");
          setError("Microphone permission denied");
          setAttempt(0);
          return;
        }
        if (lastError === "audio-capture") {
          setMicStatus("no-microphone");
          setError("No microphone found");
          setAttempt(0);
          return;
        }
        if (lastError && lastError !== "no-speech" && lastError !== "aborted") {
          setError(`Recognition error: ${lastError}`);
        }
        // silence / nothing recognized → (internal retry only if MAX_ATTEMPTS > 1)
        if (n < MAX_ATTEMPTS) {
          setError(lastError === "no-speech" || !lastError ? "No speech heard — listening again…" : null);
          run(n + 1);
        } else {
          setAttempt(0);
          if (lastError && lastError !== "no-speech" && lastError !== "aborted") return; // real error: no auto-retry
          setError("No speech heard");
          onNoSpeechRef.current?.();
        }
      };

      try {
        rec.start();
        setListening(true);
        setAttempt(n);
        setMicStatus((m) => (m === "granted" ? m : "listening"));
      } catch (err) {
        setError(`Could not start recognition: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    timer = window.setTimeout(() => run(1), START_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      const rec = instanceRef.current;
      instanceRef.current = null;
      if (rec) {
        rec.onresult = rec.onerror = rec.onend = rec.onaudiostart = null;
        try {
          rec.abort();
        } catch {
          /* already stopped */
        }
      }
      setListening(false);
      setAttempt(0);
      setInterim("");
    };
  }, [active, sessionKey, retryToken]);

  return { supported: !!Ctor, micStatus, listening, interim, attempt, error, retry };
}
