import { useEffect, useRef, useState } from "react";

// Polls `fetcher` every `intervalMs` (one request at a time; a slow request is
// aborted when the next tick is due). Keeps the last good value on errors.
export interface Poll<T> {
  data: T | null;
  error: string | null;
  lastOkAt: number | null; // Date.now() of the last successful response
}

export function usePoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number): Poll<T> {
  const [state, setState] = useState<Poll<T>>({ data: null, error: null, lastOkAt: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let stopped = false;
    let inFlight: AbortController | null = null;
    let timer: number | undefined;

    const tick = async () => {
      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timeout = window.setTimeout(() => ctrl.abort(), Math.max(intervalMs * 3, 3000));
      try {
        const data = await fetcherRef.current(ctrl.signal);
        if (!stopped) setState({ data, error: null, lastOkAt: Date.now() });
      } catch (e) {
        if (!stopped) {
          const msg = (e as Error).name === "AbortError" ? "request timed out" : (e as Error).message || String(e);
          setState((s) => ({ ...s, error: msg }));
        }
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      inFlight?.abort();
    };
  }, [intervalMs]);

  return state;
}
