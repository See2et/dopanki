/** A batch counts distinct cards, while answers include their intraday repetitions. */
export interface FocusAnswer { eventId: string; cardId: string; rating: number; resolved: boolean }
export interface FocusBatch {
  deckId: string;
  day: number;
  number: number;
  ids: string[];
  pending: string[];
  excluded: string[];
  answers: FocusAnswer[];
}
export interface FocusSession { batch: FocusBatch; previous: FocusBatch | null }
export function beginFocus(deckId: string, day: number, ids: string[], previous: FocusBatch | null = null): FocusSession {
  const members = [...new Set(ids)].slice(0,10);
  return { batch: { deckId, day, number: previous?.day === day ? previous.number + 1 : 1,
    ids: members, pending: [...members], excluded: [], answers: [] }, previous };
}
export function answerFocus(session: FocusSession, answer: FocusAnswer): FocusSession {
  const b = session.batch;
  if (!b.ids.includes(answer.cardId) || b.answers.some(a => a.eventId === answer.eventId)) return session;
  return { ...session, batch: { ...b, answers: [...b.answers,answer],
    pending: answer.resolved ? b.pending.filter(id => id !== answer.cardId) : [...new Set([...b.pending,answer.cardId])] } };
}
export function reconcileFocus(session: FocusSession, activeIds: string[]): FocusSession {
  const b = session.batch;
  const removed = b.pending.filter(id => !activeIds.includes(id));
  if (!removed.length) return session;
  // Another screen can suspend, move or finish a card. Do not credit it as our recall.
  return { ...session, batch: { ...b, pending: b.pending.filter(id => activeIds.includes(id)),
    excluded: [...new Set([...b.excluded,...removed])] } };
}
export function undoFocus(session: FocusSession, eventId: string): FocusSession {
  const batch = [session.batch,session.previous].find(b => b?.answers.some(a => a.eventId === eventId));
  if (!batch) return session;
  const undone = batch.answers.find(a => a.eventId === eventId)!;
  const answers = batch.answers.filter(a => a.eventId !== eventId);
  const last = answers.filter(a => a.cardId === undone.cardId).at(-1);
  const pending = batch.pending.filter(id => id !== undone.cardId);
  if (!last?.resolved) pending.push(undone.cardId);
  return { batch: { ...batch, answers, pending, excluded: batch.excluded.filter(id => id !== undone.cardId) },
    previous: batch === session.batch ? session.previous : null };
}
export function focusStats(batch: FocusBatch) {
  const first = new Map<string,number>();
  const last = new Map<string,FocusAnswer>();
  const failed = new Set<string>();
  for (const a of batch.answers) {
    if (!first.has(a.cardId)) first.set(a.cardId,a.rating);
    last.set(a.cardId,a);
    if (a.rating === 1) failed.add(a.cardId);
  }
  return {
    finished: batch.ids.length - batch.pending.length - batch.excluded.length,
    recalledFirst: [...first.values()].filter(r => r !== 1).length,
    relearned: [...last.values()].filter(a => failed.has(a.cardId) && a.rating !== 1 && a.resolved && !batch.pending.includes(a.cardId) && !batch.excluded.includes(a.cardId)).length,
    answers: batch.answers.length,
  };
}
export function readFocus(raw: string | null): FocusSession | null {
  try {
    const value = JSON.parse(raw || 'null') as FocusSession | null;
    const valid = (b: FocusBatch) => b && typeof b.deckId === 'string' && Number.isFinite(b.day) && Number.isSafeInteger(b.number) && b.number > 0 &&
      Array.isArray(b.ids) && b.ids.length > 0 && b.ids.length <= 10 && b.ids.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(b.ids).size === b.ids.length &&
      Array.isArray(b.pending) && b.pending.every(id => b.ids.includes(id)) && Array.isArray(b.excluded) && b.excluded.every(id => b.ids.includes(id)) &&
      Array.isArray(b.answers) && b.answers.every(a => typeof a.eventId === 'string' && b.ids.includes(a.cardId) && [1,2,3,4].includes(a.rating) && typeof a.resolved === 'boolean');
    return value && valid(value.batch) && (value.previous === null || valid(value.previous)) ? value : null;
  } catch { return null; }
}
