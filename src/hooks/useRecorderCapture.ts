import { useEffect, useRef, useState } from "react";
import { TranscribeError, transcribeAudio } from "../lib/transcribeApi";

// ─────────────────────────────────────────────────────────────────────────────
// useRecorderCapture — /input-mobile's speech input (replaces browser
// SpeechRecognition, which is unreliable on iPhone Safari).
//
//   LISTENING entry → MediaRecorder records RECORD_MS of microphone audio
//   → POST /api/transcribe (OpenAI transcription on the server)
//   → onFinal(transcript)    — the page then runs the normal AI pipeline
//   → onNoSpeech()           — nothing usable was said (spoken retry prompt)
//   → onFailed(message)      — mic / recorder / upload / transcription error
//
// Same lifecycle rules as useSpeechCapture: runs only while `active`, keyed on
// `sessionKey` (one LISTENING entry), start deferred so React StrictMode never
// starts two, and everything is cancelled when the state is left (Reset).
// The microphone stream is opened once and reused for every rider (one iOS
// permission prompt); it is released when the page unmounts.
// Privacy: the clip is held in memory only for the upload; nothing is stored.
// ─────────────────────────────────────────────────────────────────────────────

const RECORD_MS = 5000; // ~4–6 s window for one spoken destination
const START_DELAY_MS = 250; // small gap after the spoken prompt ends
const MIN_BYTES = 800; // smaller than this = no real audio captured
const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
// Transcribers sometimes "hear" these in silence / noise → treat as no speech.
const NON_SPEECH = new Set(["", "you", "thank you", "thanks", "thank you for watching", "thanks for watching", "bye", "uh", "um", "hmm", "mm"]);

export type RecorderStatus = "unsupported" | "idle" | "requesting" | "recording" | "stopped" | "error";
export type UploadStatus = "idle" | "uploading" | "done" | "failed";

export interface RecorderCapture {
  supported: boolean;
  recorderStatus: RecorderStatus;
  micStatus: "unknown" | "granted" | "denied" | "no-microphone" | "error";
  mime: string | null;
  uploadStatus: UploadStatus;
  /** true while the clip is uploading / being transcribed (the page shows PROCESSING) */
  uploading: boolean;
  transcript: string | null;
  transcriptionModel: string | null;
  transcriptionMs: number | null;
  error: string | null;
}

const supported =
  typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

function pickMime(): string | null {
  const MR = (window as any).MediaRecorder;
  if (!MR?.isTypeSupported) return null;
  return MIME_CANDIDATES.find((m) => MR.isTypeSupported(m)) ?? null;
}

function isNonSpeech(text: string) {
  return NON_SPEECH.has(text.toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim());
}

export function useRecorderCapture(opts: {
  active: boolean;
  sessionKey: number;
  onFinal: (transcript: string) => void;
  onNoSpeech: () => void;
  onFailed: (message: string) => void;
}): RecorderCapture {
  const { active, sessionKey } = opts;
  const cbRef = useRef(opts);
  cbRef.current = opts;
  const streamRef = useRef<MediaStream | null>(null);

  const [state, setState] = useState<RecorderCapture>({
    supported,
    recorderStatus: supported ? "idle" : "unsupported",
    micStatus: "unknown",
    mime: null,
    uploadStatus: "idle",
    uploading: false,
    transcript: null,
    transcriptionModel: null,
    transcriptionMs: null,
    error: supported ? null : "MediaRecorder / getUserMedia not available in this browser",
  });
  const set = (patch: Partial<RecorderCapture>) => setState((s) => ({ ...s, ...patch }));

  // release the microphone when the page goes away
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!active || !supported) return;
    let cancelled = false;
    let recorder: MediaRecorder | null = null;
    let stopTimer: number | undefined;
    const upload = new AbortController();

    const getStream = async () => {
      const live = streamRef.current?.getAudioTracks().some((t) => t.readyState === "live");
      if (live) return streamRef.current!;
      set({ recorderStatus: "requesting" });
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      streamRef.current = s;
      return s;
    };

    const fail = (message: string, patch: Partial<RecorderCapture> = {}) => {
      if (cancelled) return;
      set({ error: message, ...patch });
      cbRef.current.onFailed(message);
    };

    const start = async () => {
      let stream: MediaStream;
      try {
        stream = await getStream();
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        const mic = name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "no-microphone" : "error";
        return fail(`Microphone: ${name || (e as Error).message}`, { recorderStatus: "error", micStatus: mic });
      }
      if (cancelled) return;
      const mime = pickMime();
      try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch (e) {
        return fail(`MediaRecorder: ${(e as Error).message}`, { recorderStatus: "error", micStatus: "granted" });
      }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onerror = (ev: any) => fail(`MediaRecorder error: ${ev?.error?.name ?? "unknown"}`, { recorderStatus: "error" });
      recorder.onstop = async () => {
        if (cancelled) return;
        const type = recorder?.mimeType || mime || "audio/webm";
        const blob = new Blob(chunks, { type });
        set({ recorderStatus: "stopped", mime: type });
        if (blob.size < MIN_BYTES) {
          set({ uploadStatus: "idle", transcript: "" });
          return cbRef.current.onNoSpeech();
        }
        set({ uploadStatus: "uploading", uploading: true, error: null });
        try {
          const t = await transcribeAudio(blob, upload.signal);
          if (cancelled) return;
          const text = t.transcript.trim();
          set({ uploadStatus: "done", uploading: false, transcript: text, transcriptionModel: t.model, transcriptionMs: t.ms });
          if (isNonSpeech(text)) cbRef.current.onNoSpeech();
          else cbRef.current.onFinal(text);
        } catch (e) {
          if (cancelled || (e as Error).name === "AbortError") return;
          const msg = e instanceof TranscribeError ? `${e.code}: ${e.message}` : (e as Error).message;
          fail(`Transcription: ${msg}`, { uploadStatus: "failed", uploading: false });
        }
      };
      recorder.start();
      set({ recorderStatus: "recording", micStatus: "granted", mime: recorder.mimeType || mime, uploadStatus: "idle", transcript: null, error: null });
      stopTimer = window.setTimeout(() => {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }, RECORD_MS);
    };

    const startTimer = window.setTimeout(start, START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(stopTimer);
      upload.abort();
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
      setState((s) => ({
        ...s,
        uploading: false,
        recorderStatus: s.recorderStatus === "recording" ? "stopped" : s.recorderStatus,
        uploadStatus: s.uploadStatus === "uploading" ? "idle" : s.uploadStatus,
      }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionKey]);

  return state;
}
