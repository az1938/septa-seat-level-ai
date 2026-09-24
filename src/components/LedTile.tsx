import { useMemo, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Recommendation } from "../state/interactionMachine";
import { LED_COLOR, etaLabel, ledBucketForMinutes } from "../lib/led";
import { BIG, SMALL, glyphs, textWidth } from "../lib/pixelFont";
import { DotMatrix, stamp, type PixelSet } from "./DotMatrix";

// FRAME 2 — seat-level LED tile.
// Dark/blank until it receives a recommendation, then shows ROUTE + ETA
// in the color for that ETA band. It only knows about `recommendation`,
// so later it can keep updating from live SEPTA polling independently of
// what the AI panel is showing.
//
// Rendered as a real 32×32 LED matrix (same DotMatrix as the AI face):
//   route number — 5×7 pixel digits at 2× (each font pixel = 2×2 LEDs)
//   ETA line     — 3×5 pixel font at 1×  ("6 MIN", "ARRIVING")
const GRID = 32;
const ROUTE_SCALE = 2;
const LINE_GAP = 3; // blank LED rows between route and ETA

function writeText(
  set: PixelSet,
  font: Record<string, string[]>,
  text: string,
  y: number,
  scale: number
) {
  const w = textWidth(font, text) * scale;
  let x = Math.floor((GRID - w) / 2);
  for (const g of glyphs(font, text)) {
    stamp(set, g, x, y, scale);
    x += ((g[0]?.length ?? 0) + 1) * scale;
  }
}

function buildTile(rec: Recommendation): PixelSet {
  const s: PixelSet = new Set();
  const routeH = 7 * ROUTE_SCALE;
  const etaH = 5;
  const top = Math.floor((GRID - (routeH + LINE_GAP + etaH)) / 2);
  writeText(s, BIG, rec.route, top, ROUTE_SCALE);
  writeText(s, SMALL, etaLabel(rec.etaMinutes), top + routeH + LINE_GAP, 1);
  return s;
}

const EMPTY: PixelSet = new Set();

export function LedTile({ recommendation }: { recommendation: Recommendation | null }) {
  const color = recommendation ? LED_COLOR[ledBucketForMinutes(recommendation.etaMinutes)] : null;
  const lit = useMemo(() => (recommendation ? buildTile(recommendation) : EMPTY), [recommendation]);

  return (
    <div
      className="led-tile"
      data-lit={!!recommendation}
      style={color ? ({ "--led": color } as CSSProperties) : undefined}
    >
      {/* base layer: the dark, unlit LED grid (always visible) */}
      <DotMatrix cols={GRID} rows={GRID} lit={EMPTY} color="transparent" className="led-matrix" />

      {/* lit layer: route + ETA, powers on/off with the same entrance as before */}
      <AnimatePresence>
        {recommendation && color && (
          <motion.div
            key="lit"
            className="led-content"
            initial={{ opacity: 0, filter: "brightness(2.2)" }}
            animate={{ opacity: 1, filter: "brightness(1)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <DotMatrix
              cols={GRID}
              rows={GRID}
              lit={lit}
              color={color}
              litOnly
              className="led-matrix led-matrix-lit"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
