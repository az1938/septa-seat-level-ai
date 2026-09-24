// LED color rules (same thresholds as Prototype 1's led.ts, re-created here
// so the old project is not imported or modified):
//   > 8 min   → RED
//   4–8 min   → YELLOW
//   1–3 min   → GREEN
//   < 1 min   → WHITE ("ARRIVING")

export type LedBucket = "RED" | "YELLOW" | "GREEN" | "WHITE";

export function ledBucketForMinutes(minutes: number): LedBucket {
  if (minutes < 1) return "WHITE";
  if (minutes < 4) return "GREEN";
  if (minutes <= 8) return "YELLOW";
  return "RED";
}

// Lit-LED colors (bright, slightly saturated so they read as emitted light).
export const LED_COLOR: Record<LedBucket, string> = {
  RED: "#ff3b30",
  YELLOW: "#ffc400",
  GREEN: "#2ee66b",
  WHITE: "#ffffff",
};

export function etaLabel(minutes: number): string {
  return minutes < 1 ? "ARRIVING" : `${Math.round(minutes)} MIN`;
}
