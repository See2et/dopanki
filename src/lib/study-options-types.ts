/** Admission controls never replace a card's FSRS due date or memory state. */
export interface RestartStatus {
  id: string; revision: number; dailyReviewLimit: number; dailyNewLimit: number; backlogPerDay: number;
  paused: boolean; flattened: boolean; backlogTotal: number; backlogRemaining: number;
  backlogToday: number; days: { date: string; cards: number }[];
}
export interface StudyOptionsResponse {
  deckId: string; studyDay: string; limits: { new: number; review: number };
  /** Genuinely due, unsuspended cards before daily quotas and deferred plan admission. */
  available: { new: number; review: number }; extra: { new: number; review: number };
  restart: RestartStatus | null;
}
export interface RestartPreview {
  token: string; days: { date: string; cards: number }[]; total: number;
  delayedCards: number; maxDelayDays: number;
}
export interface ExtraStudyRequest { requestId: string; new: number; review: number }
export interface RestartRequest {
  requestId: string; dailyReviewLimit: number; dailyNewLimit?: number; backlogPerDay: number; flatten: boolean;
  previewToken?: string;
}
export interface RestartStateRequest { requestId: string; restartId: string; revision: number; action: 'pause' | 'resume' | 'cancel' | 'set-new-limit'; dailyNewLimit?: number }
