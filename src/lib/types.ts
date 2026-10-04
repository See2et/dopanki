import type { ScheduleState, SchedulerConfig } from './scheduler';

export interface DeckConfig {
  desiredRetention: number; parameters: number[]; learningSteps: number[];
  relearningSteps: number[]; maximumInterval: number; newPerDay: number;
  reviewPerDay?: number; fsrsEnabled: boolean; raw?: Record<string, unknown>;
}
export interface Deck { id: string; name: string; configId: string; config: DeckConfig; raw?: unknown }
export interface NoteType {
  id: string; name: string; kind: 'normal' | 'cloze'; fields: string[];
  templates: { name: string; front: string; back: string }[]; css: string;
}
export interface Note { id: string; guid: string; noteTypeId: string; fields: string[]; tags: string[]; contentFormat?: 'plain' | 'html' }
export interface ImportedCard {
  id: string; noteId: string; deckId: string; ordinal: number; type: number; queue: number;
  due: number; interval: number; easeFactor: number; reps: number; lapses: number; left: number;
  originalDue: number; originalDeckId: string; flags: number; data: string;
  stability: number | null; difficulty: number | null; lastReview: number | null;
  dueAt: number | null; raw: Record<string, unknown>;
}
export interface ImportedReview {
  id: string; cardId: string; rating: number; reviewedAt: number; interval: number;
  lastInterval: number; easeFactor: number; duration: number; type: number;
}
export interface ImportDocument {
  schemaVersion: 1;
  source: { name: string; sha256: string; importedAt: string };
  collection: { createdAt: number; timeZone: string; dayStart: number; today: number; [key: string]: unknown };
  decks: Deck[]; noteTypes: NoteType[]; notes: Note[]; cards: ImportedCard[];
  reviews: ImportedReview[]; media: { name: string; path: string }[]; warnings: string[];
}
export interface StoredCard {
  id: string; note_id: string; deck_id: string; ordinal: number; queue: number;
  due: number; state: number; schedule: string; revision: number; original: string;
  last_event_id: string | null;
}
export interface StudyCard {
  id: string; revision: number; ordinal: number; schedule: ScheduleState;
  note: Note; noteType: NoteType; deck: Deck;
  preview: Record<1 | 2 | 3 | 4, ScheduleState>;
}
export interface Counts { new: number; learning: number; review: number; total: number }
export interface DeckSummary extends Deck {
  parentId: string | null; depth: number; label: string; virtual?: boolean;
  ownCounts: Counts; ownAnsweredToday: number;
  counts: Counts; answeredToday: number;
}
export interface StudyResponse { card: StudyCard | null; counts: Counts; nextDue: number | null; answeredToday: number }
export interface ProgressResponse {
  today: string;
  days: { date: string; answers: number }[];
  totalStudyDays: number;
  weekStudyDays: number;
  todayAnswers: number;
  todayNormalAnswers?: number;
  todayPracticeAnswers?: number;
  tomorrow: {
    reviewedCards: number;
    movedBeyondTomorrow: number;
    addedForTomorrow: number;
    netReduction: number;
    dueCards: number;
  };
}
export function schedulerConfig(deck: Deck, collection: ImportDocument['collection']): SchedulerConfig {
  return { parameters: deck.config.parameters, desiredRetention: deck.config.desiredRetention,
    maximumInterval: deck.config.maximumInterval, learningSteps: deck.config.learningSteps,
    relearningSteps: deck.config.relearningSteps, timeZone: collection.timeZone, dayStart: collection.dayStart };
}
