import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Week 3 refined prototype.
// Runs on port 5174 so it never collides with the old Prototype 1 frontend (5173).
// /api is proxied to this project's own backend (server/app.py, port 8788).
// The old Prototype 1 backend (port 8787) is left untouched.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
