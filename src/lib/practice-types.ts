import type { StudyResponse } from './types';
export interface PracticeSession {
  id: string;
  name: string;
  round: number;
  /** Cards completed in this round, not the number of answers. */
  position: number;
  total: number;
  order: 'deck' | 'shuffle';
  deckIds: string[];
}
export interface PracticeSummary {
  id: string;
  name: string;
  round: number;
  /** Cards completed in this round, not the number of answers. */
  position: number;
  total: number;
  revision: number;
  /** Distinct cards rated Again at least once this round, excluding undone answers. */
  againCount: number;
  lastEventId: string | null;
}
export interface PracticeStudyResponse extends Omit<StudyResponse, 'studyDayBoundary' | 'learningPending' | 'nextLearningDue' | 'candidateIds' | 'focusRemainingIds'> {
  practice: PracticeSummary;
}
