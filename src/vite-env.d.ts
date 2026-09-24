/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production backend origin, e.g. "https://api.example.com" (no trailing slash). Unset in dev. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
