/**
 * Client-only decorative festival points ("ドパ"). They are never sent to the server, never touch
 * scheduling, and do not depend on the chosen rating: every confirmed review is worth the same as
 * any other review at the same position in the festival.
 */
export interface FestivalRecord { eventId: string; amount: number; prevTotal: number; prevCount: number }
export interface Festival { total: number; count: number; last: FestivalRecord | null; counted: string[] }

const storageKey = 'dopanki_festival';
// Digits grow with the square root of the shot: a new 万-unit every few cards early on, still
// climbing past 無量大数 in very long sessions, and capped well inside double range.
const maxExponent = 300;
const remembered = 100;
// 𥝱 is often missing from system fonts, so the common 秭 form is used.
const units = ['', '万', '億', '兆', '京', '垓', '秭', '穣', '溝', '澗', '正', '載', '極', '恒河沙', '阿僧祇', '那由他', '不可思議', '無量大数'];

export const emptyFestival = (): Festival => ({ total: 0, count: 0, last: null, counted: [] });

/** Points for the nth confirmed review in this festival. The rating is deliberately not an input. */
export function shotAmount(shot: number): number {
  return Math.round(10 ** Math.min(maxExponent, 2 + 3 * Math.sqrt(Math.max(1, Math.floor(shot)) - 1)));
}

/** Index of the largest 万-based unit reached (0 = below 万, 2 = 億, 4 = 京 …). */
export function unitIndex(value: number): number {
  return value >= 10000 && Number.isFinite(value) ? Math.floor(Math.log10(value) / 4) : 0;
}
/** "1億", "1京", "1万無量大数" … for the unit-crossing banner. */
export const unitLabel = (index: number) => index < units.length ? `1${units[index]}` : `${formatDopa(10 ** (4 * (index - units.length + 1)))}${units.at(-1)}`;

/** Festival heat (0–5) from how many reviews were recorded; never from the rating. */
export function feverTier(count: number): number {
  return Math.max(0, Math.min(5, Math.floor(Math.log2(Math.max(1, count)))));
}

export function grantReward(festival: Festival, eventId: string): { festival: Festival; record: FestivalRecord } | null {
  if (festival.counted.includes(eventId)) return null;
  const amount = shotAmount(festival.count + 1);
  const record: FestivalRecord = { eventId, amount, prevTotal: festival.total, prevCount: festival.count };
  return { record, festival: { total: festival.total + amount, count: festival.count + 1, last: record, counted: [...festival.counted, eventId].slice(-remembered) } };
}

/** Only the most recent counted event can be reversed, mirroring the single-step server undo. */
export function revokeReward(festival: Festival, eventId: string): { festival: Festival; record: FestivalRecord } | null {
  const record = festival.last;
  if (!record || record.eventId !== eventId) return null;
  // Restoring the stored totals (instead of subtracting) keeps undo exact for huge values.
  // The undone ID stays in `counted` so it can never be rewarded again.
  return { record, festival: { total: record.prevTotal, count: record.prevCount, last: null, counted: festival.counted } };
}

const amountValid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const countValid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function validRecord(value: unknown): value is FestivalRecord {
  const r = value as FestivalRecord;
  return !!r && typeof r === 'object' && typeof r.eventId === 'string' && amountValid(r.amount) && amountValid(r.prevTotal) && countValid(r.prevCount);
}

export function loadFestival(storage: Storage = sessionStorage): Festival {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || 'null') as Festival | null;
    if (value && amountValid(value.total) && countValid(value.count) && Array.isArray(value.counted) && value.counted.every(id => typeof id === 'string')
      && (value.last === null || validRecord(value.last))) return { total: value.total, count: value.count, last: value.last, counted: value.counted.slice(-remembered) };
  } catch { /* A broken decoration never blocks studying. */ }
  return emptyFestival();
}

export function saveFestival(festival: Festival, storage: Storage = sessionStorage) {
  try { storage.setItem(storageKey, JSON.stringify(festival)); } catch { /* Decoration only. */ }
}

const truncate = (n: number, digits: number) => String(Math.floor(n * 10 ** digits) / 10 ** digits);

/** Japanese large-number notation: 3,844 / 1280万 / 4.25億 … 1.6万無量大数. */
export function formatDopa(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '∞';
  if (value < 10000) return Math.round(value).toLocaleString('ja-JP');
  const exponent = Math.min(Math.floor(Math.log10(value) / 4), units.length - 1);
  const mantissa = value / 10 ** (exponent * 4);
  if (mantissa >= 10000) return `${formatDopa(mantissa)}${units[exponent]}`;
  return `${mantissa >= 100 ? truncate(mantissa, 0) : mantissa >= 10 ? truncate(mantissa, 1) : truncate(mantissa, 2)}${units[exponent]}`;
}

/** Visual intensity tier (0–5) grows with the festival, never with the rating. */
export function intensityTier(amount: number): number {
  return Math.max(0, Math.min(5, Math.floor(Math.log10(Math.max(1, amount)) / 4)));
}
