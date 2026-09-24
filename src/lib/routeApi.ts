import type { DestinationResult, RouteResult } from "../state/interactionMachine";
import { apiUrl } from "./apiBase";

// Frontend client for POST /api/recommend-route (static GTFS + live SEPTA on
// the backend). The AI is not involved here — it only supplied the destination.

export class RouteError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function recommendRoute(dest: DestinationResult, signal?: AbortSignal): Promise<RouteResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/recommend-route"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination_text: dest.destination_text,
        intersection_or_address: dest.intersection_or_address,
        place_name: dest.place_name,
        destination_type: dest.destination_type,
      }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new RouteError("backend_unreachable", "Backend not reachable — is server/app.py running on :8788?");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !body || body.status === "error") {
    throw new RouteError(body?.error_code ?? `http_${res.status}`, body?.error ?? `HTTP ${res.status}`);
  }
  return body as RouteResult;
}
