import type { CSSProperties } from "react";

// Shared dot-matrix renderer used by BOTH frames (AI face + LED tile), so they
// read as the same hardware family. Every cell is always drawn: unlit cells
// are faint dots, lit cells glow in `color`. Changing which cells are lit
// cross-fades per dot (CSS), like a real LED panel refreshing.

export type PixelSet = Set<string>; // keys: "x,y"

export const px = (x: number, y: number) => `${x},${y}`;

interface DotMatrixProps {
  cols: number;
  rows: number;
  lit: PixelSet;
  color: string; // any CSS color, incl. var(--face)
  className?: string;
  /** 0–1: fraction of each cell taken by the gap between dots */
  gap?: number;
  /** corner radius of each dot, as a fraction of the dot size */
  round?: number;
  /** draw only lit dots (for an overlay layer above a dark base matrix) */
  litOnly?: boolean;
}

export function DotMatrix({
  cols,
  rows,
  lit,
  color,
  className,
  gap = 0.22,
  round = 0.18,
  litOnly = false,
}: DotMatrixProps) {
  const size = 1 - gap;
  const off = gap / 2;
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (litOnly && !lit.has(px(x, y))) continue;
      cells.push(
        <rect
          key={px(x, y)}
          x={x + off}
          y={y + off}
          width={size}
          height={size}
          rx={size * round}
          className={lit.has(px(x, y)) ? "dot on" : "dot"}
        />
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      className={`dot-matrix ${className ?? ""}`}
      style={{ "--dot-on": color } as CSSProperties}
      aria-hidden="true"
    >
      {cells}
    </svg>
  );
}

/** Stamp a bitmap (rows of "#"/".") into a PixelSet at (x0, y0), optionally scaled. */
export function stamp(set: PixelSet, bitmap: string[], x0: number, y0: number, scale = 1) {
  bitmap.forEach((row, by) => {
    [...row].forEach((ch, bx) => {
      if (ch !== "#") return;
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) set.add(px(x0 + bx * scale + sx, y0 + by * scale + sy));
    });
  });
}
