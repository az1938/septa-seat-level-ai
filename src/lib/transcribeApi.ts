import { apiUrl } from "./apiBase";

// Client for POST /api/transcribe (server/app.py): a short audio clip →
// OpenAI transcription on the server (the API key never reaches the browser).

export class TranscribeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface Transcription {
  transcript: string;
  model: string;
  ms: number;
}

const EXT: Record<string, string> = { "audio/mp4": "m4a", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav" };

export async function transcribeAudio(blob: Blob, signal?: AbortSignal): Promise<Transcription> {
  const type = (blob.type || "audio/webm").split(";")[0];
  const form = new FormData();
  form.append("audio", blob, `speech.${EXT[type] ?? "webm"}`);
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/transcribe"), { method: "POST", body: form, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new TranscribeError("backend_unreachable", "Transcription backend not reachable");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !body || body.status !== "ok") {
    throw new TranscribeError(body?.error_code ?? `http_${res.status}`, body?.error ?? `HTTP ${res.status}`);
  }
  return { transcript: String(body.transcript ?? ""), model: String(body.model ?? ""), ms: Number(body.ms ?? 0) };
}
