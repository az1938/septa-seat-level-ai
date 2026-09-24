// ─────────────────────────────────────────────────────────────────────────────
// Local transcript normalization — a tiny speech-recognition cleanup layer.
//
// Runs on the browser's raw SpeechRecognition transcript BEFORE it is sent to
// OpenAI. It only fixes known mis-hearings of a few local place names; it does
// not interpret destinations (OpenAI), choose routes (GTFS) or give ETAs (SEPTA).
//
// Matching (conservative, word-level, two passes):
//   1. Exact alias phrases from PLACE_ALIASES (whole words, case-insensitive).
//   2. Fuzzy: a word pair where the first word is within Levenshtein distance 1
//      of the place's distinctive word (e.g. "tangen") AND the second word is a
//      "hall"-like word. Both words must match — "tang", "tango", "tangerine" or
//      "tangent" alone are never touched.
// After a match, directly repeated fragments of the same place (e.g. the
// trailing "tangen" in "Tangled Hall tangen") are dropped.
// ─────────────────────────────────────────────────────────────────────────────

interface PlaceAliases {
  /** distinctive word(s) of the canonical name, lowercase — used for fuzzy matching */
  keyWords: string[];
  /** acceptable second words, lowercase (e.g. mis-hearings of "hall") */
  tailWords: string[];
  /** known full-phrase mis-hearings, lowercase */
  aliases: string[];
}

/** Add more Penn / local destinations here later. Keep it small. */
export const PLACE_ALIASES: Record<string, PlaceAliases> = {
  "Tangen Hall": {
    keyWords: ["tangen"],
    tailWords: ["hall", "haul", "hal", "hole", "hull"],
    aliases: [
      "tangen hall",
      "tangled hall",
      "tangent hall",
      "tangen haul",
      "tangin hall",
      "tangan hall",
      "tanggen hall",
      "tan gen hall",
      "tanjin hall",
      "tangle hall",
    ],
  },
};

const FUZZY_MAX_DISTANCE = 1;

export interface NormalizedTranscript {
  raw: string;
  text: string;
  changed: boolean;
  corrections: { place: string; heard: string }[];
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

type Token = { raw: string; norm: string };

const tokenize = (s: string): Token[] =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: raw.toLowerCase().replace(/[^a-z0-9']/g, "") }))
    .filter((t) => t.norm.length > 0 || t.raw.length > 0);

/** Is this word a repeated key-word fragment of the place ("tangen", "tangled", …)? */
function isKeyFragment(word: string | undefined, p: PlaceAliases): boolean {
  if (!word || word.length < 4) return false;
  if (p.keyWords.some((k) => levenshtein(word, k) <= FUZZY_MAX_DISTANCE)) return true;
  return p.aliases.some((a) => a.split(" ")[0] === word);
}

export function normalizeTranscript(rawTranscript: string): NormalizedTranscript {
  const raw = rawTranscript ?? "";
  let tokens = tokenize(raw);
  const corrections: NormalizedTranscript["corrections"] = [];

  for (const [place, p] of Object.entries(PLACE_ALIASES)) {
    let i = 0;
    while (i < tokens.length) {
      let len = 0;
      // 1. exact alias phrase
      for (const alias of p.aliases) {
        const words = alias.split(" ");
        if (words.every((w, k) => tokens[i + k]?.norm === w)) {
          len = Math.max(len, words.length);
        }
      }
      // 2. conservative fuzzy word pair
      if (!len && tokens[i + 1]) {
        const first = tokens[i].norm;
        const second = tokens[i + 1].norm;
        const keyClose = p.keyWords.some((k) => first.length >= 4 && levenshtein(first, k) <= FUZZY_MAX_DISTANCE);
        if (keyClose && p.tailWords.includes(second)) len = 2;
      }
      if (!len) {
        i++;
        continue;
      }

      // drop repeated fragments right before / after the match ("… tangen")
      let start = i;
      let end = i + len;
      // (a key-word fragment, optionally followed by a "hall"-like word)
      for (;;) {
        if (isKeyFragment(tokens[end]?.norm, p)) {
          end++;
          if (p.tailWords.includes(tokens[end]?.norm ?? "")) end++;
        } else break;
      }
      for (;;) {
        if (p.tailWords.includes(tokens[start - 1]?.norm ?? "") && isKeyFragment(tokens[start - 2]?.norm, p)) start -= 2;
        else if (isKeyFragment(tokens[start - 1]?.norm, p)) start--;
        else break;
      }

      const heard = tokens
        .slice(start, end)
        .map((t) => t.raw)
        .join(" ");
      const canonical = tokenize(place).map((t) => ({ ...t }));
      // keep trailing punctuation of the last replaced word (e.g. "hall." → "Hall.")
      const trail = tokens[end - 1].raw.match(/[.,!?]+$/)?.[0] ?? "";
      canonical[canonical.length - 1] = {
        raw: canonical[canonical.length - 1].raw + trail,
        norm: canonical[canonical.length - 1].norm,
      };
      if (heard.replace(/[.,!?]+$/, "") !== place) corrections.push({ place, heard });
      tokens = [...tokens.slice(0, start), ...canonical, ...tokens.slice(end)];
      i = start + canonical.length;
    }
  }

  const text = tokens.map((t) => t.raw).join(" ");
  return { raw, text, changed: text !== raw.trim().replace(/\s+/g, " "), corrections };
}
