import { useEffect, useState } from "react";
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";

// ─────────────────────────────────────────────────────────────────────────────
// usePersonDetection — binary "is a person in front of the camera?" signal.
//
// • Library: MediaPipe Tasks Vision — ObjectDetector with EfficientDet-Lite0
//   (COCO classes), filtered to the single category "person".
// • Runs entirely in the browser (WebAssembly / WebGL). Video frames are read
//   from an in-memory <video> element and passed straight to the detector.
//   No frame is drawn, saved, recorded or uploaded. No identity, face
//   recognition, age/gender, or tracking — only person yes/no.
// • The WASM runtime and the model file are downloaded once from public CDNs
//   (jsDelivr, Google Cloud Storage) and cached by the browser. Only those
//   static files are fetched; nothing is sent back.
//
// Debounce (so one noisy frame can't trigger the experience):
//   raw detection must stay TRUE  for CONFIRM_MS before personPresent → true
//   raw detection must stay FALSE for RELEASE_MS before personPresent → false
// ─────────────────────────────────────────────────────────────────────────────

const MP_VERSION = "0.10.14"; // keep in sync with package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

const DETECT_INTERVAL_MS = 100; // ~10 detections per second
const SCORE_THRESHOLD = 0.5; // minimum "person" confidence per frame
const CONFIRM_MS = 700; // continuous presence needed to confirm
const RELEASE_MS = 1000; // continuous absence needed to release

export type CameraStatus = "starting" | "ready" | "error";
export type ModelStatus = "waiting" | "loading" | "ready" | "error";

export interface PersonDetection {
  cameraStatus: CameraStatus;
  modelStatus: ModelStatus;
  /** camera running AND detector loaded */
  cameraReady: boolean;
  /** debounced presence — use this to drive the interaction */
  personPresent: boolean;
  /** raw per-frame result (dev display only) */
  rawDetected: boolean;
  /** best "person" score in the latest frame, rounded (dev display only) */
  score: number | null;
  /** live camera stream, for the dev preview only */
  stream: MediaStream | null;
  error: string | null;
}

function describeCameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found";
  if (name === "NotReadableError") return "Camera is in use by another app";
  return `Camera error: ${e instanceof Error ? e.message : String(e)}`;
}

async function createDetector(): Promise<ObjectDetector> {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO" as const,
    scoreThreshold: SCORE_THRESHOLD,
    categoryAllowlist: ["person"],
    maxResults: 3,
  });
  try {
    return await ObjectDetector.createFromOptions(vision, options("GPU"));
  } catch {
    return await ObjectDetector.createFromOptions(vision, options("CPU")); // fallback
  }
}

export function usePersonDetection(): PersonDetection {
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("starting");
  const [modelStatus, setModelStatus] = useState<ModelStatus>("waiting");
  const [personPresent, setPersonPresent] = useState(false);
  const [rawDetected, setRawDetected] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let media: MediaStream | null = null;
    let detector: ObjectDetector | null = null;
    let timer: number | undefined;

    // In-memory video element: never attached to the page, never recorded.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;

    // debounce bookkeeping
    let present = false;
    let trueSince: number | null = null;
    let falseSince: number | null = null;

    function tick() {
      if (cancelled || !detector) return;
      if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
        const now = performance.now();
        let best = 0;
        try {
          const result = detector.detectForVideo(video, now);
          for (const d of result.detections) {
            for (const c of d.categories) if (c.categoryName === "person") best = Math.max(best, c.score);
          }
        } catch {
          /* skip a bad frame */
        }
        const raw = best >= SCORE_THRESHOLD;

        if (raw) {
          falseSince = null;
          trueSince ??= now;
          if (!present && now - trueSince >= CONFIRM_MS) {
            present = true;
            setPersonPresent(true);
          }
        } else {
          trueSince = null;
          falseSince ??= now;
          if (present && now - falseSince >= RELEASE_MS) {
            present = false;
            setPersonPresent(false);
          }
        }
        setRawDetected(raw);
        setScore(raw ? Math.round(best * 10) / 10 : null); // coarse → fewer re-renders
      }
      timer = window.setTimeout(tick, DETECT_INTERVAL_MS);
    }

    async function start() {
      // 1. camera
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraStatus("error");
        setError("Camera API unavailable (open the page via http://localhost)");
        return;
      }
      try {
        media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 } },
          audio: false,
        });
      } catch (e) {
        if (!cancelled) {
          setCameraStatus("error");
          setError(describeCameraError(e));
        }
        return;
      }
      if (cancelled) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = media;
      await video.play().catch(() => {});
      setStream(media);
      setCameraStatus("ready");

      // 2. detector
      setModelStatus("loading");
      try {
        const d = await createDetector();
        if (cancelled) {
          d.close();
          return;
        }
        detector = d;
      } catch (e) {
        if (!cancelled) {
          setModelStatus("error");
          setError(`Person detector failed to load: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      setModelStatus("ready");
      tick();
    }

    start();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      detector?.close();
      media?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, []);

  return {
    cameraStatus,
    modelStatus,
    cameraReady: cameraStatus === "ready" && modelStatus === "ready",
    personPresent,
    rawDetected,
    score,
    stream,
    error,
  };
}
