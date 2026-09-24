import { useMemo } from "react";
import { motion } from "framer-motion";

// Visual-only listening waveform. Later this can be driven by real
// microphone amplitude (AnalyserNode); for now each bar loops on its own.
export function Waveform({ bars = 24 }: { bars?: number }) {
  const specs = useMemo(
    () =>
      Array.from({ length: bars }, (_, i) => {
        // taller in the middle, shorter at the edges
        const center = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2);
        const peak = 0.35 + center * 0.65;
        return {
          heights: [0.15, peak * (0.6 + Math.random() * 0.4), 0.2, peak, 0.15].map(
            (h) => `${Math.round(h * 100)}%`
          ),
          duration: 0.9 + Math.random() * 0.7,
          delay: Math.random() * 0.4,
        };
      }),
    [bars]
  );

  return (
    <div className="waveform" aria-label="Listening">
      {specs.map((s, i) => (
        <motion.span
          key={i}
          className="waveform-bar"
          initial={{ height: "15%" }}
          animate={{ height: s.heights }}
          transition={{
            duration: s.duration,
            delay: s.delay,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}
