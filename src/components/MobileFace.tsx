import type { CSSProperties } from "react";
import { COLOR, COLS, EXPRESSION_MASK, HEAD_MASK, INACTIVE, ROWS, type FaceMood } from "./AiFace";

// ─────────────────────────────────────────────────────────────────────────────
// Pixel face for /input-mobile (iPhone / iPad Safari).
//
// Same EXACT masks as the desktop AiFace (HEAD_MASK + EXPRESSION_MASK, imported,
// not copied) — only the rendering differs, to avoid iOS Safari SVG problems
// (an SVG with height:auto inside a flex column can collapse, and lit pixels
// inside an SVG filter group can disappear):
//   • a plain CSS grid of 11 × 7 square <span> cells, every cell always rendered;
//   • cells outside the head are transparent placeholders (keep the grid shape);
//   • inactive head pixels are always drawn in the same dark gray;
//   • lit pixels get a CSS box-shadow glow — no SVG filter, no transform scaling;
//   • the grid has an explicit aspect-ratio, so its height never collapses.
// ─────────────────────────────────────────────────────────────────────────────

export function MobileFace({ mood }: { mood: FaceMood }) {
  const expr = EXPRESSION_MASK[mood];
  const cells = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const inHead = HEAD_MASK[y][x] === "X";
      const lit = inHead ? COLOR[expr[y][x]] : undefined;
      cells.push(
        <span
          key={`${x},${y}`}
          className="mface-cell"
          data-head={inHead}
          data-lit={!!lit}
          style={inHead ? ({ "--cell": lit ?? INACTIVE } as CSSProperties) : undefined}
        />
      );
    }
  }
  return (
    // square footprint (like the desktop face's 11 × 11 viewBox), face centered in it
    <div className="mface" aria-hidden="true">
      <div className="mface-grid" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
        {cells}
      </div>
    </div>
  );
}
