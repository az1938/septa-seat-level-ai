import { useEffect, useRef } from "react";
import type { PersonDetection } from "../hooks/usePersonDetection";

// DEV-ONLY camera preview. Shows the live feed (mirrored, not recorded) and
// the detector status so person detection can be verified during development.
// Remove or hide for the final prototype.
export function CameraPreview({ detection }: { detection: PersonDetection }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = detection.stream;
    if (detection.stream) v.play().catch(() => {});
  }, [detection.stream]);

  const camera =
    detection.cameraStatus === "ready" ? "READY" : detection.cameraStatus === "error" ? "ERROR" : "STARTING…";
  const model =
    detection.modelStatus === "ready"
      ? "READY"
      : detection.modelStatus === "loading"
      ? "LOADING…"
      : detection.modelStatus === "error"
      ? "ERROR"
      : "—";
  const person = !detection.cameraReady
    ? "—"
    : detection.personPresent
    ? "DETECTED"
    : detection.rawDetected
    ? "CONFIRMING…"
    : "NONE";

  return (
    <div className="dev-cam">
      <div className="dev-cam-video" data-person={detection.personPresent}>
        <video ref={videoRef} muted playsInline />
        {!detection.stream && <span className="dev-cam-empty">no camera</span>}
      </div>
      <p className="dev-cam-status">
        CAMERA: {camera} · MODEL: {model}
        <br />
        PERSON: <strong data-on={detection.personPresent}>{person}</strong>
        {detection.score !== null && <span className="dev-cam-score"> ({detection.score.toFixed(1)})</span>}
      </p>
      {detection.error && <p className="dev-cam-error">{detection.error} — use manual controls.</p>}
    </div>
  );
}
