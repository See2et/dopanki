import type { ImportDocument, ImportedCard, Deck } from './types';
import { schedulerConfig } from './types';
import { validateConfig, reconstructMemory, type ScheduleState } from './scheduler';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string';
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`取り込みデータが不正です: ${message}`);
}
function unique(items: unknown[], field: string, label: string): Set<string> {
  const seen = new Set<string>();
  for (const item of items) {
    requireValue(object(item) && id(item[field]), `${label}のID`);
    requireValue(!seen.has(item[field] as string), `${label}の重複ID`);
    seen.add(item[field] as string);
  }
  return seen;
}
export function validateImport(value: unknown): asserts value is ImportDocument {
  requireValue(object(value) && value.schemaVersion === 1, 'schemaVersion');
  requireValue(object(value.source) && text(value.source.name) && /^[a-f0-9]{64}$/.test(String(value.source.sha256)), 'source');
  requireValue(object(value.collection) && finite(value.collection.createdAt) && text(value.collection.timeZone), 'collection');
  const c = value.collection as unknown as ImportDocument['collection'];
  requireValue(Number.isInteger(c.dayStart) && c.dayStart >= 0 && c.dayStart <= 23, '日境界');
  new Intl.DateTimeFormat('en', { timeZone: c.timeZone }).format();
  for (const key of ['decks', 'noteTypes', 'notes', 'cards', 'reviews', 'media', 'warnings']) {
    requireValue(Array.isArray(value[key]), key);
  }
  const d = value as unknown as ImportDocument;
  requireValue(d.cards.length > 0 && d.cards.length <= 50000 && d.reviews.length <= 1000000, 'カード／履歴の件数');
  const decks = unique(d.decks, 'id', 'デッキ');
  const types = unique(d.noteTypes, 'id', 'ノートタイプ');
  const notes = unique(d.notes, 'id', 'ノート');
  const cards = unique(d.cards, 'id', 'カード');
  unique(d.reviews, 'id', '履歴');
  for (const deck of d.decks) {
    requireValue(text(deck.name) && object(deck.config), 'デッキ設定');
    validateConfig(schedulerConfig(deck, c));
    requireValue(Number.isInteger(deck.config.newPerDay) && deck.config.newPerDay >= 0, '新規カード上限');
    requireValue(deck.config.reviewPerDay === undefined || (Number.isInteger(deck.config.reviewPerDay) && deck.config.reviewPerDay >= 0), '復習上限');
  }
  for (const nt of d.noteTypes) {
    requireValue(text(nt.name) && text(nt.css) && ['normal', 'cloze'].includes(nt.kind), 'ノートタイプ');
    requireValue(Array.isArray(nt.fields) && nt.fields.every(text) && Array.isArray(nt.templates) && nt.templates.length > 0, 'テンプレート');
    requireValue(nt.templates.every(t => object(t) && text(t.name) && text(t.front) && text(t.back)), 'テンプレート本文');
  }
  for (const n of d.notes) {
    const nt = d.noteTypes.find(t => t.id === n.noteTypeId);
    requireValue(types.has(n.noteTypeId) && nt && Array.isArray(n.fields) && n.fields.length === nt.fields.length && n.fields.every(text), 'ノートの参照／フィールド');
    requireValue(Array.isArray(n.tags) && n.tags.every(text), 'タグ');
  }
  for (const card of d.cards) {
    requireValue(notes.has(card.noteId) && decks.has(card.deckId), 'カードの参照');
    requireValue(Number.isInteger(card.type) && card.type >= 0 && card.type <= 3 && Number.isInteger(card.queue) && card.queue >= -3 && card.queue <= 4, 'カード状態');
    requireValue(['ordinal','due','interval','easeFactor','reps','lapses','left'].every(k => finite((card as unknown as Record<string, unknown>)[k])), 'カードの数値');
    requireValue(card.ordinal >= 0 && card.reps >= 0 && card.lapses >= 0, 'カードの負数');
    requireValue(card.type === 0 ? card.dueAt === null || finite(card.dueAt) : finite(card.dueAt), '復習予定');
    requireValue(card.queue !== 4, 'フィルターデッキのプレビュー状態は未対応です。Ankiで元デッキに戻して書き出してください。');
    requireValue(card.lastReview === null || finite(card.lastReview), '最終復習');
    requireValue(card.stability === null || (finite(card.stability) && card.stability > 0), 'Stability');
    requireValue(card.difficulty === null || (finite(card.difficulty) && card.difficulty >= 1 && card.difficulty <= 10), 'Difficulty');
    const n = d.notes.find(n => n.id === card.noteId)!;
    const nt = d.noteTypes.find(t => t.id === n.noteTypeId)!;
    requireValue(nt.kind === 'cloze' || card.ordinal < nt.templates.length, 'カードテンプレート番号');
  }
  for (const r of d.reviews) {
    requireValue(cards.has(r.cardId) && finite(r.reviewedAt) && Number.isInteger(r.rating) && r.rating >= 0 && r.rating <= 4 && Number.isInteger(r.type), '履歴の参照／評価');
  }
  requireValue(d.warnings.every(text), '警告');
  requireValue(d.media.every(m => object(m) && text(m.name) && text(m.path) && m.name.length > 0 && !/[\/\\\x00]/.test(m.name)), 'メディア');
}

export function initialSchedule(card: ImportedCard, deck: Deck, collection?: ImportDocument['collection']): ScheduleState {
  const steps = card.type === 3 ? deck.config.relearningSteps : deck.config.learningSteps;
  const memory = card.type > 0 && (card.stability === null || card.difficulty === null)
    ? reconstructMemory({ interval: card.interval, easeFactor: card.easeFactor / 1000 },schedulerConfig(deck,collection ?? { createdAt: 0, today: 0, timeZone: 'Asia/Tokyo', dayStart: 4 }))
    : { stability: card.stability ?? 0, difficulty: card.difficulty ?? 0 };
  return {
    state: card.type, due: card.dueAt ?? 0, stability: memory.stability,
    difficulty: memory.difficulty, elapsedDays: 0, scheduledDays: Math.max(0, card.interval),
    reps: card.reps, lapses: card.lapses, lastReview: card.lastReview,
    learningSteps: Math.max(0, Math.min(steps.length - 1, steps.length - card.left % 1000)),
  };
}
export function sqlLiteral(value: string | number | null): string {
  return value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/** Single transaction, empty target only. Re-import must never overwrite ongoing learning. */
export function importStatements(d: ImportDocument): string[] {
  validateImport(d);
  const j = (v: unknown) => sqlLiteral(JSON.stringify(v));
  const q = sqlLiteral;
  const approximated = d.cards.filter(c => c.type > 0 && (c.stability === null || c.difficulty === null)).length;
  const warnings = [...d.warnings, ...(approximated ? [`${approximated}枚の記憶状態をSM-2から推定しました（過去の保持率90%と仮定）。元の復習予定・履歴は保持されています。`] : [])];
  const statements = [
    `INSERT INTO collections(id, source_hash, metadata, warnings, imported_at) VALUES(1, ${q(d.source.sha256)}, ${j({ source: d.source, collection: d.collection })}, ${j(warnings)}, ${q(String(d.source.importedAt))})`,
    ...d.decks.map(x => `INSERT INTO decks(id,name,data) VALUES(${q(x.id)},${q(x.name)},${j(x)})`),
    ...d.noteTypes.map(x => `INSERT INTO note_types(id,data) VALUES(${q(x.id)},${j(x)})`),
    ...d.notes.map(x => `INSERT INTO notes(id,data) VALUES(${q(x.id)},${j(x)})`),
    ...d.cards.map(x => {
      const s = initialSchedule(x, d.decks.find(d => d.id === x.deckId)!,d.collection);
      return `INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original) VALUES(${q(x.id)},${q(x.noteId)},${q(x.deckId)},${x.ordinal},${x.queue},${s.state},${Math.round(s.due)},${j(s)},${j(x)})`;
    }),
    ...d.reviews.map(x => `INSERT INTO imported_reviews(id,card_id,data) VALUES(${q(x.id)},${q(x.cardId)},${j(x)})`),
    ...d.media.map(x => `INSERT INTO media(name,object_key) VALUES(${q(x.name)},${q(`anki/${d.source.sha256}/${x.name}`)})`),
  ];
  return statements;
}
