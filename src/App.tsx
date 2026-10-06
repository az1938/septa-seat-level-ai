import { useEffect, useState } from "react";
import { InputPage } from "./pages/InputPage";
import { InputMobilePage } from "./pages/InputMobilePage";
import { OutputPage } from "./pages/OutputPage";
import { MonitorPage } from "./pages/MonitorPage";

// ─────────────────────────────────────────────────────────────────────────────
// Three synchronized interfaces for the on-site bus-stop test:
//   /monitor        laptop  — researcher monitoring + controls
//   /input-desktop  laptop / desktop Chrome — rider AI conversation, browser
//                   SpeechRecognition (the original /input; /input still works)
//   /input-mobile   iPhone / iPad Safari — same conversation, speech via
//                   MediaRecorder → /api/transcribe
//   /output         iPad    — seat-level LED
// They share ONE backend session (server/session_store.py), kept in sync by polling.
//
// Lightweight route switch (no router dependency):
//   • hash routes  #/monitor  #/input-desktop  #/input-mobile  #/output — used on
//     GitHub Pages (static hosting can't serve /monitor directly, but a #fragment
//     always loads index.html)
//   • path routes  /monitor  /input-desktop  /input-mobile  /output — work locally
//     (Vite serves index.html for every path)
// ─────────────────────────────────────────────────────────────────────────────

type Page = "monitor" | "input-desktop" | "input-mobile" | "output" | "home";
const PAGES: string[] = ["monitor", "input-desktop", "input-mobile", "output", "input"];
/** "/input" (earlier URL) keeps opening the desktop input */
const alias = (p: string): Page => (p === "input" ? "input-desktop" : (p as Page));

function currentPage(): Page {
  const fromHash = window.location.hash.replace(/^#\/?/, "").split(/[/?#]/)[0].toLowerCase();
  if (PAGES.includes(fromHash)) return alias(fromHash);
  const base = import.meta.env.BASE_URL; // "/" locally, "/septa-seat-level-ai/" in production
  let path = window.location.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  const seg = path.replace(/^\/+/, "").split("/")[0].toLowerCase();
  return PAGES.includes(seg) ? alias(seg) : "home";
}

function Home() {
  const base = import.meta.env.BASE_URL;
  return (
    <main className="page-home">
      <h1>Seat-Level ETA · bus-stop test</h1>
      <ul>
        <li>
          <a href={`${base}#/monitor`}>Monitor</a> — laptop, researcher only
        </li>
        <li>
          <a href={`${base}#/input-desktop`}>Input · desktop</a> — browser speech recognition (Chrome)
        </li>
        <li>
          <a href={`${base}#/input-mobile`}>Input · mobile</a> — iPhone / iPad Safari (recorder + transcription)
        </li>
        <li>
          <a href={`${base}#/output`}>Output</a> — iPad at the seat (LED)
        </li>
      </ul>
    </main>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  useEffect(() => {
    const update = () => setPage(currentPage());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  useEffect(() => {
    document.title =
      page === "home" ? "Seat-Level ETA" : `Seat-Level ETA · ${page[0].toUpperCase()}${page.slice(1)}`;
    // both input pages share the rider-panel page styles ("input")
    document.documentElement.dataset.page = page.startsWith("input") ? "input" : page;
  }, [page]);

  if (page === "monitor") return <MonitorPage />;
  if (page === "input-desktop") return <InputPage />;
  if (page === "input-mobile") return <InputMobilePage />;
  if (page === "output") return <OutputPage />;
  return <Home />;
}
