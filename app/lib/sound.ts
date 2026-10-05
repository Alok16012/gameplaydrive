"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

// Game sounds and background music, synthesised with the Web Audio API, so there are no audio files to load.
// Phones only allow audio after the first touch, so unlockAudio() runs on the first tap (see GameHubApp).
// The player's choices (Settings → Sound effects / Background music / Vibration) are kept on the device.

export interface SoundPrefs { sound: boolean; music: boolean; vibration: boolean }
const KEY = "gamehub-sound";
const DEFAULTS: SoundPrefs = { sound: true, music: true, vibration: true };

let prefs: SoundPrefs = DEFAULTS;
let loaded = false;
const subs = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) prefs = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* private mode: keep the defaults */ }
}

export function getPrefs(): SoundPrefs {
  load();
  return prefs;
}

export function setPref(k: keyof SoundPrefs, v: boolean) {
  load();
  prefs = { ...prefs, [k]: v };
  try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  if (k === "music") (v ? startMusic() : stopMusic());
  if (k === "sound" && v) sfx.click();
  subs.forEach((f) => f());
}

export function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    getPrefs,
    () => DEFAULTS,
  );
}

/* ------------------------------------------------------------------ engine */

let ctx: AudioContext | null = null;
let sfxBus: GainNode;
let musicBus: GainNode;
let noiseBuf: AudioBuffer;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(comp);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    musicBus.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });
  }
  if (ctx.state === "suspended" && !document.hidden) void ctx.resume();
  return ctx;
}

/** Call from a user gesture: wakes the audio engine and starts the music if it is on. */
export function unlockAudio() {
  load();
  if (!ac()) return;
  if (prefs.music) startMusic();
}

interface ToneOpts { type?: OscillatorType; vol?: number; at?: number; attack?: number; slide?: number; bus?: AudioNode }
function tone(freq: number, dur: number, o: ToneOpts = {}) {
  const c = ctx!;
  const t = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(o.vol ?? 0.3, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(o.bus ?? sfxBus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

interface NoiseOpts { vol?: number; at?: number; freq?: number; q?: number; filter?: BiquadFilterType; sweep?: number; attack?: number; bus?: AudioNode }
function noise(dur: number, o: NoiseOpts = {}) {
  const c = ctx!;
  const t = c.currentTime + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = o.filter ?? "bandpass";
  f.frequency.setValueAtTime(o.freq ?? 2000, t);
  if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, t + dur);
  f.Q.value = o.q ?? 1;
  const g = c.createGain();
  const a = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(o.vol ?? 0.3, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(o.bus ?? sfxBus);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

/** Run a sound only when effects are on and the engine is awake. */
const play = (fn: () => void) => () => {
  load();
  if (!prefs.sound || !ac()) return;
  try { fn(); } catch { /* never let a sound break the game */ }
};

export function vibrate(ms: number | number[]) {
  load();
  if (prefs.vibration && typeof navigator !== "undefined" && "vibrate" in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note → Hz

/* ------------------------------------------------------------------ effects */

export const sfx = {
  /** Soft UI tap. */
  click: play(() => {
    tone(1500, 0.04, { vol: 0.06, type: "triangle" });
  }),
  /** Casino chip dropped on the felt / stack. */
  chip: play(() => {
    noise(0.05, { freq: 3800, q: 4, vol: 0.45 });
    tone(2650, 0.05, { type: "triangle", vol: 0.12 });
    noise(0.04, { freq: 4400, q: 5, vol: 0.25, at: 0.05 });
    tone(3100, 0.035, { type: "triangle", vol: 0.07, at: 0.05 });
  }),
  /** A card dealt across the table. */
  card: play(() => {
    noise(0.13, { filter: "bandpass", freq: 5200, sweep: 1800, q: 0.9, vol: 0.32, attack: 0.02 });
    noise(0.04, { filter: "lowpass", freq: 900, vol: 0.18, at: 0.11 });
  }),
  /** A card turned face up. */
  flip: play(() => {
    noise(0.07, { freq: 2600, q: 1.5, vol: 0.3, attack: 0.008 });
    tone(520, 0.05, { type: "triangle", vol: 0.06, at: 0.03 });
  }),
  /** Dice shaken and thrown. */
  dice: play(() => {
    for (let i = 0; i < 7; i++) {
      const at = i * 0.055 + Math.random() * 0.03;
      noise(0.035, { freq: 1700 + Math.random() * 1600, q: 6, vol: 0.32 - i * 0.025, at });
      tone(900 + Math.random() * 700, 0.025, { type: "square", vol: 0.03, at });
    }
    noise(0.09, { filter: "lowpass", freq: 600, vol: 0.35, at: 0.42 });
    tone(150, 0.1, { vol: 0.2, at: 0.42, slide: 90 });
  }),
  /** Countdown tick; `urgent` for the last seconds. */
  tick: play(() => tone(1050, 0.05, { type: "square", vol: 0.04 })),
  tickUrgent: play(() => { tone(1500, 0.07, { type: "square", vol: 0.06 }); }),
  /** Win: rising arpeggio with a sparkle. */
  win: play(() => {
    [72, 76, 79, 84].forEach((n, i) => tone(NOTE(n), 0.35, { type: "triangle", vol: 0.2, at: i * 0.09 }));
    [96, 100, 103].forEach((n, i) => tone(NOTE(n), 0.25, { vol: 0.05, at: 0.36 + i * 0.05 }));
  }),
  /** Big win: fanfare plus coins. */
  bigWin: play(() => {
    [67, 72, 76, 79, 84, 88].forEach((n, i) => tone(NOTE(n), 0.45, { type: "triangle", vol: 0.2, at: i * 0.08 }));
    [72, 76, 79].forEach((n) => tone(NOTE(n), 0.9, { type: "sawtooth", vol: 0.05, at: 0.5, attack: 0.05 }));
    for (let i = 0; i < 10; i++) tone(1800 + Math.random() * 1400, 0.12, { vol: 0.06, at: 0.55 + i * 0.07 });
  }),
  /** Lose: gentle falling notes. */
  lose: play(() => {
    [67, 63, 60].forEach((n, i) => tone(NOTE(n), 0.4, { type: "triangle", vol: 0.13, at: i * 0.16 }));
  }),
  /** Coins credited. */
  coin: play(() => {
    tone(NOTE(88), 0.12, { vol: 0.14, type: "square" });
    tone(NOTE(95), 0.35, { vol: 0.12, type: "square", at: 0.08 });
  }),
  /** Roulette ball running round the wheel and dropping into a pocket. */
  wheel: (ms: number) => play(() => {
    const s = ms / 1000;
    noise(s * 0.85, { filter: "lowpass", freq: 700, sweep: 200, vol: 0.12, attack: 0.3 });
    let t = 0, gap = 0.035;
    while (t < s * 0.78) {
      noise(0.02, { freq: 3000, q: 8, vol: 0.12, at: t });
      t += gap;
      gap *= 1.045;
    }
    // bounces into the pocket
    [0, 0.16, 0.27, 0.34, 0.39].forEach((d, i) => {
      noise(0.03, { freq: 2600, q: 5, vol: 0.32 - i * 0.05, at: s * 0.75 + d });
      tone(1400 - i * 80, 0.03, { type: "triangle", vol: 0.08 - i * 0.012, at: s * 0.75 + d });
    });
  })(),
  /** Stock Market: the bell when the market opens / closes. */
  bell: play(() => {
    tone(NOTE(88), 0.9, { type: "sine", vol: 0.14 });
    tone(NOTE(95), 0.7, { type: "sine", vol: 0.07, at: 0.01 });
  }),
  /** Ludo token hops one square. */
  hop: play(() => tone(680, 0.07, { vol: 0.12, slide: 980 })),
  /** A token or piece is captured. */
  capture: play(() => {
    tone(700, 0.3, { type: "sawtooth", vol: 0.08, slide: 120 });
    noise(0.15, { filter: "lowpass", freq: 800, vol: 0.2, at: 0.05 });
  }),
  /** Token reaches home. */
  home: play(() => [76, 79, 84].forEach((n, i) => tone(NOTE(n), 0.25, { type: "triangle", vol: 0.16, at: i * 0.08 }))),
  /** Chess piece set down. */
  move: play(() => {
    tone(220, 0.06, { type: "triangle", vol: 0.28 });
    noise(0.03, { freq: 1100, q: 2, vol: 0.25 });
  }),
  /** Plinko peg. */
  peg: play(() => tone(1700 + Math.random() * 900, 0.07, { vol: 0.08 })),
  /** Plinko ball lands in a slot. */
  slot: play(() => { tone(NOTE(79), 0.2, { type: "triangle", vol: 0.15 }); tone(NOTE(84), 0.3, { type: "triangle", vol: 0.12, at: 0.07 }); }),
  /** Aviator crash. */
  crash: play(() => {
    noise(1.1, { filter: "lowpass", freq: 900, sweep: 120, vol: 0.55 });
    tone(160, 0.9, { type: "sawtooth", vol: 0.12, slide: 35 });
  }),
  /** Plane takes off. */
  takeoff: play(() => {
    noise(1.2, { filter: "bandpass", freq: 300, sweep: 1400, q: 0.7, vol: 0.2, attack: 0.4 });
  }),
};

/** Aviator engine: a hum whose pitch follows the multiplier. Returns controls; stop() when the round ends. */
export function engine() {
  load();
  if (!prefs.sound || !ac()) return { set: (_m: number) => {}, stop: () => {} };
  const c = ctx!;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.linearRampToValueAtTime(0.06, c.currentTime + 0.6);
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 700;
  const a = c.createOscillator(), b = c.createOscillator();
  a.type = "sawtooth"; b.type = "sawtooth";
  a.frequency.value = 85; b.frequency.value = 86.5;
  a.connect(f); b.connect(f);
  f.connect(g).connect(sfxBus);
  a.start(); b.start();
  let stopped = false;
  return {
    set(m: number) {
      if (stopped) return;
      const hz = 85 + Math.min(220, Math.log(Math.max(1, m)) * 70);
      a.frequency.setTargetAtTime(hz, c.currentTime, 0.2);
      b.frequency.setTargetAtTime(hz * 1.017, c.currentTime, 0.2);
      f.frequency.setTargetAtTime(700 + hz * 3, c.currentTime, 0.2);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      g.gain.setTargetAtTime(0.0001, c.currentTime, 0.08);
      a.stop(c.currentTime + 0.5); b.stop(c.currentTime + 0.5);
    },
  };
}

/* ------------------------------------------------------------------ music */

// A relaxed casino-lounge loop: Am9 – Fmaj7 – Cmaj7 – G6 at 92 bpm. Soft pad, walking bass, a light shaker
// and an electric-piano figure, scheduled a little ahead of time so it never stutters.
const BPM = 92;
const EIGHTH = 60 / BPM / 2;
const CHORDS = [
  { root: 45, notes: [57, 60, 64, 67, 71] }, // Am9
  { root: 41, notes: [57, 60, 64, 65] },     // Fmaj7
  { root: 48, notes: [55, 59, 60, 64] },     // Cmaj7
  { root: 43, notes: [55, 59, 62, 64] },     // G6
];
const BASS = [0, -1, -1, 7, 0, -1, 12, 7]; // per eighth; −1 = rest
const KEYS = [-1, 2, -1, 3, 1, -1, 4, -1, -1, 2, -1, 1, 3, -1, 2, -1]; // chord-tone index per eighth over 2 bars

let timer: number | null = null;
let step = 0;
let nextAt = 0;

function scheduleStep(s: number, t: number) {
  const c = ctx!;
  const bar = Math.floor(s / 8);
  const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
  const e = s % 8;
  const rel = t - c.currentTime;
  // Pad on the first beat of every second bar.
  if (s % 16 === 0) {
    for (const n of chord.notes.slice(0, 4)) {
      for (const det of [-4, 4]) {
        const osc = c.createOscillator();
        const g = c.createGain();
        const f = c.createBiquadFilter();
        osc.type = "triangle";
        osc.frequency.value = NOTE(n);
        osc.detune.value = det;
        f.type = "lowpass";
        f.frequency.value = 1400;
        const len = EIGHTH * 16;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035, t + 0.8);
        g.gain.setValueAtTime(0.035, t + len - 0.6);
        g.gain.linearRampToValueAtTime(0.0001, t + len + 0.2);
        osc.connect(f).connect(g).connect(musicBus);
        osc.start(t);
        osc.stop(t + len + 0.3);
      }
    }
  }
  const b = BASS[e];
  if (b >= 0) tone(NOTE(chord.root + b - 12 + 12), EIGHTH * 1.6, { vol: 0.22, at: rel, bus: musicBus });
  const k = KEYS[s % 16];
  if (k >= 0) {
    const n = chord.notes[k % chord.notes.length] + 12;
    tone(NOTE(n), 0.6, { vol: 0.07, at: rel, bus: musicBus, type: "sine" });
    tone(NOTE(n) * 2, 0.25, { vol: 0.018, at: rel, bus: musicBus, type: "sine" });
  }
  // shaker: soft on the off-beats, a touch louder on the beat
  noise(0.05, { filter: "highpass", freq: 7000, vol: e % 2 ? 0.05 : 0.025, at: rel, bus: musicBus });
  if (e === 2 || e === 6) noise(0.12, { filter: "bandpass", freq: 1800, q: 0.8, vol: 0.05, at: rel, bus: musicBus }); // brush snare
}

export function startMusic() {
  load();
  if (!prefs.music || timer !== null) return;
  const c = ac();
  if (!c) return;
  musicBus.gain.cancelScheduledValues(c.currentTime);
  musicBus.gain.setValueAtTime(musicBus.gain.value, c.currentTime);
  musicBus.gain.linearRampToValueAtTime(0.55, c.currentTime + 2);
  nextAt = c.currentTime + 0.1;
  timer = window.setInterval(() => {
    if (!ctx) return;
    while (nextAt < ctx.currentTime + 0.35) {
      scheduleStep(step++, nextAt);
      nextAt += EIGHTH;
    }
  }, 90);
}

export function stopMusic() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
  if (ctx) {
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
    musicBus.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
  }
}

/** Play `fn` whenever `value` goes up after the first render (cards on the table, the pot, …). */
export function useSoundOnRise(value: number, fn: () => void) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (last.current !== null && value > last.current) fn();
    last.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

/** n cards dealt in quick succession. */
export function dealSound(n: number, gapMs = 140) {
  for (let i = 0; i < n; i++) window.setTimeout(() => sfx.card(), i * gapMs);
}

/** Win / lose cue for a settled round: `won` is the payout (null = you had no bet). */
export function useResultSound(phaseIsResult: boolean, won: number | null) {
  useEffect(() => {
    if (!phaseIsResult || won === null) return;
    if (won > 0) { sfx.win(); vibrate(50); } else sfx.lose();
  }, [phaseIsResult, won]);
}
