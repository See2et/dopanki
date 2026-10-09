import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, nextStudyDayBoundary, preview, reconstructMemory, schedule, studyDate, studyDayBoundary, validateConfig, type ScheduleState, type SchedulerConfig } from '../src/lib/scheduler';

const minute = 60_000;
const now = Date.parse('2026-10-03T12:00:00Z');
function card(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return { state: 0, due: now, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0,
    reps: 0, lapses: 0, lastReview: null, learningSteps: 0, ...overrides };
}
function config(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return { ...defaultConfig(), ...overrides };
}

// Independent reference: fsrs-rs 6.6.2 FSRS::next_states(Some(S=20,D=5),0.9,20),
// run natively with these three parameter vectors. Expected floats allow Rust f32 rounding.
// https://github.com/open-spaced-repetition/fsrs-rs/blob/main/src/inference.rs
const reference = [
  {
    version: 4,
    parameters: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
    stability: [4.142132, 30.005375, 54.501297, 110.04838],
    difficulty: [6.4859, 5.7379003, 4.9899, 4.2419],
    intervals: [4, 30, 55, 110], sameDayGood: 20,
  },
  {
    version: 5,
    parameters: [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
      1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621],
    stability: [2.9825492, 29.785015, 62.267883, 146.37251],
    difficulty: [6.607035, 5.7994337, 4.9918327, 4.1842318],
    intervals: [3, 30, 62, 146], sameDayGood: 28.155424,
  },
  {
    version: 6, parameters: defaultConfig().parameters,
    stability: [1.9435812, 43.60436, 59.24902, 93.50948],
    difficulty: [8.341763, 6.6659956, 4.990228, 3.3144615],
    intervals: [2, 44, 59, 94], sameDayGood: 20,
  },
];

describe('FSRS memory and scheduling', () => {
  it.each(reference)('preserves FSRS-$version parameter semantics against Rust reference values', fixture => {
    const settings = config({ parameters: fixture.parameters, learningSteps: [], relearningSteps: [] });
    const review = card({ state: 2, stability: 20, difficulty: 5, reps: 8, lapses: 2,
      lastReview: now - 20 * 86_400_000, scheduledDays: 20 });
    const result = preview(review, now, settings);
    for (const rating of [1, 2, 3, 4] as const) {
      expect(result[rating].stability).toBeCloseTo(fixture.stability[rating - 1], 3);
      expect(result[rating].difficulty).toBeCloseTo(fixture.difficulty[rating - 1], 4);
      expect(result[rating].scheduledDays).toBe(fixture.intervals[rating - 1]);
      expect(result[rating].elapsedDays).toBe(20);
      expect(result[rating].reps).toBe(9);
      expect(result[rating].lapses).toBe(rating === 1 ? 3 : 2);
      expect(schedule(review, rating, now, settings)).toEqual(result[rating]);
    }
    const sameDay = schedule({ ...review, lastReview: now }, 3, now + minute, settings);
    expect(sameDay.stability).toBeCloseTo(fixture.sameDayGood, 4);
  });

  it('initializes an unknown memory state from the selected rating and preserves small stability weights', () => {
    const settings = config();
    const good = schedule(card(), 3, now, settings);
    expect(good.stability).toBe(2.3065);
    expect(good.difficulty).toBeCloseTo(2.118104, 5);
    const parameters = [...settings.parameters];
    parameters[0] = 0.01;
    const again = schedule(card(), 1, now, config({ parameters }));
    expect(again.stability).toBe(0.01);
    expect(again.due).toBe(now + minute);
  });

  it('keeps the maximum interval even when answer intervals cannot be distinct', () => {
    const review = card({ state: 2, stability: 100, difficulty: 5, lastReview: now - 86_400_000 });
    const answers = preview(review, now, config({ maximumInterval: 1, relearningSteps: [] }));
    for (const answer of Object.values(answers)) expect(answer.scheduledDays).toBe(1);
  });

  it('is deterministic and does not mutate cards or imported settings', () => {
    const state = card();
    const settings = config();
    const before = structuredClone({ state, settings });
    expect(preview(state, now, settings)).toEqual(preview(state, now, settings));
    expect({ state, settings }).toEqual(before);
  });
});

describe('Anki learning and relearning steps', () => {
  it('uses fractional minutes for the first Hard delay and advances Good to the next step', () => {
    const answers = preview(card(), now, config());
    expect(answers[1]).toMatchObject({ state: 1, learningSteps: 0, due: now + minute, scheduledDays: 0 });
    expect(answers[2]).toMatchObject({ state: 1, learningSteps: 0, due: now + 5.5 * minute });
    expect(answers[3]).toMatchObject({ state: 1, learningSteps: 1, due: now + 10 * minute });
    expect(answers[4]).toMatchObject({ state: 2, learningSteps: 0 });
  });

  it('continues the imported current step, resets Again, repeats Hard and graduates Good', () => {
    const learning = card({ state: 1, stability: 2.3065, difficulty: 2.118104, lastReview: now - minute,
      learningSteps: 2, reps: 2 });
    const settings = config({ learningSteps: [1, 10, 30] });
    const answers = preview(learning, now, settings);
    expect(answers[1]).toMatchObject({ state: 1, learningSteps: 0, due: now + minute });
    expect(answers[2]).toMatchObject({ state: 1, learningSteps: 2, due: now + 30 * minute });
    expect(answers[3]).toMatchObject({ state: 2, learningSteps: 0 });
    expect(answers[4]).toMatchObject({ state: 2, learningSteps: 0 });
  });

  it('counts only review failures as lapses and uses the relearning steps', () => {
    const review = card({ state: 2, stability: 20, difficulty: 5, lastReview: now - 86_400_000, lapses: 2 });
    const settings = config({ relearningSteps: [5, 20] });
    const again = schedule(review, 1, now, settings);
    expect(again).toMatchObject({ state: 3, learningSteps: 0, due: now + 5 * minute, lapses: 3 });
    const good = schedule(again, 3, again.due, settings);
    expect(good).toMatchObject({ state: 3, learningSteps: 1, due: again.due + 20 * minute, lapses: 3 });
    const failed = schedule(good, 1, good.due, settings);
    expect(failed).toMatchObject({ state: 3, learningSteps: 0, lapses: 3 });
    expect(schedule(good, 3, good.due, settings)).toMatchObject({ state: 2, learningSteps: 0, lapses: 3 });
  });

  it('keeps day-long steps in learning until completion', () => {
    const settings = config({ learningSteps: [1, 1440] });
    const good = schedule(card(), 3, now, settings);
    expect(good).toMatchObject({ state: 1, learningSteps: 1, scheduledDays: 1 });
    expect(good.due).toBe(Date.parse('2026-10-03T19:00:00Z')); // Oct 4 04:00 JST
    expect(schedule(good, 3, good.due, settings).state).toBe(2);
  });

  it('uses FSRS short-term scheduling with empty steps', () => {
    const again = schedule(card(), 1, now, config({ learningSteps: [] }));
    expect(again).toMatchObject({ state: 1, scheduledDays: 0, stability: 0.212 });
    expect(again.due - now).toBe(18_316_000); // floor(0.212 days * 86400) seconds
    expect(schedule(card(), 3, now, config({ learningSteps: [] })).state).toBe(2);
  });
});

describe('study-day calendar', () => {
  const settings = config({ timeZone: 'Asia/Tokyo', dayStart: 4, maximumInterval: 1 });
  it('exposes the current and next local rollover to daily queue limits', () => {
    const before = Date.parse('2026-10-02T18:59:59Z'); // 03:59:59 JST
    const boundary = Date.parse('2026-10-02T19:00:00Z');
    expect(studyDayBoundary(before, 'Asia/Tokyo', 4)).toBe(Date.parse('2026-10-01T19:00:00Z'));
    expect(nextStudyDayBoundary(before, 'Asia/Tokyo', 4)).toBe(boundary);
    expect(studyDayBoundary(boundary, 'Asia/Tokyo', 4)).toBe(boundary);
    expect(nextStudyDayBoundary(boundary, 'Asia/Tokyo', 4)).toBe(Date.parse('2026-10-03T19:00:00Z'));
  });

  it('shares the forward-gap and earlier-overlap rollover rules with queue boundaries', () => {
    const gap = Date.parse('2026-03-08T07:30:00Z'); // 03:30 EDT
    expect(studyDayBoundary(gap, 'America/New_York', 2)).toBe(Date.parse('2026-03-08T07:00:00Z'));
    expect(nextStudyDayBoundary(Date.parse('2026-03-07T17:00:00Z'), 'America/New_York', 2))
      .toBe(Date.parse('2026-03-08T07:00:00Z'));
    const overlap = Date.parse('2026-11-01T06:30:00Z'); // second 01:30, EST
    expect(studyDayBoundary(overlap, 'America/New_York', 1)).toBe(Date.parse('2026-11-01T05:00:00Z'));
    expect(nextStudyDayBoundary(overlap, 'America/New_York', 1)).toBe(Date.parse('2026-11-02T06:00:00Z'));
  });
  it('counts rollover crossings rather than whole 24-hour durations', () => {
    const lastReview = Date.parse('2026-10-02T18:59:00Z'); // Oct 3 03:59 JST
    const reviewedAt = Date.parse('2026-10-02T19:01:00Z'); // Oct 3 04:01 JST
    const next = schedule(card({ state: 2, stability: 20, difficulty: 5, lastReview }), 3, reviewedAt, settings);
    expect(next.elapsedDays).toBe(1);
    expect(next.due).toBe(Date.parse('2026-10-03T19:00:00Z')); // next local 04:00
    const before = schedule(card(), 4, lastReview, settings);
    expect(before.due).toBe(Date.parse('2026-10-02T19:00:00Z'));
  });

  it('keeps a short learning delay in real minutes across the day boundary', () => {
    const reviewedAt = Date.parse('2026-10-02T18:59:30Z');
    expect(schedule(card(), 1, reviewedAt, settings).due).toBe(reviewedAt + minute);
  });

  it('handles a 23-hour DST day without adding 24 hours', () => {
    const spring = Date.parse('2026-03-07T17:00:00Z'); // noon EST
    const next = schedule(card({ state: 2, stability: 20, difficulty: 5,
      lastReview: Date.parse('2026-03-07T09:00:00Z') }), 3, spring,
      config({ timeZone: 'America/New_York', dayStart: 4, maximumInterval: 1 }));
    expect(next.due).toBe(Date.parse('2026-03-08T08:00:00Z')); // 04:00 EDT
  });

  it('resolves a missing rollover hour forward and an ambiguous hour to the earlier instant', () => {
    const dstConfig = config({ timeZone: 'America/New_York', dayStart: 2, maximumInterval: 1 });
    expect(schedule(card(), 4, Date.parse('2026-03-07T17:00:00Z'), dstConfig).due)
      .toBe(Date.parse('2026-03-08T07:00:00Z')); // nonexistent 02:00 becomes 03:00 EDT
    expect(schedule(card(), 4, Date.parse('2026-10-31T16:00:00Z'), { ...dstConfig, dayStart: 1 }).due)
      .toBe(Date.parse('2026-11-01T05:00:00Z')); // first 01:00, EDT
  });
});

describe('calendar CPU resource regression', () => {
  it('reuses timezone formatters for large restart calendars without mixing zones or accepting invalid settings', () => {
    const constructors = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      // Production restart calendars have ~1,000 members. Bound expensive Intl
      // construction rather than wall-clock duration, which varies across hosts.
      for (let i = 0; i < 1000; i++) {
        expect(studyDate(now, 'Pacific/Chatham', 4)).toBe('2026-10-03');
        expect(studyDate(now, 'Pacific/Honolulu', 4)).toBe('2026-10-02');
      }
      expect(constructors.mock.calls.length).toBeLessThanOrEqual(2);
      expect(() => validateConfig(config({ timeZone: 'Invalid/Timezone' }))).toThrow();
      expect(studyDate(now, 'Pacific/Chatham', 4)).toBe('2026-10-03');
    } finally {
      constructors.mockRestore();
    }
  });
});

describe('external configuration and state validation', () => {
  it.each([
    { parameters: [1, 2, 3] }, { parameters: [...defaultConfig().parameters.slice(0, 20), NaN] },
    { parameters: [-1, ...defaultConfig().parameters.slice(1)] },
    { desiredRetention: 0 }, { desiredRetention: 1 }, { desiredRetention: Infinity },
    { maximumInterval: 0 }, { maximumInterval: 36_501 }, { maximumInterval: 2.5 },
    { learningSteps: [0] }, { relearningSteps: [Infinity] },
    { timeZone: 'Moon/SeaOfTranquility' }, { timeZone: '' }, { dayStart: 24 }, { dayStart: 4.5 },
  ])('rejects invalid settings %j', overrides => {
    expect(() => validateConfig(config(overrides))).toThrow();
  });

  it('accepts empty/default parameters without changing the input', () => {
    const settings = config({ parameters: [] });
    validateConfig(settings);
    expect(schedule(card(), 3, now, settings).stability).toBe(2.3065);
    expect(settings.parameters).toEqual([]);
  });

  it('rejects invalid ratings, inconsistent memory and reviews earlier than the last review', () => {
    expect(() => schedule(card(), 5 as 4, now, config())).toThrow('Rating');
    expect(() => schedule(card({ difficulty: 5 }), 3, now, config())).toThrow('state');
    expect(() => schedule(card({ lastReview: now + minute }), 3, now, config())).toThrow('Last review');
  });
});

describe('missing imported memory', () => {
  it('approximates current SM-2 memory against the official fsrs-rs reference without resetting it', () => {
    // fsrs-rs 6.6.2 inference.rs::test_memory_from_sm2 expected [10, 6.9140563].
    const memory = reconstructMemory({ interval: 10, easeFactor: 2.5 }, config());
    expect(memory).toMatchObject({ stability: 10, source: 'sm2' });
    expect(memory.difficulty).toBeCloseTo(6.9140563, 4);
    expect(reconstructMemory({ interval: 20, easeFactor: 1.3 }, config()))
      .toEqual({ stability: 20, difficulty: 10, source: 'sm2' });
    const imported = card({ state: 2, scheduledDays: 10, lastReview: now - 10 * 86_400_000,
      stability: memory.stability, difficulty: memory.difficulty });
    expect(schedule(imported, 3, now, config()).stability).toBeGreaterThan(10);
  });

  it('replays only explicitly complete rated history, using the native Rust kernel fixture', () => {
    const start = now - 2 * 86_400_000;
    const memory = reconstructMemory({ interval: 0, easeFactor: 0, historyComplete: true,
      reviews: [{ rating: 3, reviewedAt: start, type: 0 },
        { rating: 3, reviewedAt: start + minute, type: 0 },
        { rating: 4, reviewedAt: now, type: 1 }] }, config());
    // Independently computed fsrs-rs replay [(Good,0), (Good,0), (Easy,2)].
    expect(memory.stability).toBeCloseTo(18.53435, 4);
    expect(memory).toMatchObject({ difficulty: 1, source: 'history' });
  });

  it('estimates partial history from current SM-2 values instead of pretending the first surviving review was new', () => {
    const input = { interval: 10, easeFactor: 2.5,
      reviews: [{ rating: 1, reviewedAt: now, type: 1 }] };
    expect(reconstructMemory(input, config())).toEqual(reconstructMemory({ interval: 10, easeFactor: 2.5 }, config()));
    expect(() => reconstructMemory({ ...input, historyComplete: true }, config())).toThrow('start');
  });

  it('rejects unresolved reset/manual boundaries and learned cards with no usable reconstruction data', () => {
    expect(() => reconstructMemory({ interval: 0, easeFactor: 0 }, config())).toThrow('requires complete history');
    expect(() => reconstructMemory({ interval: 10, easeFactor: 2.5, historyComplete: true,
      reviews: [{ rating: 3, reviewedAt: now - minute, type: 0 }, { rating: 0, reviewedAt: now, type: 4 }] }, config()))
      .toThrow('reset boundaries');
    expect(() => schedule(card({ state: 2 }), 3, now, config())).toThrow('Missing learned FSRS memory');
  });
});
