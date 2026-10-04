import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestDb } from './test-db';
import { readFileSync } from 'node:fs';
import { app } from '../src/server/index';
import { fixture } from './fixture';
import { importStatements, initialSchedule, validateImport } from '../src/lib/import';
import type { ImportDocument, ImportedCard, DeckSummary, StudyResponse } from '../src/lib/types';

/** Real SQLite persistence; only the D1 transport is adapted to the local test runtime. */
let db: TestDb;
function request(path: string, body?: unknown, secret?: string, headers?: Record<string,string>) {
  return app.request(`http://localhost${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, { DB: db as unknown as D1Database, APP_PASSWORD: secret, MEDIA: {} as R2Bucket, ASSETS: {} as Fetcher });
}
beforeEach(() => { db = new TestDb(); db.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8')); db.sqlite.exec(readFileSync('migrations/0003_authoring.sql','utf8')); db.sqlite.exec(importStatements(fixture()).join(';')+';'); });
afterEach(() => { db.sqlite.close(); vi.useRealTimers(); });
describe('migration and review persistence contracts', () => {
  it('keeps imported IDs, due, FSRS memory, template and history intact', async () => {
    const response = await request('/api/study/1'); const result = await response.json() as any;
    expect(response.status).toBe(200); expect(result.card.id).toBe('1');
    expect(result.card.schedule).toEqual(initialSchedule(fixture().cards[0],fixture().decks[0]));
    expect(result.card.noteType.templates[0].back).toContain('tts ko_KR');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM imported_reviews').get()?.n).toBe(1);
  });
  it('stores one answer, rejects stale tabs, undoes exactly and retains audit history', async () => {
    const before = (await (await request('/api/study/1')).json() as any).card.schedule;
    const event = { eventId: 'sample-event-id-0001', cardId: '1', revision: 0, rating: 3 };
    expect((await request('/api/review',event)).status).toBe(200);
    expect((await request('/api/review',event)).status).toBe(200);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_events').get()?.n).toBe(1);
    expect((await request('/api/review',{ ...event, eventId: 'different-event-0002' })).status).toBe(409);
    expect((await request('/api/undo',{ eventId: event.eventId })).status).toBe(200);
    expect((await request('/api/undo',{ eventId: event.eventId })).status).toBe(200);
    const restored = (await (await request('/api/study/1')).json() as any).card;
    expect(restored.schedule).toEqual(before); expect(restored.revision).toBe(2);
    expect(db.sqlite.prepare('SELECT undone FROM review_events').get()?.undone).toBe(1);
    expect((await request('/api/review',event)).status).toBe(409);
  });
  it('enforces new-card daily limit and undo restores availability', async () => {
    const d = fixture(); const c = d.cards[0]; c.type = c.queue = 0; c.stability = c.difficulty = c.lastReview = c.dueAt = null; c.reps = c.lapses = 0;
    d.decks[0].config.newPerDay = 1;
    db.sqlite.exec('DELETE FROM collections; DELETE FROM imported_reviews; DELETE FROM cards; DELETE FROM notes; DELETE FROM note_types; DELETE FROM decks');
    db.sqlite.exec(importStatements(d).join(';')+';');
    const event = { eventId: 'new-card-event-0001', cardId: '1', revision: 0, rating: 4 };
    expect((await request('/api/review',event)).status).toBe(200);
    expect((await (await request('/api/overview')).json() as any).decks[0].counts.new).toBe(0);
    expect((await request('/api/undo',{ eventId: event.eventId })).status).toBe(200);
    expect((await (await request('/api/overview')).json() as any).decks[0].counts.new).toBe(1);
  });
  it('does not expose suspended cards and re-import never overwrites progress', async () => {
    db.sqlite.exec('UPDATE cards SET queue=-1');
    expect((await (await request('/api/study/1')).json() as any).card).toBeNull();
    expect((await request('/api/review',{ eventId: 'suspended-event-0001', cardId: '1', revision: 0, rating: 3 })).status).toBe(404);
    expect(() => db.sqlite.exec(importStatements(fixture()).join(';')+';')).toThrow();
    expect(db.sqlite.prepare('SELECT queue FROM cards').get()?.queue).toBe(-1);
  });
  it('validates references before imports can mutate storage', () => {
    const d = fixture(); d.cards[0].noteId = '999'; expect(() => validateImport(d)).toThrow('参照');
  });
  it('counts imported same-day learning/review without mistaking repeats for new introductions', async () => {
    const now = Date.now();
    const c = fixture().cards[0];
    db.sqlite.exec('DELETE FROM imported_reviews');
    for (const [index,type] of [0,0,1,4].entries()) {
      const data = { id: String(now+index), cardId: c.id, rating: type === 4 ? 0 : 3, type, reviewedAt: now-10000+index };
      db.sqlite.prepare('INSERT INTO imported_reviews(id,card_id,data) VALUES(?,?,?)').run(data.id,c.id,JSON.stringify(data));
    }
    const overview = await (await request('/api/overview')).json() as any;
    expect(overview.decks[0].answeredToday).toBe(3);
    expect(overview.decks[0].counts.review).toBe(1);
    db.sqlite.exec('UPDATE cards SET queue=0,state=0');
    const deck = fixture().decks[0]; deck.config.newPerDay = 2;
    db.sqlite.prepare('UPDATE decks SET data=?').run(JSON.stringify(deck));
    expect((await (await request('/api/overview')).json() as any).decks[0].counts.new).toBe(1);
  });
  it('unburies temporary hidden cards on the next study day while keeping suspended ones hidden', async () => {
    const meta = JSON.parse(String(db.sqlite.prepare('SELECT metadata FROM collections').get()?.metadata));
    meta.source.importedAt = new Date(Date.now()-2*86400000).toISOString();
    db.sqlite.prepare('UPDATE collections SET metadata=?').run(JSON.stringify(meta));
    db.sqlite.exec('UPDATE cards SET queue=-2');
    expect((await (await request('/api/study/1')).json() as any).card?.id).toBe('1');
    db.sqlite.exec('UPDATE cards SET queue=-1');
    expect((await (await request('/api/study/1')).json() as any).card).toBeNull();
  });
});
describe('private collection access', () => {
  it('requires password session for collection, review and export, and rejects foreign-origin writes', async () => {
    for (const path of ['/api/overview','/api/study/1','/api/export']) expect((await request(path,undefined,'secret')).status).toBe(401);
    expect((await request('/api/login',{ password: 'wrong' },'secret')).status).toBe(401);
    const login = await request('/api/login',{ password: 'secret' },'secret');
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    expect((await request('/api/overview',undefined,'secret',{ Cookie: cookie })).status).toBe(200);
    expect((await request('/api/review',{},'secret',{ Cookie: cookie, Origin: 'https://evil.example' })).status).toBe(403);
    const exported = await request('/api/export',undefined,'secret',{ Cookie: cookie });
    expect((await exported.json() as any).importedReviews).toHaveLength(1);
  });
  it('fails closed outside loopback when no password is configured', async () => {
    const response = await app.request('https://dopanki.example/api/overview',{}, { DB: db as unknown as D1Database, MEDIA: {} as R2Bucket, ASSETS: {} as Fetcher });
    expect(response.status).toBe(503);
  });
});

function replaceCollection(document: ImportDocument) {
  db.sqlite.exec('DELETE FROM review_events; DELETE FROM imported_reviews; DELETE FROM cards; DELETE FROM notes; DELETE FROM note_types; DELETE FROM decks; DELETE FROM collections');
  db.sqlite.exec(importStatements(document).join(';')+';');
}
function hierarchyFixture() {
  const document = fixture();
  document.decks = ['A','A::B','A::B::C','A::BB','Outside'].map((name,index) => ({
    ...structuredClone(document.decks[0]), id: String(index+1), name,
  }));
  document.reviews = [];
  return document;
}
function hierarchyCard(id: number, deckId: string, queue: 0 | 1 | 2, due = Date.now()-10000): ImportedCard {
  const card = fixture().cards[0];
  return { ...card, id: String(id), deckId, type: queue, queue, due: id, dueAt: queue === 0 ? null : due,
    ...(queue === 0 ? { stability: null, difficulty: null, lastReview: null, reps: 0, lapses: 0, interval: 0 } : {}) };
}
async function overviewDecks() {
  return (await (await request('/api/overview')).json() as { decks: DeckSummary[] }).decks;
}
async function studyDeck(id: string) {
  return await (await request(`/api/study/${encodeURIComponent(id)}`)).json() as StudyResponse;
}

describe('hierarchical decks and selected-subtree daily limits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T14:00:00Z'));
  });
  it('retains empty parents, exact path boundaries, and each card’s scheduling settings without rewriting data', async () => {
    const document = hierarchyFixture();
    document.decks[0].config.desiredRetention = 0.99;
    document.decks[2].config.desiredRetention = 0.8;
    document.cards = [hierarchyCard(1,'3',2), hierarchyCard(2,'4',0), hierarchyCard(3,'5',0)];
    replaceCollection(document);
    const before = db.sqlite.prepare('SELECT * FROM cards ORDER BY id').all();
    const history = db.sqlite.prepare('SELECT * FROM imported_reviews').all();
    const decks = await overviewDecks();
    expect(decks).toHaveLength(5);
    const root = decks.find(deck => deck.id === '1')!;
    const middle = decks.find(deck => deck.id === '2')!;
    expect(root).toMatchObject({ parentId: null, depth: 0, label: 'A',
      ownCounts: { total: 0, new: 0, learning: 0, review: 0 }, counts: { total: 2, new: 1, learning: 0, review: 1 } });
    expect(middle).toMatchObject({ parentId: '1', depth: 1, label: 'B', counts: { total: 1, new: 0, learning: 0, review: 1 } });
    expect(decks.find(deck => deck.id === '3')).toMatchObject({ parentId: '2', depth: 2, label: 'C' });
    expect(decks.find(deck => deck.id === '4')?.parentId).toBe('1');
    const fromParent = await studyDeck('2');
    const fromChild = await studyDeck('3');
    expect(fromParent.counts).toEqual(middle.counts);
    expect(fromParent.card?.deck).toEqual(document.decks[2]);
    expect(fromParent.card?.preview).toEqual(fromChild.card?.preview);
    expect(db.sqlite.prepare('SELECT * FROM cards ORDER BY id').all()).toEqual(before);
    expect(db.sqlite.prepare('SELECT * FROM imported_reviews').all()).toEqual(history);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_events').get()?.n).toBe(0);
  });
  it('caps roots, intermediate folders and leaves using subtree answers exactly once, while child selection ignores ancestors', async () => {
    const document = hierarchyFixture();
    document.decks[0].config.newPerDay = 3; document.decks[0].config.reviewPerDay = 2;
    document.decks[1].config.newPerDay = 1; document.decks[1].config.reviewPerDay = 1;
    document.decks[2].config.newPerDay = 10; document.decks[2].config.reviewPerDay = 10;
    document.decks[3].config.newPerDay = 1; document.decks[3].config.reviewPerDay = 1;
    document.cards = [
      ...[1,2,3,4].map(id => hierarchyCard(id,'3',0)),
      ...[5,6,7,8].map(id => hierarchyCard(id,'3',2)),
      hierarchyCard(20,'1',0), hierarchyCard(21,'1',0),
      hierarchyCard(22,'1',2,Date.now()-5000), hierarchyCard(23,'1',2,Date.now()-5000),
      ...[30,31,32].map(id => hierarchyCard(id,'4',0)),
      ...[33,34,35].map(id => hierarchyCard(id,'4',2,Date.now()-1000)),
    ];
    document.reviews = [{ ...fixture().reviews[0], id: '900', cardId: '5', reviewedAt: Date.now()-500 }];
    replaceCollection(document);
    for (const [id,deckId,cardId] of [['root-answer-event','1','20'],['leaf-answer-event','3','1']]) {
      expect((await request('/api/review',{ eventId: id, cardId, revision: 0, rating: 4 })).status).toBe(200);
    }
    const decks = await overviewDecks();
    const root = decks.find(deck => deck.id === '1')!;
    const middle = decks.find(deck => deck.id === '2')!;
    const leaf = decks.find(deck => deck.id === '3')!;
    expect(root.counts).toEqual({ total: 18, new: 1, learning: 0, review: 1 });
    expect(root.ownCounts).toEqual({ total: 4, new: 1, learning: 0, review: 2 });
    expect(root.answeredToday).toBe(3); expect(root.ownAnsweredToday).toBe(1);
    expect(middle.counts).toEqual({ total: 8, new: 0, learning: 0, review: 0 });
    expect(middle.answeredToday).toBe(2); expect(middle.ownAnsweredToday).toBe(0);
    expect(leaf.counts).toEqual({ total: 8, new: 3, learning: 0, review: 4 });
    expect(leaf.answeredToday).toBe(2);
    expect((await studyDeck('1')).card?.deck.id).toBe('1');
    expect((await studyDeck('2')).card).toBeNull();
    expect((await studyDeck('3')).card?.id).toBe('5');
    db.sqlite.exec('UPDATE cards SET queue=-1 WHERE queue=2');
    // The earlier new cards in C remain blocked by B, while the sibling has quota.
    expect((await studyDeck('1')).card?.id).toBe('21');
    db.sqlite.exec("UPDATE cards SET queue=-1 WHERE deck_id='1'");
    expect((await studyDeck('1')).card?.deck.id).toBe('4');
    document.decks[0].config.newPerDay = 0;
    db.sqlite.prepare('UPDATE decks SET data=? WHERE id=?').run(JSON.stringify(document.decks[0]),'1');
    expect((await studyDeck('1')).counts.new).toBe(0);
    expect((await studyDeck('4')).counts.new).toBe(1);
    expect((await studyDeck('4')).card?.deck.id).toBe('4');
  });
  it('keeps due learning available beyond daily caps and finds future due cards throughout the subtree', async () => {
    const document = hierarchyFixture();
    document.decks[0].config.newPerDay = 0; document.decks[0].config.reviewPerDay = 0;
    document.cards = [hierarchyCard(1,'3',1),hierarchyCard(2,'3',2),hierarchyCard(3,'3',0)];
    replaceCollection(document);
    expect((await studyDeck('1')).counts).toEqual({ total: 3, new: 0, learning: 1, review: 0 });
    expect((await studyDeck('1')).card?.id).toBe('1');
    db.sqlite.prepare('UPDATE cards SET due=? WHERE id=?').run(Date.now()+60000,'1');
    const exhausted = await studyDeck('1');
    expect(exhausted.card).toBeNull(); expect(exhausted.nextDue).toBe(Date.now()+60000);
    // A zero new limit does not remove the independent review allowance.
    document.decks[0].config.reviewPerDay = 1;
    db.sqlite.prepare('UPDATE decks SET data=? WHERE id=?').run(JSON.stringify(document.decks[0]),'1');
    expect((await studyDeck('1')).counts.review).toBe(1);
    expect((await studyDeck('1')).card?.id).toBe('2');
  });
  it('provides resolvable navigation folders for missing ancestors without persisting synthetic decks', async () => {
    const document = fixture(); document.decks[0].name = 'A::B::C';
    replaceCollection(document);
    const decks = await overviewDecks();
    const parent = decks.find(deck => deck.name === 'A')!;
    expect(parent.virtual).toBe(true); expect(parent.ownCounts.total).toBe(0); expect(parent.counts.total).toBe(1);
    expect((await studyDeck(parent.id)).card?.deck.id).toBe('1');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM decks').get()?.n).toBe(1);
  });
  it('keeps overview and parent-study query counts below the worker budget for the imported 27-deck scale', async () => {
    const document = fixture();
    document.decks = ['A',...Array.from({ length: 25 },(_,index) => `A::${index}`),'Default'].map((name,index) => ({
      ...structuredClone(document.decks[0]), id: String(index+1), name,
    }));
    document.cards[0].deckId = '2'; replaceCollection(document);
    db.queries = 0;
    expect(await overviewDecks()).toHaveLength(27);
    expect(db.queries).toBeLessThanOrEqual(5);
    db.queries = 0;
    expect((await studyDeck('1')).card?.deck.id).toBe('2');
    expect(db.queries).toBeLessThanOrEqual(8);
  });
});
