/** Decorative medals for this browser tab's session, independent of FSRS and server records.
 * Ratings 2/3/4 all mean self-reported recall, never verified correctness.
 * Call award/revoke only after the corresponding server save/undo succeeds.
 */
export type MedalRating = 1 | 2 | 3 | 4;

interface RuleProgress {
  reviewCount: number;
  againCount: number;
  rememberedCount: number;
  rememberedStreak: number;
  lastRating: MedalRating | null;
}

const rules = [
  { id: 'first-review', condition: 'Save the first review in this session.', matches: (p: RuleProgress) => p.reviewCount >= 1 },
  { id: 'first-again', condition: 'Honestly choose Again once in this session.', matches: (p: RuleProgress) => p.againCount >= 1 },
  { id: 'honest-3', condition: 'Honestly choose Again three times in this session.', matches: (p: RuleProgress) => p.againCount >= 3 },
  { id: 'remembered-3', condition: 'Report remembering three reviews in a row.', matches: (p: RuleProgress) => p.rememberedStreak >= 3 },
  { id: 'remembered-5', condition: 'Report remembering five reviews in a row.', matches: (p: RuleProgress) => p.rememberedStreak >= 5 },
  { id: 'remembered-10', condition: 'Report remembering ten reviews in a row.', matches: (p: RuleProgress) => p.rememberedStreak >= 10 },
  { id: 'comeback', condition: 'Report remembering immediately after an Again review.', matches: (p: RuleProgress, before: RuleProgress) => p.lastRating !== 1 && before.lastRating === 1 },
  { id: 'balanced', condition: 'Save at least one Again and three remembered reviews in this session.', matches: (p: RuleProgress) => p.againCount >= 1 && p.rememberedCount >= 3 },
  { id: 'reviews-10', condition: 'Save ten reviews in this session.', matches: (p: RuleProgress) => p.reviewCount >= 10 },
  { id: 'reviews-20', condition: 'Save twenty reviews in this session.', matches: (p: RuleProgress) => p.reviewCount >= 20 },
] as const;

export type MedalId = typeof rules[number]['id'];
/** Canonical trial conditions; presentation owns names, icons, and styling. */
export const MEDAL_RULES: readonly { readonly id: MedalId; readonly condition: string }[] = rules.map(({ id, condition }) => ({ id, condition }));

export interface MedalProgress extends RuleProgress {
  earnedIds: MedalId[];
}
export interface MedalState extends MedalProgress {
  version: 1;
  /** Retained after undo so a retried confirmed-save event can never count twice. */
  seenEventIds: string[];
  lastReview: { eventId: string; before: MedalProgress } | null;
}

export const MEDAL_STORAGE_KEY = 'dopanki_medals_session_v1';

export function createMedalState(): MedalState {
  return { version: 1, reviewCount: 0, againCount: 0, rememberedCount: 0, rememberedStreak: 0,
    lastRating: null, earnedIds: [], seenEventIds: [], lastReview: null };
}

function progressOf(state: MedalProgress): MedalProgress {
  return { reviewCount: state.reviewCount, againCount: state.againCount, rememberedCount: state.rememberedCount,
    rememberedStreak: state.rememberedStreak, lastRating: state.lastRating, earnedIds: [...state.earnedIds] };
}

/** No notification on duplicate events, including events whose reviews were undone. */
export function awardMedals(state: MedalState, eventId: string, rating: MedalRating): { state: MedalState; newIds: MedalId[] } {
  if (!eventId || !isRating(rating) || state.seenEventIds.includes(eventId)) return { state, newIds: [] };
  const before = progressOf(state);
  const remembered = rating !== 1;
  const progress: MedalProgress = {
    reviewCount: state.reviewCount + 1,
    againCount: state.againCount + (remembered ? 0 : 1),
    rememberedCount: state.rememberedCount + (remembered ? 1 : 0),
    rememberedStreak: remembered ? state.rememberedStreak + 1 : 0,
    lastRating: rating,
    earnedIds: [...state.earnedIds],
  };
  const newIds = rules.filter(rule => !state.earnedIds.includes(rule.id) && rule.matches(progress, before)).map(rule => rule.id);
  progress.earnedIds.push(...newIds);
  return { state: { ...progress, version: 1, seenEventIds: [...state.seenEventIds, eventId],
    lastReview: { eventId, before } }, newIds };
}

/** Only the latest saved review is undoable, matching the study screen's undo contract. */
export function revokeMedals(state: MedalState, eventId: string): { state: MedalState; revokedIds: MedalId[] } {
  if (!state.lastReview || state.lastReview.eventId !== eventId) return { state, revokedIds: [] };
  const before = state.lastReview.before;
  const revokedIds = state.earnedIds.filter(id => !before.earnedIds.includes(id));
  return { state: { ...progressOf(before), version: 1, seenEventIds: [...state.seenEventIds], lastReview: null }, revokedIds };
}

function isRating(value: unknown): value is MedalRating {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length;
}
function isProgress(value: unknown): value is MedalProgress {
  if (!isRecord(value)) return false;
  const { reviewCount, againCount, rememberedCount, rememberedStreak, lastRating, earnedIds } = value;
  if (![reviewCount, againCount, rememberedCount, rememberedStreak].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false;
  if (reviewCount !== (againCount as number) + (rememberedCount as number) || (rememberedStreak as number) > (rememberedCount as number)) return false;
  if (reviewCount === 0 ? lastRating !== null : !isRating(lastRating)) return false;
  if (lastRating === 1 && rememberedStreak !== 0) return false;
  return isStringList(earnedIds) && earnedIds.every(id => rules.some(rule => rule.id === id));
}
function isState(value: unknown): value is MedalState {
  if (!isRecord(value) || value.version !== 1 || !isProgress(value) || !isStringList(value.seenEventIds) || value.seenEventIds.length < value.reviewCount) return false;
  if (value.lastReview === null) return true;
  if (!isRecord(value.lastReview) || typeof value.lastReview.eventId !== 'string' || !value.seenEventIds.includes(value.lastReview.eventId) || !isProgress(value.lastReview.before)) return false;
  return value.lastReview.before.reviewCount === value.reviewCount - 1;
}

/** sessionStorage survives reloads; closing the tab ends the medal session. No legacy import. */
export function loadMedals(storage?: Pick<Storage, 'getItem'>): MedalState {
  try {
    const raw = (storage ?? globalThis.sessionStorage).getItem(MEDAL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isState(parsed) ? parsed : createMedalState();
  } catch { return createMedalState(); }
}

/** Storage failures must not interfere with saving or studying cards. */
export function saveMedals(state: MedalState, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? globalThis.sessionStorage).setItem(MEDAL_STORAGE_KEY, JSON.stringify(state)); } catch { /* Decorative state is optional. */ }
}
