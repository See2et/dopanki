import { FSRSAlgorithm, default_w, forgetting_curve, type Grade } from 'ts-fsrs';

export type ScheduleState = {
  /** Anki/FSRS: New=0, Learning=1, Review=2, Relearning=3. */
  state: number;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
  /** Zero-based current step index; Anki remaining steps must be converted on import. */
  learningSteps: number;
};

export type SchedulerConfig = {
  /** [] uses the standard defaults; 17/19/21 retain FSRS-4/5/6 parameter meaning. */
  parameters: number[];
  desiredRetention: number;
  maximumInterval: number;
  /** Durations in minutes, including fractional minutes. [] enables FSRS short-term scheduling. */
  learningSteps: number[];
  relearningSteps: number[];
  timeZone: string;
  /** Local hour at which the study day starts (Anki rollover). */
  dayStart: number;
};

const DAY = 86_400_000;
const MINUTE = 60_000;
const MAX_INTERVAL = 36_500;
const ratings = [1, 2, 3, 4] as const;

export function defaultConfig(): SchedulerConfig {
  return {
    parameters: [...default_w], desiredRetention: 0.9, maximumInterval: MAX_INTERVAL,
    learningSteps: [1, 10], relearningSteps: [10], timeZone: 'Asia/Tokyo', dayStart: 4,
  };
}

export function validateConfig(config: SchedulerConfig): void {
  if (!Array.isArray(config.parameters) || ![0, 17, 19, 21].includes(config.parameters.length)) {
    throw new Error('FSRS parameters must contain 17, 19 or 21 weights, or be empty for defaults');
  }
  if (config.parameters.some(w => !Number.isFinite(w) || w < 0 || w > 100)) {
    throw new Error('FSRS parameters must be finite nonnegative weights no greater than 100');
  }
  const w = config.parameters;
  if (w.length && (w.slice(0, 4).some(s => s < 0.001) || w[4] < 1 || w[4] > 10 ||
    w[5] > 4 || w[7] > 1 || w[15] > 1 ||
    (w.length === 21 && (w[20] <= 0 || w[20] > 1)))) {
    throw new Error('Invalid FSRS stability, difficulty, decay or probability weights');
  }
  if (!Number.isFinite(config.desiredRetention) || config.desiredRetention <= 0 || config.desiredRetention >= 1) {
    throw new Error('Desired retention must be between 0 and 1, exclusively');
  }
  if (!Number.isInteger(config.maximumInterval) || config.maximumInterval < 1 || config.maximumInterval > MAX_INTERVAL) {
    throw new Error(`Maximum interval must be an integer from 1 to ${MAX_INTERVAL} days`);
  }
  for (const steps of [config.learningSteps, config.relearningSteps]) {
    if (!Array.isArray(steps) || steps.length > 999 || steps.some(step =>
      !Number.isFinite(step) || step < 1 / 60 || step > MAX_INTERVAL * 1440)) {
      throw new Error('Learning steps must be finite durations of at least one second in minutes');
    }
  }
  if (!Number.isInteger(config.dayStart) || config.dayStart < 0 || config.dayStart > 23) {
    throw new Error('Day start must be an integer local hour from 0 to 23');
  }
  try {
    formatter(config.timeZone).format(0);
  } catch {
    throw new Error('Invalid IANA time zone');
  }
}

/**
 * Parameter conversion follows fsrs-rs check_and_fill_parameters(), not padding with defaults.
 * https://github.com/open-spaced-repetition/fsrs-rs/blob/main/src/model.rs
 * ts-fsrs's normal constructor clips imported weights (including legacy w19=0).
 * This narrow kernel adapter preserves them and uses the library's memory/interval algorithms.
 */
class ImportedParameterKernel extends FSRSAlgorithm {
  constructor(config: SchedulerConfig) {
    super({ enable_fuzz: false });
    const w = config.parameters.length ? [...config.parameters] : [...default_w];
    if (w.length === 17) {
      const slope = w[5];
      w[4] += 2 * slope;
      w[5] = Math.log(3 * slope + 1) / 3;
      w[6] += 0.5;
      w.push(0, 0, 0, 0.5);
    } else if (w.length === 19) {
      w.push(0, 0.5);
    }
    this.param = {
      w, request_retention: config.desiredRetention, maximum_interval: config.maximumInterval,
      enable_fuzz: false, enable_short_term: true, learning_steps: [], relearning_steps: [],
    };
    this.intervalModifier = this.calculate_interval_modifier(config.desiredRetention);
    this.forgetting_curve = (elapsed, stability) => forgetting_curve(w, elapsed, stability);
  }

  // Anki/fsrs-rs supports initial stability down to 0.001 days; ts-fsrs defaults to 0.1.
  override init_stability(rating: Grade): number {
    return this.parameters.w[rating - 1];
  }
}

export type MemoryReconstructionInput = {
  interval: number;
  /** SM-2 ease multiplier, e.g. 2.5; divide Anki's stored factor by 1000 first. */
  easeFactor: number;
  reviews?: { rating: number; reviewedAt: number; type: number }[];
  /** Caller guarantees the supplied rated history begins at initial learning after the latest reset. */
  historyComplete?: boolean;
};

/**
 * Reconstruct missing memory without changing imported due dates or counters.
 * A partial history is never replayed from a new-card state. Instead, positive current
 * SM-2 interval/ease values use fsrs-rs 6.6.2 memory_state_from_sm2(), assuming 90% retention.
 * Complete history must exclude manual/rescheduling records and precede any later reset.
 */
export function reconstructMemory(input: MemoryReconstructionInput, config: SchedulerConfig): {
  stability: number; difficulty: number; source: 'history' | 'sm2';
} {
  validateConfig(config);
  const kernel = new ImportedParameterKernel(config);
  if (input.historyComplete) {
    const reviews = input.reviews ?? [];
    if (!reviews.length || reviews[0].type !== 0) {
      throw new Error('Complete review history must start with a learning review');
    }
    const format = formatter(config.timeZone);
    let memory: { stability: number; difficulty: number } | null = null;
    let lastReview: number | null = null;
    for (const review of reviews) {
      if (!ratings.includes(review.rating as Grade) || !Number.isInteger(review.type) || review.type < 0 || review.type > 3 ||
        !Number.isFinite(review.reviewedAt) || !Number.isFinite(new Date(review.reviewedAt).getTime()) ||
        (lastReview !== null && review.reviewedAt < lastReview)) {
        throw new Error('History replay requires chronological rated reviews with reset boundaries already resolved');
      }
      const elapsed = lastReview === null ? 0 : Math.max(0,
        studyDay(review.reviewedAt, config, format) - studyDay(lastReview, config, format));
      memory = kernel.next_state(memory, elapsed, review.rating);
      lastReview = review.reviewedAt;
    }
    if (!memory || !Number.isFinite(memory.stability) || !Number.isFinite(memory.difficulty)) {
      throw new Error('History produced an invalid FSRS memory state');
    }
    return { ...memory, source: 'history' };
  }
  if (!Number.isFinite(input.interval) || input.interval <= 0 || input.interval > MAX_INTERVAL ||
    !Number.isFinite(input.easeFactor) || input.easeFactor < 1.3 || input.easeFactor > 10) {
    throw new Error('Missing learned FSRS memory requires complete history or a positive SM-2 interval and ease factor');
  }
  // At sm2_retention=0.9, the official conversion's stability factor cancels exactly.
  const stability = Math.max(0.001, input.interval);
  const w = kernel.parameters.w;
  const difficulty = 11 - (input.easeFactor - 1) /
    (Math.exp(w[8]) * Math.pow(stability, -w[9]) * Math.expm1(0.1 * w[10]));
  if (!Number.isFinite(difficulty)) throw new Error('SM-2 values cannot be represented by these FSRS parameters');
  return { stability, difficulty: Math.max(1, Math.min(10, difficulty)), source: 'sm2' };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new Error('Missing time zone');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function wallTime(timestamp: number, format: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

function studyDay(timestamp: number, config: Pick<SchedulerConfig, 'dayStart'>, format: Intl.DateTimeFormat): number {
  return Math.floor((wallTime(timestamp, format) - config.dayStart * 3_600_000) / DAY);
}

/** Resolve a local rollover across DST: earlier instant in overlaps, forward shift in gaps. */
function rollover(day: number, config: Pick<SchedulerConfig, 'dayStart'>, format: Intl.DateTimeFormat): number {
  const target = day * DAY + config.dayStart * 3_600_000;
  const offsets = new Set([-36, 0, 36].map(hours => {
    const probe = target + hours * 3_600_000;
    return wallTime(probe, format) - probe;
  }));
  const candidates = [...offsets].map(offset => target - offset)
    .map(timestamp => ({ timestamp, delta: wallTime(timestamp, format) - target }))
    .filter(candidate => candidate.delta >= 0)
    .sort((a, b) => a.delta - b.delta || a.timestamp - b.timestamp);
  if (!candidates.length) throw new Error('Unable to resolve the local study-day rollover');
  return candidates[0].timestamp;
}

function calendarBoundary(now: number, timeZone: string, dayStart: number, next: boolean): number {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new Error('Invalid study-day timestamp');
  }
  if (!Number.isInteger(dayStart) || dayStart < 0 || dayStart > 23) {
    throw new Error('Day start must be an integer local hour from 0 to 23');
  }
  const format = formatter(timeZone);
  const day = studyDay(now, { dayStart }, format);
  return rollover(day + (next ? 1 : 0), { dayStart }, format);
}

/** Start of the current study day, using the same calendar as FSRS scheduling. */
export function studyDayBoundary(now: number, timeZone: string, dayStart: number): number {
  return calendarBoundary(now, timeZone, dayStart, false);
}

/** Start of the following study day; it may be 23 or 25 hours after this day's start. */
export function nextStudyDayBoundary(now: number, timeZone: string, dayStart: number): number {
  return calendarBoundary(now, timeZone, dayStart, true);
}

function validateState(state: ScheduleState, now: number): void {
  if (state.state !== 0 && state.stability === 0 && state.difficulty === 0) {
    throw new Error('Missing learned FSRS memory: reconstruct memory before scheduling this card');
  }
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) ||
    !Number.isInteger(state.state) || state.state < 0 || state.state > 3 ||
    !Number.isFinite(state.due) || !Number.isFinite(new Date(state.due).getTime()) ||
    !Number.isFinite(state.stability) || state.stability < 0 || state.stability > MAX_INTERVAL ||
    !Number.isFinite(state.difficulty) || state.difficulty < 0 || state.difficulty > 10 ||
    (state.stability === 0) !== (state.difficulty === 0) ||
    (state.stability > 0 && (state.stability < 0.001 || state.difficulty < 1))) {
    throw new Error('Invalid card scheduling state or review time');
  }
  for (const count of [state.elapsedDays, state.scheduledDays, state.reps, state.lapses, state.learningSteps]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid card scheduling counters');
  }
  if (state.lastReview !== null && (!Number.isFinite(state.lastReview) ||
    !Number.isFinite(new Date(state.lastReview).getTime()) || state.lastReview > now)) {
    throw new Error('Last review must be a valid timestamp no later than this review');
  }
}

function outcomes(state: ScheduleState, now: number, config: SchedulerConfig): Record<1 | 2 | 3 | 4, ScheduleState> {
  validateConfig(config);
  validateState(state, now);
  const format = formatter(config.timeZone);
  const today = studyDay(now, config, format);
  const elapsedDays = state.lastReview === null ? 0 : Math.max(0, today - studyDay(state.lastReview, config, format));
  const kernel = new ImportedParameterKernel(config);
  const memory = state.stability === 0 ? null : { stability: state.stability, difficulty: state.difficulty };
  const nextMemory = ratings.map(rating => kernel.next_state(memory, elapsedDays, rating));
  const intervals: number[] = nextMemory.map(next => kernel.next_interval(next.stability, elapsedDays));
  const bounded = (interval: number) => Math.min(config.maximumInterval, Math.max(1, interval));
  // Distinct answer intervals where possible, without exceeding the configured maximum.
  if (state.state === 2) {
    intervals[1] = Math.min(intervals[1], intervals[2]);
    intervals[2] = bounded(Math.max(intervals[2], intervals[1] + 1));
  }
  intervals[3] = bounded(Math.max(intervals[3], intervals[2] + 1));
  const steps = state.state === 2 || state.state === 3 ? config.relearningSteps : config.learningSteps;
  // Deck settings may have changed since import; keep a valid last-step position.
  const currentStep = Math.min(state.learningSteps, Math.max(0, steps.length - 1));
  const result = {} as Record<1 | 2 | 3 | 4, ScheduleState>;
  for (const rating of ratings) {
    const next = nextMemory[rating - 1];
    if (!Number.isFinite(next.stability) || !Number.isFinite(next.difficulty)) {
      throw new Error('FSRS parameters produced an invalid memory state');
    }
    const interval = intervals[rating - 1];
    let stepMinutes: number | undefined;
    let nextStep = currentStep;
    const learning = state.state !== 2 || rating === 1;
    const learningState = state.state === 2 || state.state === 3 ? 3 : 1;
    if (learning && steps.length && rating !== 4) {
      if (rating === 1) {
        stepMinutes = steps[0];
        nextStep = 0;
      } else if (rating === 2) {
        stepMinutes = currentStep === 0
          ? steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440)
          : steps[currentStep];
      } else if (currentStep + 1 < steps.length) {
        stepMinutes = steps[currentStep + 1];
        nextStep = currentStep + 1;
      }
    } else if (learning && !steps.length && rating !== 4) {
      // Current Anki: empty steps permit automatic FSRS intraday intervals (< half a day).
      const rawInterval = next.stability * kernel.interval_modifier;
      if (rawInterval < 0.5) stepMinutes = Math.max(1 / 60, rawInterval * 1440);
      nextStep = 0;
    }
    let due = rollover(today + interval, config, format);
    let scheduledDays = interval;
    let nextState = 2;
    if (stepMinutes !== undefined) {
      nextState = learningState;
      if (stepMinutes >= 1440) {
        scheduledDays = Math.max(1, Math.round(stepMinutes / 1440));
        due = rollover(today + scheduledDays, config, format);
      } else {
        scheduledDays = 0;
        due = now + Math.floor(stepMinutes * 60) * 1000;
      }
    }
    result[rating] = {
      state: nextState, due, stability: next.stability, difficulty: next.difficulty,
      elapsedDays, scheduledDays, reps: state.reps + 1,
      lapses: state.lapses + (state.state === 2 && rating === 1 ? 1 : 0),
      lastReview: now, learningSteps: nextState === 2 ? 0 : nextStep,
    };
  }
  return result;
}

/** Deterministic: no interval fuzz, so the preview is the exact result at the same timestamp. */
export function preview(state: ScheduleState, now: number, config: SchedulerConfig): Record<1 | 2 | 3 | 4, ScheduleState> {
  return outcomes(state, now, config);
}

export function schedule(state: ScheduleState, rating: 1 | 2 | 3 | 4, now: number, config: SchedulerConfig): ScheduleState {
  if (!ratings.includes(rating)) throw new Error('Rating must be Again=1, Hard=2, Good=3 or Easy=4');
  return outcomes(state, now, config)[rating];
}

/** The same imported-parameter adapter and local study calendar used by actual scheduling. */
export function retrievabilities(states: ScheduleState[], now: number, config: SchedulerConfig): number[] {
  validateConfig(config);
  const format=formatter(config.timeZone);
  const today=studyDay(now,config,format);
  const kernel=new ImportedParameterKernel(config);
  return states.map(state=>{
    if(state.lastReview===null||state.stability<=0)return 0;
    const elapsed=Math.max(0,today-studyDay(state.lastReview,config,format));
    return kernel.forgetting_curve(elapsed,state.stability);
  });
}
export function retrievability(state: ScheduleState, now: number, config: SchedulerConfig): number {
  return retrievabilities([state],now,config)[0];
}
/** Calendar label of the collection study day, including dates before local rollover. */
export function studyDate(now: number, timeZone: string, dayStart: number): string {
  return new Date(studyDay(now,{ dayStart },formatter(timeZone)) * DAY).toISOString().slice(0,10);
}
