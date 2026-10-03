import type { Counts, Deck, DeckSummary } from './types';

export interface DeckAnswers { deck_id: string; answered: number; new: number; review: number }
export interface DeckTotals extends Counts { deck_id: string }
const emptyCounts = (): Counts => ({ new: 0, learning: 0, review: 0, total: 0 });
const remaining = (limit: number, answered: number) => Math.max(0, limit - answered);

/** Names are Anki paths: only complete ::-separated segments define ancestry. */
export function summarizeDecks(decks: Deck[], totals: DeckTotals[], answers: DeckAnswers[]): DeckSummary[] {
  const byName = new Map(decks.map(deck => [deck.name, deck]));
  const virtualIds = new Set<string>();
  // Navigation ancestors are derived in memory; imported records and IDs stay untouched.
  for (const deck of decks) {
    const segments = deck.name.split('::');
    for (let depth = 1; depth < segments.length; depth++) {
      const name = segments.slice(0, depth).join('::');
      if (!byName.has(name)) {
        const id = `virtual:${name}`;
        virtualIds.add(id);
        byName.set(name, { ...deck, id, name, config: { ...deck.config,
          newPerDay: Number.MAX_SAFE_INTEGER, reviewPerDay: Number.MAX_SAFE_INTEGER } });
      }
    }
  }
  const totalsById = new Map(totals.map(total => [total.deck_id, total]));
  const answersById = new Map(answers.map(answer => [answer.deck_id, answer]));
  const summaries = [...byName.values()].map(deck => {
    const segments = deck.name.split('::');
    const total = totalsById.get(deck.id) ?? emptyCounts();
    const done = answersById.get(deck.id);
    const ownCounts = { total: total.total, learning: total.learning,
      new: Math.min(total.new, remaining(deck.config.newPerDay, done?.new ?? 0)),
      review: Math.min(total.review, remaining(deck.config.reviewPerDay ?? 9999, done?.review ?? 0)) };
    return { ...deck, parentId: segments.length > 1 ? byName.get(segments.slice(0, -1).join('::'))!.id : null,
      depth: segments.length - 1, label: segments.at(-1)!,
      ...(virtualIds.has(deck.id) ? { virtual: true } : {}),
      ownCounts, ownAnsweredToday: done?.answered ?? 0,
      counts: { ...ownCounts }, answeredToday: done?.answered ?? 0 } satisfies DeckSummary;
  });
  const summariesById = new Map(summaries.map(deck => [deck.id, deck]));
  const subtreeAnswers = new Map(summaries.map(deck => [deck.id, { new: answersById.get(deck.id)?.new ?? 0,
    review: answersById.get(deck.id)?.review ?? 0 }]));
  // A child's quota is applied before its eligible cards are added to its parent.
  for (const deck of [...summaries].sort((a, b) => b.depth - a.depth)) {
    const done = subtreeAnswers.get(deck.id)!;
    deck.counts.new = Math.min(deck.counts.new, remaining(deck.config.newPerDay, done.new));
    deck.counts.review = Math.min(deck.counts.review, remaining(deck.config.reviewPerDay ?? 9999, done.review));
    const parent = deck.parentId ? summariesById.get(deck.parentId) : undefined;
    if (parent) {
      for (const key of ['new', 'learning', 'review', 'total'] as const) parent.counts[key] += deck.counts[key];
      parent.answeredToday += deck.answeredToday;
      const parentDone = subtreeAnswers.get(parent.id)!;
      parentDone.new += done.new;
      parentDone.review += done.review;
    }
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Eligibility starts at the selection, so selecting a child ignores ancestor caps. */
export function studyScope(decks: DeckSummary[], selectedId: string): { id: string; new: boolean; review: boolean }[] {
  const children = new Map<string, DeckSummary[]>();
  for (const deck of decks) {
    if (deck.parentId) children.set(deck.parentId, [...(children.get(deck.parentId) ?? []), deck]);
  }
  const selected = decks.find(deck => deck.id === selectedId);
  const scope: { id: string; new: boolean; review: boolean }[] = [];
  function visit(deck: DeckSummary, newAllowed: boolean, reviewAllowed: boolean) {
    newAllowed &&= deck.counts.new > 0;
    reviewAllowed &&= deck.counts.review > 0;
    if (!deck.virtual) scope.push({ id: deck.id, new: newAllowed && deck.ownCounts.new > 0,
      review: reviewAllowed && deck.ownCounts.review > 0 });
    for (const child of children.get(deck.id) ?? []) visit(child, newAllowed, reviewAllowed);
  }
  if (selected) visit(selected, true, true);
  return scope;
}
