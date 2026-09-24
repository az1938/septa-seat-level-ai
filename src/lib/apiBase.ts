// Where the backend (server/app.py) lives.
//
//   Local dev (npm run dev):  VITE_API_BASE_URL unset → relative "/api/…",
//                             which Vite proxies to http://localhost:8788.
//   Production build:         VITE_API_BASE_URL = e.g. "https://my-backend.example.com"
//                             (no trailing slash) → "https://my-backend.example.com/api/…".
//                             If it is unset, requests stay relative and will fail on
//                             GitHub Pages (static hosting has no /api) — the prototype
//                             shows the error in the DEV panel and manual controls still work.
//
// Never put API keys here: VITE_* variables are baked into the public JS bundle.

export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

/** apiUrl("/api/eta?route=21") → "<API_BASE_URL>/api/eta?route=21" */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
