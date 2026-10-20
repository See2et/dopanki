import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { TestDb } from './test-db';
import practice from '../src/server/practice';
import { importStatements } from '../src/lib/import';
import { fixture } from './fixture';
let db: TestDb;
let seq = 0;
const key = () => `practice-operation-${++seq}`;
async function req(path: string, body?: unknown) {
  return practice.request(
    `http://localhost${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      DB: db as unknown as D1Database,
      MEDIA: {} as R2Bucket,
      ASSETS: {} as Fetcher,
    },
  );
}
async function get(id: string) {
  return (await req('/' + id)).json() as Promise<any>;
}
async function create(deckIds = ['1']) {
  const r = await req('/', {
    name: '復習',
    deckIds,
    order: 'deck',
    requestId: key(),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).session.id as string;
}
async function answer(id: string, rating = 3, eventId = key()) {
  const s = await get(id);
  const body = {
    eventId,
    cardId: s.card.id,
    revision: s.practice.revision,
    rating,
  };
  const r = await req('/' + id + '/review', body);
  expect(r.status).toBe(200);
  return body;
}
function initialize(legacy = false) {
  db = new TestDb();
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
    if (legacy && f === '0010_practice_repetition.sql') continue;
    db.sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  db.sqlite.exec(importStatements(fixture()).join(';') + ';');
}
function addCards(total: number) {
  for (let i = 2; i <= total; i++) db.sqlite.prepare(
    "INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id) SELECT ?,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id FROM cards WHERE id='1'",
  ).run(String(i));
}
beforeEach(() => initialize());
afterEach(() => { db.sqlite.close(); vi.restoreAllMocks(); });
it('persists resume and idempotent answers without changing normal learning or history', async () => {
  const cards = db.sqlite.prepare('SELECT * FROM cards').all();
  const history = db.sqlite.prepare('SELECT * FROM imported_reviews').all();
  const createBody = {
    name: '復習',
    deckIds: ['1'],
    order: 'shuffle',
    requestId: key(),
  };
  const first = (await (await req('/', createBody)).json()) as any;
  expect(await (await req('/', createBody)).json()).toEqual(first);
  const id = first.session.id;
  const body = await answer(id, 1);
  expect((await req('/' + id + '/review', body)).status).toBe(200);
  // Again no longer completes a single-pass round: with no other cards, retry now.
  expect((await get(id)).card.id).toBe(body.cardId);
  expect((await get(id)).practice).toMatchObject({
    position: 0,
    total: 1,
    againCount: 1,
    lastEventId: body.eventId,
  });
  await answer(id, 4);
  expect((await get(id)).card).toBeNull();
  expect((await get(id)).practice).toMatchObject({ position: 1, againCount: 1 });
  expect(db.sqlite.prepare('SELECT * FROM cards').all()).toEqual(cards);
  expect(db.sqlite.prepare('SELECT * FROM imported_reviews').all()).toEqual(
    history,
  );
  expect(
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_events').get()?.n,
  ).toBe(0);
  expect((await req('/' + id + '/review', { ...body, rating: 4 })).status).toBe(
    409,
  );
});
it('deduplicates full path descendant scopes and snapshots until next fresh round', async () => {
  const d = fixture();
  d.decks[0].id = '2';
  d.decks[0].name = '語学::韓国語';
  d.notes[0].id = '2';
  d.cards[0].id = '2';
  d.cards[0].noteId = '2';
  d.cards[0].deckId = '2';
  d.cards[0].queue = 0;
  d.reviews = [];
  db.sqlite.exec(
    importStatements(d)
      .filter(
        (s) =>
          s.startsWith('INSERT INTO decks') ||
          s.startsWith('INSERT INTO notes') ||
          s.startsWith('INSERT INTO cards'),
      )
      .join(';') + ';',
  );
  const id = await create(['virtual:語学', '2']);
  expect((await get(id)).practice.total).toBe(1);
  db.sqlite.exec(
    "INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id) SELECT '3',note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id FROM cards WHERE id='2'",
  );
  await answer(id, 3);
  expect((await get(id)).practice.total).toBe(1);
  const s = await get(id);
  expect(
    (
      await req('/' + id + '/round', {
        requestId: key(),
        revision: s.practice.revision,
        mode: 'all',
      })
    ).status,
  ).toBe(200);
  expect((await get(id)).practice.total).toBe(2);
});
it('reads live edited content and suspension while retaining snapshot order, then repeats only Again', async () => {
  db.sqlite.exec(
    "INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id) SELECT '2',note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id FROM cards WHERE id='1'",
  );
  const id = await create();
  const again = await answer(id, 1);
  const otherCardId = (await get(id)).card.id;
  const note = fixture().notes[0];
  note.fields[0] = '編集';
  db.sqlite.prepare('UPDATE notes SET data=?').run(JSON.stringify(note));
  expect((await get(id)).card.note.fields[0]).toBe('編集');
  db.sqlite.prepare('UPDATE cards SET queue=-1 WHERE id=?').run(otherCardId);
  expect((await get(id)).card.id).toBe(again.cardId);
  await answer(id, 3);
  expect((await get(id)).card).toBeNull();
  let s = await get(id);
  expect(
    (
      await req('/' + id + '/round', {
        requestId: key(),
        revision: s.practice.revision,
        mode: 'again',
      })
    ).status,
  ).toBe(200);
  s = await get(id);
  expect(s.practice).toMatchObject({ round: 2, total: 1, position: 0 });
  expect(s.card.id).toBe(again.cardId);
});
it('rejects stale writers and permits last-answer undo after completion until a new round', async () => {
  const id = await create();
  const before = await get(id);
  const event = await answer(id, 2);
  expect(
    (
      await req('/' + id + '/review', {
        eventId: key(),
        cardId: '1',
        revision: before.practice.revision,
        rating: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (await req('/' + id + '/undo', { eventId: event.eventId })).status,
  ).toBe(200);
  expect(
    (await req('/' + id + '/undo', { eventId: event.eventId })).status,
  ).toBe(200);
  expect((await get(id)).card.id).toBe('1');
  expect((await req('/' + id + '/review', event)).status).toBe(409);
  await answer(id, 1);
  const last = await answer(id, 3);
  const s = await get(id);
  expect(
    (
      await req('/' + id + '/round', {
        requestId: key(),
        revision: s.practice.revision,
        mode: 'again',
      })
    ).status,
  ).toBe(200);
  expect(
    (await req('/' + id + '/undo', { eventId: last.eventId })).status,
  ).toBe(409);
});
it('rolls back a review when a concurrent revision changes between read and commit', async () => {
  const id = await create();
  let fired = false;
  db.afterFirst = (sql) => {
    if (!fired && sql.includes('SELECT *,state_revision AS revision FROM practice_sessions')) {
      fired = true;
      db.sqlite
        .prepare('UPDATE practice_sessions SET state_revision=state_revision+1 WHERE id=?')
        .run(id);
    }
  };
  expect(
    (
      await req('/' + id + '/review', {
        eventId: key(),
        cardId: '1',
        revision: 0,
        rating: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM practice_events').get()?.n,
  ).toBe(0);
  db.afterFirst = undefined;
  expect((await get(id)).practice.position).toBe(0);
});

it.each(['undo', 'round'] as const)('rolls back %s when a concurrent revision changes before commit', async (operation) => {
  const id = await create();
  await answer(id, 1);
  const last = await answer(id, 3);
  const before = await get(id);
  const members = db.sqlite.prepare('SELECT * FROM practice_members').all();
  const events = db.sqlite.prepare('SELECT * FROM practice_events').all();
  const receipts = db.sqlite.prepare('SELECT * FROM practice_receipts').all();
  let fired = false;
  db.afterFirst = (sql) => {
    if (!fired && sql.includes('SELECT *,state_revision AS revision FROM practice_sessions')) {
      fired = true;
      db.sqlite.prepare('UPDATE practice_sessions SET state_revision=state_revision+1 WHERE id=?').run(id);
    }
  };
  const body = operation === 'undo' ? {eventId:last.eventId}
    : {requestId:key(),revision:before.practice.revision,mode:'all'};
  expect((await req('/' + id + '/' + operation,body)).status).toBe(409);
  db.afterFirst = undefined;
  expect(db.sqlite.prepare('SELECT * FROM practice_members').all()).toEqual(members);
  expect(db.sqlite.prepare('SELECT * FROM practice_events').all()).toEqual(events);
  expect(db.sqlite.prepare('SELECT * FROM practice_receipts').all()).toEqual(receipts);
  expect((await get(id)).practice).toMatchObject({round:1,position:1,againCount:1,lastEventId:last.eventId});
  expect(db.sqlite.prepare('SELECT answer_count FROM practice_sessions WHERE id=?').get(id)?.answer_count).toBe(2);
});

it.each([[1, 3], [2, 5]])('repeats rating %i after %i other answers, then completes only on Good/Easy', async (rating, spacing) => {
  addCards(7);
  const id = await create();
  const first = await answer(id, rating);
  const s = await get(id);
  expect(s.practice.position).toBe(0);
  expect((await req('/' + id + '/round', {requestId:key(),revision:s.practice.revision,mode:'all'})).status).toBe(409);
  for (let i = 0; i < spacing; i++) {
    expect((await get(id)).card.id).not.toBe(first.cardId);
    await answer(id, 3);
  }
  expect((await get(id)).card.id).toBe(first.cardId);
  expect((await get(id)).practice.position).toBe(spacing);
  await answer(id, 4);
  while ((await get(id)).card) {
    expect((await get(id)).card.id).not.toBe(first.cardId);
    await answer(id, 3);
  }
  expect((await get(id)).practice).toMatchObject({position:7,total:7,againCount:rating === 1 ? 1 : 0});
});

it('resumes retry state and restores mixed repeated answers exactly without chain undo', async () => {
  const id = await create();
  const again = await answer(id, 1);
  const before = await get(id);
  const member = db.sqlite.prepare('SELECT * FROM practice_members WHERE session_id=?').get(id);
  const hard = await answer(id, 2);
  expect((await get(id)).practice).toMatchObject({position:0,againCount:1});
  expect((await req('/' + id + '/undo', {eventId:hard.eventId})).status).toBe(200);
  const restored = await get(id);
  expect(restored.card).toEqual(before.card);
  expect(restored.practice).toMatchObject({position:0,againCount:1,lastEventId:null});
  expect(db.sqlite.prepare('SELECT * FROM practice_members WHERE session_id=?').get(id)).toEqual(member);
  expect((await req('/' + id + '/review', hard)).status).toBe(409);
  expect((await req('/' + id + '/undo', {eventId:again.eventId})).status).toBe(409);
  const good = await answer(id, 3);
  expect((await get(id)).card).toBeNull();
  expect((await req('/' + id + '/undo', {eventId:good.eventId})).status).toBe(200);
  expect(db.sqlite.prepare('SELECT * FROM practice_members WHERE session_id=?').get(id)).toEqual(member);
  await answer(id, 4);
  expect((await get(id)).practice).toMatchObject({position:1,againCount:1});
});

it('normalizes legacy deck input to shuffle and shuffles every subsequent round', async () => {
  addCards(4);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const id = await create();
  const list = await (await req('/')).json() as any;
  expect(list.sessions[0].order).toBe('shuffle');
  const initialIds: string[] = [];
  for (let i = 0; i < 4; i++) { initialIds.push((await get(id)).card.id); await answer(id, 3); }
  expect(initialIds).toEqual(['2','3','4','1']);
  // Simulate a saved legacy deck-order session: its next round is normalized too.
  db.sqlite.prepare("UPDATE practice_sessions SET ordering='deck' WHERE id=?").run(id);
  let s = await get(id);
  const roundBody = {requestId:key(),revision:s.practice.revision,mode:'all'};
  expect((await req('/' + id + '/round', roundBody)).status).toBe(200);
  expect((await req('/' + id + '/round', roundBody)).status).toBe(200);
  expect((await get(id)).practice.round).toBe(2);
  expect((await get(id)).card.id).toBe('2');
  const encountered = new Set<string>();
  while ((await get(id)).card) {
    const cardId = (await get(id)).card.id;
    await answer(id, encountered.has(cardId) ? 3 : 1);
    encountered.add(cardId);
  }
  s = await get(id);
  expect(s.practice.againCount).toBe(4);
  expect((await req('/' + id + '/round', {requestId:key(),revision:s.practice.revision,mode:'again'})).status).toBe(200);
  expect((await get(id)).card.id).toBe('3');
  expect(db.sqlite.prepare('SELECT ordering FROM practice_sessions WHERE id=?').get(id)?.ordering).toBe('shuffle');
});

it('migrates legacy completed Again/Hard without reopening them and preserves unfinished deck order and undo', async () => {
  db.sqlite.close(); initialize(true); addCards(4);
  db.sqlite.exec(`INSERT INTO practice_sessions(id,name,deck_ids,ordering,last_event_id,created_at) VALUES('legacy','old','["1"]','deck','legacy-event-0001','now');
    INSERT INTO practice_members(session_id,round,card_id,position,rating,event_id) VALUES
    ('legacy',1,'1',0,1,'legacy-event-0001'),('legacy',1,'2',1,2,NULL),('legacy',1,'3',2,NULL,NULL),('legacy',1,'4',3,NULL,NULL);
    INSERT INTO practice_events(id,session_id,round,card_id,rating,reviewed_at) VALUES('legacy-event-0001','legacy',1,'1',1,0);`);
  db.sqlite.exec(readFileSync('migrations/0010_practice_repetition.sql','utf8'));
  expect((await get('legacy')).practice).toMatchObject({position:2,againCount:1});
  expect((await get('legacy')).card.id).toBe('3');
  expect((await req('/legacy/undo',{eventId:'legacy-event-0001'})).status).toBe(200);
  expect((await get('legacy')).card.id).toBe('1');
  expect((await get('legacy')).practice).toMatchObject({position:1,againCount:0});
  await answer('legacy',1);
  await answer('legacy',3); // remaining original order starts at card 3
  expect((await get('legacy')).card.id).toBe('4');
  await answer('legacy',3);
  expect((await get('legacy')).card.id).toBe('1'); // only retry remains: no wait
  await answer('legacy',3);
  expect((await get('legacy')).practice).toMatchObject({position:4,againCount:1});
  const s = await get('legacy');
  expect((await req('/legacy/round',{requestId:key(),revision:s.practice.revision,mode:'again'})).status).toBe(200);
  expect((await get('legacy')).practice).toMatchObject({round:2,position:0,total:1,againCount:0});
  expect((await get('legacy')).card.id).toBe('1');
});

it('fences late legacy writes at migration without losing acknowledged answers or undo state', async () => {
  db.sqlite.close(); initialize(true);
  db.sqlite.exec(`INSERT INTO practice_sessions(id,name,deck_ids,ordering,revision,last_event_id,created_at) VALUES('cutover','old','["1"]','deck',7,'legacy-cutover-event','now');
    INSERT INTO practice_members(session_id,round,card_id,position,rating,event_id) VALUES('cutover',1,'1',0,1,'legacy-cutover-event');
    INSERT INTO practice_events(id,session_id,round,card_id,rating,reviewed_at) VALUES('legacy-cutover-event','cutover',1,'1',1,0);`);
  db.sqlite.exec(readFileSync('migrations/0010_practice_repetition.sql','utf8'));
  const before = db.sqlite.prepare('SELECT * FROM practice_members').all();
  // Old workers finish every review/undo/round/delete batch by updating revision.
  // Even a batch already holding pre-migration state must fail and roll back.
  for (const rating of [null, 1, 3]) {
    await expect(db.batch([
      db.prepare('UPDATE practice_members SET rating=?,event_id=NULL WHERE session_id=?').bind(rating,'cutover'),
      db.prepare('UPDATE practice_sessions SET revision=revision+1,last_event_id=NULL WHERE id=?').bind('cutover'),
    ])).rejects.toThrow();
    expect(db.sqlite.prepare('SELECT * FROM practice_members').all()).toEqual(before);
  }
  expect((await get('cutover')).practice).toMatchObject({revision:7,position:1,againCount:1,lastEventId:'legacy-cutover-event'});
  expect((await req('/cutover/undo',{eventId:'legacy-cutover-event'})).status).toBe(200);
  expect((await get('cutover')).practice).toMatchObject({revision:8,position:0,againCount:0});
  await answer('cutover',3);
  expect((await get('cutover')).practice).toMatchObject({revision:9,position:1});
  const { app } = await import('../src/server/index');
  const exported = await (await app.request('http://localhost/api/export',{}, {DB:db as unknown as D1Database})).json() as any;
  expect(exported.practiceSessions[0]).toMatchObject({id:'cutover',revision:9});
  expect(exported.practiceSessions[0]).not.toHaveProperty('state_revision');
});

it('does not expose practice to bearer authoring credentials', async () => {
  const { app } = await import('../src/server/index');
  const env = {
    DB: db as unknown as D1Database,
    MEDIA: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    APP_PASSWORD: 'secret',
  };
  const token = 'authoring-only';
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  db.sqlite
    .prepare(
      'INSERT INTO api_tokens(id,name,token_hash,scopes,created_at) VALUES(?,?,?,?,?)',
    )
    .run(
      'token1',
      'authoring',
      hash,
      JSON.stringify(['content:read', 'content:write']),
      new Date().toISOString(),
    );
  expect(
    (
      await app.request(
        'http://localhost/api/manage/decks',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        'http://localhost/api/practice',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).status,
  ).toBe(401);
  expect(
    (await app.request('http://localhost/api/practice', {}, env)).status,
  ).toBe(401);
});

it('undoes only one latest answer without exposing an earlier undo', async () => {
  db.sqlite.exec(
    "INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id) SELECT '2',note_id,deck_id,ordinal,queue,state,due,schedule,original,revision,last_event_id FROM cards WHERE id='1'",
  );
  const cards = db.sqlite.prepare('SELECT * FROM cards ORDER BY id').all();
  const history = db.sqlite.prepare('SELECT * FROM imported_reviews').all();
  const id = await create();
  const first = await answer(id, 3);
  const last = await answer(id, 1);
  expect(
    (await req('/' + id + '/undo', { eventId: last.eventId })).status,
  ).toBe(200);
  expect((await get(id)).practice).toMatchObject({
    position: 1,
    lastEventId: null,
  });
  expect(
    (await req('/' + id + '/undo', { eventId: first.eventId })).status,
  ).toBe(409);
  expect(
    (await req('/' + id + '/undo', { eventId: last.eventId })).status,
  ).toBe(200);
  expect(
    db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM practice_events WHERE undone=0')
      .get()?.n,
  ).toBe(1);
  expect(db.sqlite.prepare('SELECT * FROM cards ORDER BY id').all()).toEqual(
    cards,
  );
  expect(db.sqlite.prepare('SELECT * FROM imported_reviews').all()).toEqual(
    history,
  );
  expect(
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_events').get()?.n,
  ).toBe(0);
});

it('deletes a saved scope and its progress while preserving study history and original cards', async () => {
  const id = await create();
  const other = await create();
  const event = await answer(id);
  const before = db.sqlite.prepare('SELECT * FROM cards').all();
  const history = db.sqlite.prepare('SELECT * FROM practice_events').all();
  const body = {requestId:key()};
  expect((await req('/'+id+'/delete',body)).status).toBe(200);
  expect((await req('/'+id+'/delete',body)).status).toBe(200);
  expect((await get(id)).error).toBeTruthy();
  expect((await req('/'+id+'/undo',{eventId:event.eventId})).status).toBe(404);
  expect((await req('/'+id+'/round',{requestId:key(),revision:1,mode:'all'})).status).toBe(404);
  expect((await req('/'+id+'/review',{eventId:key(),cardId:'1',revision:1,rating:3})).status).toBe(404);
  const list = await (await req('/')).json() as any;
  expect(list.sessions.map((s:any)=>s.id)).toEqual([other]);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM practice_members WHERE session_id=?').get(id)?.n).toBe(0);
  expect(db.sqlite.prepare('SELECT * FROM practice_events').all()).toEqual(history);
  expect(db.sqlite.prepare('SELECT * FROM cards').all()).toEqual(before);
});
