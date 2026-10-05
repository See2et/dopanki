import type { StudyResponse } from './types';
export interface PracticeSession {
  id: string;
  name: string;
  round: number;
  position: number;
  total: number;
  order: 'deck' | 'shuffle';
  deckIds: string[];
}
export interface PracticeSummary {
  id: string;
  name: string;
  round: number;
  position: number;
  total: number;
  revision: number;
  againCount: number;
  lastEventId: string | null;
}
export interface PracticeStudyResponse extends Omit<StudyResponse, 'studyDayBoundary' | 'learningPending' | 'nextLearningDue' | 'candidateIds' | 'focusRemainingIds'> {
  practice: PracticeSummary;
}
