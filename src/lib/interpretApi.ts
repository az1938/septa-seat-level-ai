import type { DestinationResult } from "../state/interactionMachine";

// Frontend client for the backend AI endpoint. The API key lives only on the
// server (server/.env); the browser just sends the transcript text.

export class InterpretError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function interpretDestination(
  transcript: string,
  signal?: AbortSignal
): Promise<DestinationResult> {
  let res: Response;
  try {
    res = await fetch("/api/interpret-destination", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new InterpretError("backend_unreachable", "AI backend not reachable — is server/app.py running on :8788?");
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON (e.g. Vite proxy error page) */
  }

  if (!res.ok || !body || body.status === "error") {
    if (!body && (res.status === 502 || res.status === 504 || res.status === 500))
      throw new InterpretError("backend_unreachable", "AI backend not reachable — is server/app.py running on :8788?");
    throw new InterpretError(body?.error_code ?? `http_${res.status}`, body?.error ?? `HTTP ${res.status}`);
  }
  return body as DestinationResult;
}
