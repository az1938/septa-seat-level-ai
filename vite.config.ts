import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Week 3 refined prototype.
// Dev:   http://localhost:5174 (the old Prototype 1 frontend uses 5173), base "/".
//        /api is proxied to this project's own backend (server/app.py, port 8788).
// Build: base "/septa-seat-level-ai/" for GitHub Pages
//        (https://az1938.github.io/septa-seat-level-ai/). The backend URL for
//        production comes from VITE_API_BASE_URL (see src/lib/apiBase.ts).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/septa-seat-level-ai/" : "/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
}));
