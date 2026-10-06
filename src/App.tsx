import { useEffect, useState } from "react";
import { InputPage } from "./pages/InputPage";
import { OutputPage } from "./pages/OutputPage";
import { MonitorPage } from "./pages/MonitorPage";

// ─────────────────────────────────────────────────────────────────────────────
// Three synchronized interfaces for the on-site bus-stop test:
//   /monitor  laptop  — researcher monitoring + controls
//   /input    iPhone  — rider-facing AI conversation
//   /output   iPad    — seat-level LED tile
// They share ONE backend session (server/session_store.py), kept in sync by polling.
//
// Lightweight route switch (no router dependency):
//   • hash routes  #/monitor  #/input  #/output   — used on GitHub Pages (static
//     hosting can't serve /monitor directly, but a #fragment always loads index.html)
//   • path routes  /monitor  /input  /output      — work locally (Vite serves
//     index.html for every path)
// ─────────────────────────────────────────────────────────────────────────────

type Page = "monitor" | "input" | "output" | "home";
const PAGES: Page[] = ["monitor", "input", "output"];

function currentPage(): Page {
  const fromHash = window.location.hash.replace(/^#\/?/, "").split(/[/?#]/)[0].toLowerCase();
  if ((PAGES as string[]).includes(fromHash)) return fromHash as Page;
  const base = import.meta.env.BASE_URL; // "/" locally, "/septa-seat-level-ai/" in production
  let path = window.location.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  const seg = path.replace(/^\/+/, "").split("/")[0].toLowerCase();
  return (PAGES as string[]).includes(seg) ? (seg as Page) : "home";
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
          <a href={`${base}#/input`}>Input</a> — iPhone on the bus-stop wall (rider)
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
    document.documentElement.dataset.page = page;
  }, [page]);

  if (page === "monitor") return <MonitorPage />;
  if (page === "input") return <InputPage />;
  if (page === "output") return <OutputPage />;
  return <Home />;
}
