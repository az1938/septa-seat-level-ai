import type { CSSProperties, ReactElement } from "react";

/** Face expressions (see EXPRESSION_MASK). */
export type FaceMood =
  | "idle"
  | "personDetected"
  | "wrongDirection"
  | "listening"
  | "processing"
  | "recommendation"
  | "noDestination";

interface AiFaceProps {
  mood: FaceMood;
}

// Pixel face built from EXACT fixed masks on an 11-column × 7-row grid.
//
//   HEAD_MASK         — fixed silhouette, identical in every state.
//                       "X" = a face pixel exists; "." = nothing is rendered.
//   EXPRESSION_MASK   — one per state, same 11×7 size.
//                       "#" = lit mint/cyan
//                       "G" = lit green (listening side-indicator override)
//                       "." = unlit (dark gray, if inside the head)

const COLS = 11;
const ROWS = 7;

const HEAD_MASK = [
  "...XXXXX...", // row 1 — 5
  "..XXXXXXX..", // row 2 — 7
  ".XXXXXXXXX.", // row 3 — 9
  "XXXXXXXXXXX", // row 4 — 11
  "XXXXXXXXXXX", // row 5 — 11
  ".XXXXXXXXX.", // row 6 — 9
  "..XXXXXXX..", // row 7 — 7
];

const BLANK = "...........";

// Exact pixel coordinates (R = row 1–7, C = column 1–11). Columns in each string
// are C1…C11 left→right. "#" = mint/cyan, "G" = green (listening side-indicator
// color override), "." = unlit (dark gray inside the head).
const EXPRESSION_MASK: Record<FaceMood, string[]> = {
  // NORMAL / IDLE — R4: C4, C8 · R5: C4, C8
  idle: [BLANK, BLANK, BLANK, "...#...#...", "...#...#...", BLANK, BLANK],

  // PERSON DETECTED — same pixels as IDLE for now (kept as its own entry)
  personDetected: [BLANK, BLANK, BLANK, "...#...#...", "...#...#...", BLANK, BLANK],

  // WRONG DIRECTION — R4: C3, C4, C5, C7, C8, C9
  wrongDirection: [BLANK, BLANK, BLANK, "..###.###..", BLANK, BLANK, BLANK],

  // LISTENING — cyan R4: C3, C5, C7, C9 · R5: C4, C8 · green R4/R5: C1, C11
  listening: [BLANK, BLANK, BLANK, "G.#.#.#.#.G", "G..#...#..G", BLANK, BLANK],

  // LOADING / PROCESSING — R4: C3, C5, C7, C9 · R5: C4, C8
  processing: [BLANK, BLANK, BLANK, "..#.#.#.#..", "...#...#...", BLANK, BLANK],

  // RESULT / RECOMMENDATION — R4: C4, C8 · R5: C3, C5, C7, C9
  recommendation: [BLANK, BLANK, BLANK, "...#...#...", "..#.#.#.#..", BLANK, BLANK],

  // NO DESTINATION / DID NOT UNDERSTAND — R4: C3, C4, C5, C7, C8, C9 · R5: C4, C8 · R6: C4, C8
  noDestination: [BLANK, BLANK, BLANK, "..###.###..", "...#...#...", "...#...#...", BLANK],
};

// Colors
const INACTIVE = "#2a2e35"; // dark gray
const COLOR: Record<string, string> = {
  "#": "var(--face)", // current mint/cyan accent
  G: "#2ee66b", // listening side-indicator green
};

// Pixel geometry (grid units): equal squares with a small, even gap.
const GAP = 0.2;
const SIZE = 1 - GAP;

// The viewBox adds 2 empty rows above and below (nothing is drawn there) so the
// face keeps the same square footprint on the panel and stays centered.
const PAD_Y = (COLS - ROWS) / 2;

export function AiFace({ mood }: AiFaceProps) {
  const expr = EXPRESSION_MASK[mood];
  const cells: ReactElement[] = [];
  const litCells: ReactElement[] = [];

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (HEAD_MASK[y][x] !== "X") continue; // outside the head: render nothing
      const litColor = COLOR[expr[y][x]];
      (litColor ? litCells : cells).push(
        <rect
          key={`${x},${y}`}
          x={x + GAP / 2}
          y={y + GAP / 2}
          width={SIZE}
          height={SIZE}
          rx={SIZE * 0.12}
          className="dot"
          style={{ fill: litColor ?? INACTIVE } as CSSProperties}
        />
      );
    }
  }

  return (
    <svg
      viewBox={`0 ${-PAD_Y} ${COLS} ${COLS}`}
      className="dot-matrix ai-face"
      // glow only the lit pixels (not the gray head), so no page-level filter here
      style={{ filter: "none" }}
      aria-hidden="true"
    >
      <defs>
        <filter id="ai-face-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.12" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {cells}
      <g filter="url(#ai-face-glow)">{litCells}</g>
    </svg>
  );
}
