import { beforeEach, afterEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
beforeEach(() => {
  db = new TestDb();
  for (const f of [
    '0001_initial.sql',
    '0002_history_time.sql',
    '0003_authoring.sql',
    '0004_custom_practice.sql',
    '0005_practice_deletion.sql','0006_study_options.sql','0007_restart_new_limit.sql','0008_read_reduction.sql',
  ])
    db.sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  db.sqlite.exec(importStatements(fixture()).join(';') + ';');
});
afterEach(() => db.sqlite.close());
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
  expect((await get(id)).card).toBeNull();
  expect((await get(id)).practice).toMatchObject({
    position: 1,
    total: 1,
    againCount: 1,
    lastEventId: body.eventId,
  });
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
  await answer(id, 1);
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
  await answer(id, 1);
  const note = fixture().notes[0];
  note.fields[0] = '編集';
  db.sqlite.prepare('UPDATE notes SET data=?').run(JSON.stringify(note));
  expect((await get(id)).card.note.fields[0]).toBe('編集');
  db.sqlite.exec("UPDATE cards SET queue=-1 WHERE id='2'");
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
  expect(s.card.id).toBe('1');
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
  const last = await answer(id, 1);
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
    if (!fired && sql.includes('SELECT * FROM practice_sessions')) {
      fired = true;
      db.sqlite
        .prepare('UPDATE practice_sessions SET revision=revision+1 WHERE id=?')
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
