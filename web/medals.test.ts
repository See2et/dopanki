import { describe, expect, it } from 'vitest';
import { awardMedals, createMedalState, loadMedals, MEDAL_STORAGE_KEY, revokeMedals, saveMedals, type MedalRating, type MedalState } from './medals';

function sequence(ratings: MedalRating[], initial = createMedalState()): MedalState {
  return ratings.reduce((state, rating, index) => awardMedals(state, `review-${index}`, rating).state, initial);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('session medals', () => {
  it('treats Hard, Good, and Easy equally as self-reported recall, with no Easy reward', () => {
    const state = sequence([2, 3, 4]);
    expect(state).toMatchObject({ reviewCount: 3, rememberedCount: 3, rememberedStreak: 3, againCount: 0 });
    expect(state.earnedIds).toEqual(['first-review', 'remembered-3']);
    expect(sequence([4, 4, 4]).earnedIds).toEqual(state.earnedIds);
    expect(sequence([2, 2, 2]).earnedIds).toEqual(state.earnedIds);
  });

  it('ignores retries of a confirmed-save event without replacing the latest undo snapshot', () => {
    const first = awardMedals(createMedalState(), 'same-event', 1);
    const second = awardMedals(first.state, 'next-event', 3);
    const retry = awardMedals(second.state, 'same-event', 4);
    expect(retry).toEqual({ state: second.state, newIds: [] });
    expect(first.newIds).toEqual(['first-review', 'first-again']);
    expect(revokeMedals(retry.state, 'same-event').state).toBe(retry.state);
  });

  it('resets the streak on Again and rewards honest unknown answers without requiring recall', () => {
    const recalled = sequence([2, 3, 4]);
    const again = awardMedals(recalled, 'unknown-1', 1);
    expect(again.state.rememberedStreak).toBe(0);
    expect(again.newIds).toEqual(['first-again', 'balanced']);
    const honest = awardMedals(awardMedals(again.state, 'unknown-2', 1).state, 'unknown-3', 1);
    expect(honest.newIds).toEqual(['honest-3']);
    expect(honest.state.earnedIds).toContain('remembered-3');
    expect(sequence([1, 1, 1]).earnedIds).toEqual(['first-review', 'first-again', 'honest-3']);
  });

  it('can award comeback, balance, streak milestones, and review milestones in one session', () => {
    const start = sequence([1, 2, 3]);
    expect(start.earnedIds).toEqual(['first-review', 'first-again', 'comeback']);
    const thirdRecall = awardMedals(start, 'third-recall', 4);
    expect(thirdRecall.newIds).toEqual(['remembered-3', 'balanced']);
    let state = thirdRecall.state;
    const unlocks: Record<string, string[]> = {};
    for (let index = 5; index <= 20; index++) {
      const result = awardMedals(state, `continued-${index}`, 2);
      state = result.state;
      unlocks[index] = result.newIds;
    }
    expect(unlocks[6]).toEqual(['remembered-5']);
    expect(unlocks[10]).toEqual(['reviews-10']);
    expect(unlocks[11]).toEqual(['remembered-10']);
    expect(unlocks[20]).toEqual(['reviews-20']);
    expect(awardMedals(state, 'another-recall', 4).newIds).toEqual([]);
    const simultaneous = awardMedals(sequence(Array<MedalRating>(9).fill(3)), 'tenth', 3);
    expect(simultaneous.newIds).toEqual(['remembered-10', 'reviews-10']);
  });

  it('survives reload without replaying awards and exactly restores latest progress on undo', () => {
    const storage = memoryStorage();
    const before = sequence([1, 2, 3]);
    const saved = awardMedals(before, 'undo-me', 4);
    expect(saved.newIds).toEqual(['remembered-3', 'balanced']);
    saveMedals(saved.state, storage);
    const loaded = loadMedals(storage);
    expect(loaded).toEqual(saved.state);
    expect(awardMedals(loaded, 'undo-me', 4).newIds).toEqual([]);
    const undone = revokeMedals(loaded, 'undo-me');
    expect(undone.revokedIds).toEqual(['remembered-3', 'balanced']);
    expect(undone.state).toEqual({ ...before, seenEventIds: [...before.seenEventIds, 'undo-me'], lastReview: null });
    saveMedals(undone.state, storage);
    const reloaded = loadMedals(storage);
    expect(awardMedals(reloaded, 'undo-me', 4)).toEqual({ state: reloaded, newIds: [] });
    expect(revokeMedals(reloaded, 'undo-me').revokedIds).toEqual([]);
    expect(awardMedals(reloaded, 'replacement', 2).newIds).toEqual(['remembered-3', 'balanced']);
  });

  it('undoes Again by restoring the previous streak and leaves prior earned medals intact', () => {
    const before = sequence([2, 3, 4, 2, 3]);
    const unknown = awardMedals(before, 'again', 1);
    const undone = revokeMedals(unknown.state, 'again');
    expect(undone.revokedIds).toEqual(['first-again', 'balanced']);
    expect(undone.state).toMatchObject({ rememberedStreak: 5, againCount: 0, reviewCount: 5, earnedIds: before.earnedIds });
  });

  it('starts fresh for absent, malformed, or unavailable storage and never blocks study on write failure', () => {
    const storage = memoryStorage();
    expect(loadMedals(storage)).toEqual(createMedalState());
    for (const raw of ['invalid-json', 'null', JSON.stringify({ ...createMedalState(), rememberedStreak: 5 }),
      JSON.stringify({ ...createMedalState(), seenEventIds: [42] }),
      JSON.stringify({ ...createMedalState(), earnedIds: ['unknown-medal'] })]) {
      storage.setItem(MEDAL_STORAGE_KEY, raw);
      expect(loadMedals(storage)).toEqual(createMedalState());
    }
    expect(loadMedals({ getItem: () => { throw new Error('unavailable'); } })).toEqual(createMedalState());
    expect(() => saveMedals(createMedalState(), { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
