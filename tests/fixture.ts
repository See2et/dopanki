import type { ImportDocument } from '../src/lib/types';
import { defaultConfig } from '../src/lib/scheduler';

export function fixture(): ImportDocument {
  const config = defaultConfig();
  return {
    schemaVersion: 1, source: { name: 'sample.apkg', sha256: 'a'.repeat(64), importedAt: '2026-10-03T00:00:00Z' },
    collection: { createdAt: 1638986400, timeZone: 'Asia/Tokyo', dayStart: 4, today: 1759 },
    decks: [{ id: '1', name: '韓国語', configId: '1', config: { ...config, fsrsEnabled: true, newPerDay: 20, reviewPerDay: 200 } }],
    noteTypes: [{ id: '1', name: 'Basic', kind: 'normal', fields: ['JP','KR'], css: '.card { font-size: 24px; }',
      templates: [{ name: 'JP → KR', front: '{{JP}} {{type:KR}}', back: '{{JP}}<hr>{{tts ko_KR voices=AwesomeTTS:KR}}{{type:KR}}' }] }],
    notes: [{ id: '1', guid: 'sample', noteTypeId: '1', fields: ['こんにちは','안녕하세요'], tags: [] }],
    cards: [{ id: '1', noteId: '1', deckId: '1', ordinal: 0, type: 2, queue: 2, due: 1000, interval: 21, easeFactor: 2500,
      reps: 10, lapses: 1, left: 0, originalDue: 0, originalDeckId: '0', flags: 0, data: '{"s":21,"d":4}',
      stability: 21, difficulty: 4, lastReview: Date.parse('2026-07-01T00:00:00Z'), dueAt: Date.parse('2026-07-22T19:00:00Z'), raw: {} }],
    reviews: [{ id: '1751328000000', cardId: '1', rating: 3, reviewedAt: Date.parse('2026-07-01T00:00:00Z'), interval: 21, lastInterval: 10, easeFactor: 2500, duration: 3000, type: 1 }],
    media: [], warnings: [],
  };
}
