// ─────────────────────────────────────────────────────────────────────────────
// Spoken prompts via the browser Web Speech API (speechSynthesis).
// Output only — no microphone, no recognition.
//
// English is forced two ways:
//   1. utterance.lang = "en-US"
//   2. utterance.voice = an English voice from speechSynthesis.getVoices()
//      (first choice en-US, fallback any en-*). Voices load asynchronously in
//      most browsers, so we listen for `onvoiceschanged` and, if the list is
//      still empty when we need it, wait briefly for it.
//
// Browser autoplay rule: Chrome/Safari only allow speech after the page has
// received at least one user gesture (click / key). installSpeechUnlock()
// primes speech on the first gesture; before that, speak() resolves "blocked".
// ─────────────────────────────────────────────────────────────────────────────

const LANG = "en-US";
const VOICE_WAIT_MS = 1500;

export type SpeakResult = "ended" | "cancelled" | "blocked" | "unsupported" | "error";

const synth: SpeechSynthesis | null =
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

let voices: SpeechSynthesisVoice[] = [];
const voiceListeners = new Set<() => void>();

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices();
  voiceListeners.forEach((fn) => fn());
}

if (synth) {
  loadVoices();
  const prev = synth.onvoiceschanged;
  synth.onvoiceschanged = (ev) => {
    loadVoices();
    if (typeof prev === "function") prev.call(synth, ev);
  };
}

const norm = (lang: string) => lang.toLowerCase().replace("_", "-");

/** en-US first (prefer on-device voices), then any en-*, else null. */
export function pickEnglishVoice(): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => norm(v.lang).startsWith("en"));
  const us = english.filter((v) => norm(v.lang) === "en-us");
  return us.find((v) => v.localService) ?? us[0] ?? english.find((v) => v.localService) ?? english[0] ?? null;
}

function waitForVoices(): Promise<void> {
  if (voices.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      voiceListeners.delete(done);
      window.clearTimeout(t);
      resolve();
    };
    const t = window.setTimeout(done, VOICE_WAIT_MS);
    voiceListeners.add(done);
  });
}

// Every speak/cancel bumps this; a speak() that was waiting for voices checks
// it before talking, so a Reset during the wait also prevents the speech.
let generation = 0;

/** Stop anything currently speaking or queued. */
export function cancelSpeech() {
  generation++;
  synth?.cancel();
}

/** Speak `text` once in English. Cancels anything already speaking. */
export async function speak(text: string): Promise<SpeakResult> {
  if (!synth) return "unsupported";
  const myGen = ++generation;
  synth.cancel();

  await waitForVoices();
  if (myGen !== generation) return "cancelled";

  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG;
  const voice = pickEnglishVoice();
  if (voice) u.voice = voice;
  u.rate = 1;
  u.pitch = 1;

  return new Promise<SpeakResult>((resolve) => {
    u.onend = () => resolve(myGen === generation ? "ended" : "cancelled");
    u.onerror = (e) =>
      resolve(
        e.error === "not-allowed"
          ? "blocked"
          : e.error === "canceled" || e.error === "interrupted"
          ? "cancelled"
          : "error"
      );
    synth.speak(u);
  });
}

/** Prime speech on the first user gesture so later (camera-triggered) speech is allowed. */
export function installSpeechUnlock(onUnlocked?: () => void) {
  if (!synth) return () => {};
  const unlock = () => {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.lang = LANG;
    synth.speak(u);
    remove();
    onUnlocked?.();
  };
  const remove = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return remove;
}

export function currentVoiceLabel(): string {
  const v = pickEnglishVoice();
  return v ? `${v.name} (${v.lang})` : `default (${LANG})`;
}
