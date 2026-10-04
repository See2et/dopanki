/**
 * Festival effects: synthesized WebAudio sound and a full-screen, input-transparent effect layer
 * (canvas confetti, ribbons and coins plus DOM stickers). Nothing runs at startup; audio is only
 * created after a user gesture, and every effect ends by itself or through stopFireworks/silenceSound.
 */
const soundKey = 'dopanki_sound';
let context: AudioContext | null = null;
let master: GainNode | null = null;

/** Covers festival sound effects and automatic readout; explicit replay buttons stay available. */
export function soundEnabled(): boolean {
  try { return localStorage.getItem(soundKey) !== 'off'; } catch { return true; }
}
export function setSoundEnabled(enabled: boolean) {
  try { localStorage.setItem(soundKey, enabled ? 'on' : 'off'); } catch { /* The setting still applies to this page. */ }
  if (!enabled) silenceSound();
}
/** Must be called synchronously from a user gesture so later sounds are allowed to play. */
export function primeSound() {
  if (!soundEnabled() || typeof AudioContext !== 'function') return;
  try {
    if (!context || context.state === 'closed') context = new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
  } catch { context = null; }
}
export function silenceSound() {
  master?.disconnect();
  master = null;
}
function output(): { ctx: AudioContext; out: GainNode } | null {
  if (!context || context.state === 'closed' || !soundEnabled()) return null;
  if (!master) {
    master = context.createGain();
    master.gain.value = 0.2;
    master.connect(context.destination);
  }
  return { ctx: context, out: master };
}
function tone(ctx: AudioContext, out: GainNode, frequency: number, start: number, duration: number, type: OscillatorType = 'triangle', peak = 0.8, glideTo?: number) {
  const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(frequency, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(out); osc.start(start); osc.stop(start + duration + 0.02);
}
function noise(ctx: AudioContext, out: GainNode, start: number, duration: number, peak: number, frequency: number) {
  const length = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate); const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  const source = ctx.createBufferSource(); const filter = ctx.createBiquadFilter(); const gain = ctx.createGain();
  source.buffer = buffer; filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = 0.9; gain.gain.value = peak;
  source.connect(filter).connect(gain).connect(out); source.start(start);
}
const note = (root: number, step: number) => root * 2 ** (step / 12);
const major = [0, 4, 7, 12, 16, 19, 24, 28];

/**
 * Stamp sound, slot-machine ticks while the counter rolls, then a shower of coin chimes. A recalled
 * card gets a bright rising "pon-pin"; an honest Again a soft, friendly "boyon". The coin shower is
 * identical because the ドパ are identical.
 */
export function playPayoff(tier: number, big = false, again = false) {
  const audio = output(); if (!audio) return;
  const { ctx, out } = audio; const t = ctx.currentTime + 0.02;
  if (again) {
    tone(ctx, out, 330, t, 0.28, 'sine', 0.9, 196);
    tone(ctx, out, note(523, 4), t + 0.05, 0.16, 'triangle', 0.25);
    tone(ctx, out, note(523, 0), t + 0.14, 0.24, 'triangle', 0.25);
  } else {
    tone(ctx, out, 220, t, 0.18, 'sine', 1, 70);
    noise(ctx, out, t, 0.12, 0.6, 1800);
    tone(ctx, out, note(784, 0), t + 0.04, 0.16, 'square', 0.22);
    tone(ctx, out, note(784, 7), t + 0.1, 0.22, 'square', 0.22);
  }
  const ticks = 8 + tier * 2;
  for (let i = 0; i < ticks; i++) tone(ctx, out, 1400 + i * 40, t + 0.18 + i * 0.045, 0.03, 'square', 0.12);
  const coins = 3 + tier * 2 + (big ? 6 : 0);
  for (let i = 0; i < coins; i++) {
    const at = t + 0.32 + i * 0.07 + Math.random() * 0.03;
    tone(ctx, out, 1975, at, 0.08, 'square', 0.16); tone(ctx, out, 2637, at + 0.05, 0.22, 'square', 0.14);
  }
}
/** Bright arpeggio for crossing into a new 万-unit (万 → 億 → 兆 …). */
export function playUnit() {
  const audio = output(); if (!audio) return;
  const { ctx, out } = audio; const t = ctx.currentTime + 0.42;
  major.forEach((step, i) => tone(ctx, out, note(523, step), t + i * 0.05, 0.3, 'triangle', 0.4));
  [0, 4, 7].forEach(step => tone(ctx, out, note(1047, step), t + 0.45, 0.6, 'sawtooth', 0.12));
}
/** Medal jingle: a bell-like rising phrase with a sparkle on top. */
export function playMedal() {
  const audio = output(); if (!audio) return;
  const { ctx, out } = audio; const t = ctx.currentTime + 0.02;
  [0, 7, 12, 16, 19].forEach((step, i) => { tone(ctx, out, note(659, step), t + i * 0.08, 0.5, 'sine', 0.45); tone(ctx, out, note(1318, step), t + i * 0.08, 0.25, 'triangle', 0.12); });
  for (let i = 0; i < 6; i++) tone(ctx, out, 2600 + i * 180, t + 0.45 + i * 0.04, 0.12, 'square', 0.06);
}

/** Longer celebration for a break or the end of the queue. */
export function playFanfare() {
  const audio = output(); if (!audio) return;
  const { ctx, out } = audio; const t = ctx.currentTime + 0.02;
  [0, 0, 0, 4, 7, 12, 7, 12, 16].forEach((step, i) => tone(ctx, out, note(392, step), t + i * 0.1, i >= 7 ? 0.7 : 0.13, 'square', 0.25));
  [0.1, 0.45, 0.8].forEach(offset => { tone(ctx, out, 160, t + offset, 0.24, 'sine', 1, 55); noise(ctx, out, t + offset + 0.04, 0.35, 0.4, 2600); });
}

/* ---------- Visual layer ---------- */
const palette = ['#ff5f9e', '#ffd23a', '#38c9a0', '#4f7cff', '#a97bff', '#ff8a3d', '#5fd6ff'];
const ribbonColors = ['#33c3a0', '#4f7cff', '#ff7fb0', '#a97bff', '#ffc93a'];
// An honest Again still gets a full celebration, in calmer blues and mint instead of the warm rainbow.
const coolPalette = ['#4f7cff', '#5fd6ff', '#33c3a0', '#a97bff', '#9fb4ff', '#ffffff'];
const coolRibbons = ['#4f7cff', '#5fd6ff', '#33c3a0', '#a97bff'];
type Point = { x: number; y: number };
interface Confetti { kind: 'paper' | 'star'; x: number; y: number; vx: number; vy: number; spin: number; angle: number; size: number; color: string; life: number; delay: number }
interface Coin { from: Point; to: Point; lift: number; start: number; duration: number }
interface Ribbon { start: number; duration: number; y: number; slope: number; amplitude: number; color: string; width: number; reverse: boolean }
const running = new Set<() => void>();
const timers = new Set<number>();

function layer() {
  let element = document.querySelector<HTMLDivElement>('#fx-layer');
  if (!element) {
    element = document.createElement('div');
    element.id = 'fx-layer'; element.className = 'fx-layer'; element.setAttribute('aria-hidden', 'true');
    document.body.appendChild(element);
  }
  return element;
}
function later(fn: () => void, ms: number) {
  const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
}
/** Adds a short-lived DOM sticker to the effect layer; it removes itself after `ms`. */
function sticker(className: string, html: string, ms: number) {
  const element = document.createElement('div');
  element.className = className; element.innerHTML = html;
  layer().appendChild(element);
  later(() => element.remove(), ms);
  return element;
}
function drawStar(ctx: CanvasRenderingContext2D, size: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? size * 0.45 : size; const a = (Math.PI / 5) * i - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

/** One canvas animation over the whole viewport. Canvas carries the `fireworks` class. */
function canvasEffect(duration: number, setup: (add: { confetti: (o: Point, n: number, spread?: number, delay?: number) => void; coins: (from: Point, to: Point, n: number, delay: number) => void; ribbons: (n: number, delay: number) => void }) => void, cool = false) {
  const colors = cool ? coolPalette : palette;
  const streamers = cool ? coolRibbons : ribbonColors;
  const canvas = document.createElement('canvas');
  canvas.className = 'fireworks';
  layer().appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }
  const width = window.innerWidth; const height = window.innerHeight;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  ctx.scale(ratio, ratio);
  const scale = Math.min(1.4, Math.max(0.7, Math.min(width, height) / 600));
  const confetti: Confetti[] = []; const coins: Coin[] = []; const ribbons: Ribbon[] = [];
  setup({
    confetti(origin, n, spread = 1, delay = 0) {
      for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2; const speed = (4 + Math.random() * 9) * scale * spread;
        confetti.push({ kind: Math.random() < 0.22 ? 'star' : 'paper', x: origin.x, y: origin.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 5 * scale,
          spin: (Math.random() - 0.5) * 0.4, angle: Math.random() * 6, size: (5 + Math.random() * 6) * scale, color: colors[i % colors.length], life: 1, delay });
      }
    },
    coins(from, to, n, delay) {
      for (let i = 0; i < n; i++) coins.push({ from: { x: from.x + (Math.random() - 0.5) * 60, y: from.y + (Math.random() - 0.5) * 30 }, to, lift: 80 + Math.random() * 140, start: delay + i * 55, duration: 520 + Math.random() * 180 });
    },
    ribbons(n, delay) {
      for (let i = 0; i < n; i++) ribbons.push({ start: delay + i * 90, duration: 900 + Math.random() * 300, y: height * (0.08 + Math.random() * 0.4), slope: (Math.random() - 0.3) * 0.35,
        amplitude: 18 + Math.random() * 26, color: streamers[i % streamers.length], width: (9 + Math.random() * 5) * scale, reverse: i % 2 === 1 });
    },
  });
  let frame = 0; let begin = 0; let last = 0;
  const cancel = () => { cancelAnimationFrame(frame); running.delete(cancel); canvas.remove(); };
  const step = (now: number) => {
    if (!begin) { begin = now; last = now; }
    const elapsed = now - begin; const dt = Math.min(48, now - last) / 16.7; last = now;
    ctx.clearRect(0, 0, width, height);
    for (const r of ribbons) {
      const p = (elapsed - r.start) / r.duration; if (p <= 0 || p >= 1.25) continue;
      const span = width * 1.6; const head = -width * 0.3 + span * p; const tail = head - width * 0.55;
      ctx.beginPath(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = r.width; ctx.strokeStyle = r.color; ctx.globalAlpha = Math.min(1, (1.25 - p) * 3);
      for (let x = Math.max(tail, -40); x <= Math.min(head, width + 40); x += 12) {
        const px = r.reverse ? width - x : x;
        const y = r.y + x * r.slope + Math.sin(x / 70 + p * 6) * r.amplitude;
        if (x === Math.max(tail, -40)) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const c of confetti) {
      if (elapsed < c.delay || c.life <= 0) continue;
      c.vx *= 0.97 ** dt; c.vy = c.vy * 0.97 ** dt + 0.32 * dt * scale; c.x += c.vx * dt; c.y += c.vy * dt; c.angle += c.spin * dt;
      c.life -= 0.006 * dt * (2200 / duration);
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.angle); ctx.globalAlpha = Math.max(0, Math.min(1, c.life * 2.5));
      ctx.fillStyle = c.color; ctx.strokeStyle = '#27213a'; ctx.lineWidth = 1.4;
      if (c.kind === 'star') drawStar(ctx, c.size * 0.9);
      else { const w = c.size; const h = c.size * 0.55 * Math.abs(Math.cos(c.angle * 2)) + 1; ctx.fillRect(-w / 2, -h / 2, w, h); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    for (const coin of coins) {
      const p = (elapsed - coin.start) / coin.duration; if (p <= 0 || p >= 1) continue;
      const e = p * p * (3 - 2 * p);
      const x = coin.from.x + (coin.to.x - coin.from.x) * e;
      const y = coin.from.y + (coin.to.y - coin.from.y) * e - Math.sin(Math.PI * e) * coin.lift;
      const r = 9 * scale * (1 - p * 0.35); const squash = Math.abs(Math.cos(p * 9)) * 0.75 + 0.25;
      ctx.save(); ctx.translate(x, y); ctx.scale(squash, 1);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#ffd23a'; ctx.fill(); ctx.lineWidth = 2.2; ctx.strokeStyle = '#27213a'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.strokeStyle = '#e8a400'; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.restore();
    }
    if (elapsed < duration) frame = requestAnimationFrame(step); else cancel();
  };
  running.add(cancel);
  frame = requestAnimationFrame(step);
}

/** Spinning sunburst behind the whole page (under the app, above the paper) for the burst only. */
function backdrop(tier: number, duration: number, cool = false) {
  const element = document.createElement('div');
  element.className = `fx-backdrop${cool ? ' is-cool' : tier >= 3 ? ' is-hot' : ''}`;
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--life', `${duration}ms`);
  document.body.appendChild(element);
  later(() => element.remove(), duration);
}

export interface PayoffOptions { origin: Point; target: Point | null; tier: number; duration: number; unit: string | null; big: boolean; again: boolean }
/**
 * The post-rating burst. Size, coins and length scale with the festival tier only; an honest Again
 * changes the colour palette, never the amount of celebration.
 */
export function payoffFx(o: PayoffOptions) {
  backdrop(o.tier, o.duration, o.again);
  canvasEffect(o.duration, add => {
    add.confetti(o.origin, 70 + o.tier * 30 + (o.big ? 80 : 0), 1 + o.tier * 0.08);
    if (o.tier >= 3) add.confetti({ x: window.innerWidth * 0.15, y: window.innerHeight * 0.2 }, 30 + o.tier * 8, 0.9, 260);
    if (o.tier >= 3) add.confetti({ x: window.innerWidth * 0.85, y: window.innerHeight * 0.2 }, 30 + o.tier * 8, 0.9, 380);
    if (o.target) add.coins(o.origin, o.target, 5 + o.tier * 3 + (o.big ? 8 : 0), 160);
    if (o.tier >= 1 || o.big) add.ribbons(o.tier + (o.big ? 3 : 0), 80);
  }, o.again);
  if (o.unit) sticker('fx-unit', `<span class="fx-unit-value">${o.unit}</span><span class="fx-unit-label">突破!</span>`, Math.min(o.duration, 1500));
}
/** Diagonal "N枚目" ribbon that wipes across ドパハム's stage (not the card) as the next card arrives. */
export function sweepFx(label: string, y: number) {
  sticker('fx-sweep', `<span>${label}</span>`, 560).style.top = `${Math.round(y)}px`;
}
/** Long celebration for the finished queue or a break. */
export function finaleFx(duration = 2800) {
  backdrop(5, duration);
  canvasEffect(duration, add => {
    const w = window.innerWidth; const h = window.innerHeight;
    add.confetti({ x: w / 2, y: h * 0.35 }, 140, 1.3);
    add.confetti({ x: w * 0.1, y: h * 0.6 }, 60, 1.1, 500);
    add.confetti({ x: w * 0.9, y: h * 0.6 }, 60, 1.1, 800);
    add.confetti({ x: w / 2, y: h * 0.3 }, 80, 1.2, 1300);
    add.ribbons(6, 150);
  });
}

/** Stops every visual effect at once (navigation, undo, logout, skip). */
export function stopFireworks() {
  for (const cancel of [...running]) cancel();
  for (const id of timers) window.clearTimeout(id);
  timers.clear();
  const element = document.querySelector('#fx-layer');
  if (element) element.innerHTML = '';
  document.querySelectorAll('.fx-backdrop').forEach(backdropElement => backdropElement.remove());
}
export const fireworksRunning = () => running.size > 0;
