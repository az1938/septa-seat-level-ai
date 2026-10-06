import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Recommendation } from "../state/interactionMachine";
import { LED_COLOR, etaLabel, ledBucketForMinutes } from "../lib/led";
import { BIG, SMALL, glyphs, textWidth } from "../lib/pixelFont";
import { DotMatrix, stamp, type PixelSet } from "./DotMatrix";

// ─────────────────────────────────────────────────────────────────────────────
// Full-screen seat-level LED (/output on the iPad): the whole viewport IS the
// LED panel. Same dot-matrix renderer, pixel fonts, colors and ARRIVING label as
// the original 32×32 tile (LedTile) — only the grid size adapts to the screen:
//
//   • the dot pitch is chosen so the widest ETA ("ARRIVING") fits at 2× and
//     the route at 3×, then the grid fills the whole viewport (any aspect ratio);
//   • the route / ETA scales then grow as large as the grid allows;
//   • unlit dots cover the entire screen, so idle = a dark, blank LED panel.
// ─────────────────────────────────────────────────────────────────────────────

const MARGIN = 3; // unlit dots kept around the content
const MIN_ROUTE_SCALE = 3;
const MIN_ETA_SCALE = 2;
const ROUTE_W = textWidth(BIG, "88"); // widest 2-digit route
const ROUTE_H = 7;
const ETA_W = Math.max(textWidth(SMALL, "ARRIVING"), textWidth(SMALL, "88 MIN"));
const ETA_H = 5;
const lineGap = (etaScale: number) => Math.max(2, Math.round(etaScale * 1.5));

interface Layout {
  cols: number;
  rows: number;
  pitch: number; // CSS px per dot
  routeScale: number;
  etaScale: number;
}

function computeLayout(w: number, h: number): Layout | null {
  if (w < 10 || h < 10) return null;
  // minimum content block at the minimum scales → dot pitch that fits it on screen
  const needCols = ETA_W * MIN_ETA_SCALE + 2 * MARGIN;
  const needRows = ROUTE_H * MIN_ROUTE_SCALE + lineGap(MIN_ETA_SCALE) + ETA_H * MIN_ETA_SCALE + 2 * MARGIN;
  const pitch = Math.min(w / Math.max(needCols, ROUTE_W * MIN_ROUTE_SCALE + 2 * MARGIN), h / needRows);
  const cols = Math.floor(w / pitch);
  const rows = Math.floor(h / pitch);
  const innerW = cols - 2 * MARGIN;
  const innerH = rows - 2 * MARGIN;
  // grow the scales as far as the grid allows (ETA first, then the route)
  let etaScale = Math.max(MIN_ETA_SCALE, Math.floor(innerW / ETA_W));
  let routeScale = MIN_ROUTE_SCALE;
  const fits = (r: number, e: number) =>
    ROUTE_W * r <= innerW && ETA_W * e <= innerW && ROUTE_H * r + lineGap(e) + ETA_H * e <= innerH;
  while (etaScale > MIN_ETA_SCALE && !fits(routeScale, etaScale)) etaScale--;
  // keep the route clearly dominant: at least ~1.6× the ETA scale where possible
  while (fits(routeScale + 1, etaScale)) routeScale++;
  while (etaScale > MIN_ETA_SCALE && routeScale < etaScale * 1.6) {
    etaScale--;
    while (fits(routeScale + 1, etaScale)) routeScale++;
  }
  return { cols, rows, pitch, routeScale, etaScale };
}

function writeText(set: PixelSet, font: Record<string, string[]>, text: string, cols: number, y: number, scale: number) {
  const w = textWidth(font, text) * scale;
  let x = Math.floor((cols - w) / 2);
  for (const g of glyphs(font, text)) {
    stamp(set, g, x, y, scale);
    x += ((g[0]?.length ?? 0) + 1) * scale;
  }
}

function buildScreen(rec: Recommendation, l: Layout): PixelSet {
  const s: PixelSet = new Set();
  const routeH = ROUTE_H * l.routeScale;
  const etaH = ETA_H * l.etaScale;
  const gap = lineGap(l.etaScale);
  const top = Math.floor((l.rows - (routeH + gap + etaH)) / 2);
  writeText(s, BIG, rec.route, l.cols, top, l.routeScale);
  writeText(s, SMALL, etaLabel(rec.etaMinutes), l.cols, top + routeH + gap, l.etaScale);
  return s;
}

const EMPTY: PixelSet = new Set();

export function LedScreen({ recommendation }: { recommendation: Recommendation | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // follow the real available area (rotation, Safari toolbars, safe areas)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => computeLayout(size.w, size.h), [size.w, size.h]);
  const color = recommendation ? LED_COLOR[ledBucketForMinutes(recommendation.etaMinutes)] : null;
  const lit = useMemo(
    () => (recommendation && layout ? buildScreen(recommendation, layout) : EMPTY),
    [recommendation, layout]
  );

  return (
    <div ref={boxRef} className="led-screen" data-lit={!!recommendation}>
      {layout && (
        <div
          className="led-screen-panel"
          style={
            {
              width: layout.cols * layout.pitch,
              height: layout.rows * layout.pitch,
              ...(color ? { "--led": color } : {}),
            } as CSSProperties
          }
        >
          {/* dark, unlit LED grid across the whole screen (always visible) */}
          <DotMatrix cols={layout.cols} rows={layout.rows} lit={EMPTY} color="transparent" className="led-matrix" />
          {/* lit layer: route + ETA, same power-on entrance as the tile */}
          <AnimatePresence>
            {recommendation && color && (
              <motion.div
                key="lit"
                className="led-screen-lit"
                initial={{ opacity: 0, filter: "brightness(2.2)" }}
                animate={{ opacity: 1, filter: "brightness(1)" }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              >
                <DotMatrix
                  cols={layout.cols}
                  rows={layout.rows}
                  lit={lit}
                  color={color}
                  litOnly
                  className="led-matrix led-matrix-lit"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
