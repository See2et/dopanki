import { Hono, type Context } from 'hono';
import type { ManagementEnv } from './manage';
import type { Deck, Note, NoteType, StoredCard, StudyCard } from '../lib/types';
import type {
  PracticeSession,
  PracticeStudyResponse,
} from '../lib/practice-types';
import type { ScheduleState } from '../lib/scheduler';
type C = Context<ManagementEnv>;
interface Session {
  id: string;
  name: string;
  deck_ids: string;
  ordering: 'deck' | 'shuffle';
  round: number;
  revision: number;
  last_event_id: string | null;
}
interface Member {
  card_id: string;
  position: number;
  rating: number | null;
  event_id: string | null;
}
class Failure extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
function check(
  value: unknown,
  message: string,
  status: 400 | 404 | 409 = 400,
): asserts value {
  if (!value) throw new Failure(message, status);
}
const parse = <T>(s: string) => JSON.parse(s) as T;
const key = (v: unknown) => {
  check(
    typeof v === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(v),
    '一意な操作IDを指定してください。',
  );
  return v;
};
async function session(db: D1Database, id: string) {
  const s = await db
    .prepare('SELECT * FROM practice_sessions WHERE id=? AND deleted_at IS NULL')
    .bind(id)
    .first<Session>();
  check(s, '練習が見つかりません。', 404);
  return s;
}
async function members(db: D1Database, s: Session) {
  return (
    await db
      .prepare(
        'SELECT m.* FROM practice_members m JOIN cards c ON c.id=m.card_id WHERE m.session_id=? AND m.round=? AND c.queue>=0 ORDER BY m.position',
      )
      .bind(s.id, s.round)
      .all<Member>()
  ).results;
}
async function response(
  db: D1Database,
  s: Session,
): Promise<PracticeStudyResponse> {
  const rows = await members(db, s);
  const next = rows.find((r) => r.rating === null);
  let card: StudyCard | null = null;
  if (next) {
    const row = await db
      .prepare(
        `SELECT c.*,n.data AS note_data,t.data AS type_data,d.data AS deck_data FROM cards c JOIN notes n ON n.id=c.note_id JOIN note_types t ON t.id=json_extract(n.data,'$.noteTypeId') JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.queue>=0`,
      )
      .bind(next.card_id)
      .first<
        StoredCard & {
          note_data: string;
          type_data: string;
          deck_data: string;
        }
      >();
    if (row) {
      const schedule = parse<ScheduleState>(row.schedule);
      card = {
        id: row.id,
        revision: row.revision,
        ordinal: row.ordinal,
        schedule,
        note: parse<Note>(row.note_data),
        noteType: parse<NoteType>(row.type_data),
        deck: parse<Deck>(row.deck_data),
        preview: { 1: schedule, 2: schedule, 3: schedule, 4: schedule },
      };
    }
  }
  const position = rows.filter((r) => r.rating !== null).length;
  return {
    card,
    counts: {
      new: 0,
      learning: 0,
      review: rows.length - position,
      total: rows.length - position,
    },
    nextDue: null,
    answeredToday: 0,
    practice: {
      id: s.id,
      name: s.name,
      round: s.round,
      position,
      total: rows.length,
      revision: s.revision,
      againCount: rows.filter((r) => r.rating === 1).length,
      lastEventId: s.last_event_id,
    },
  };
}
async function scope(
  db: D1Database,
  ids: string[],
  order: Session['ordering'],
) {
  const decks = (
    await db.prepare('SELECT id,name FROM decks').all<{
      id: string;
      name: string;
    }>()
  ).results;
  const names = ids.map((id) => {
    const d = decks.find((d) => d.id === id);
    const name = d?.name ?? (id.startsWith('virtual:') ? id.slice(8) : null);
    check(
      name &&
        decks.some((d) => d.name === name || d.name.startsWith(name + '::')),
      '対象デッキが見つかりません。',
    );
    return name;
  });
  const selected = decks
    .filter((d) =>
      names.some((name) => d.name === name || d.name.startsWith(name + '::')),
    )
    .map((d) => d.id);
  const cards = (
    await db
      .prepare(
        `SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.queue>=0 AND c.deck_id IN (SELECT value FROM json_each(?)) ORDER BY d.name,c.id`,
      )
      .bind(JSON.stringify(selected))
      .all<{
        id: string;
      }>()
  ).results.map((c) => c.id);
  if (order === 'shuffle') shuffle(cards);
  return cards;
}
function shuffle(cards: string[]) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}
const insertMembers = (
  db: D1Database,
  sid: string,
  round: number,
  cards: string[],
) =>
  db
    .prepare(
      `INSERT INTO practice_members(session_id,round,card_id,position) SELECT ?,?,value,CAST(key AS INTEGER) FROM json_each(?)`,
    )
    .bind(sid, round, JSON.stringify(cards));
const guard = (
  db: D1Database,
  condition: string,
  args: (string | number | null)[],
) =>
  db
    .prepare(
      `INSERT INTO practice_guards(id,valid) VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    )
    .bind(crypto.randomUUID(), ...args);
async function mutate(
  c: C,
  body: Record<string, unknown>,
  operationId: string,
  build: () => Promise<{
    result: unknown;
    statements: D1PreparedStatement[];
  }>,
) {
  const id = key(operationId);
  if (c.req.path.endsWith('/review')) {
    const event = await c.env.DB.prepare(
      'SELECT undone FROM practice_events WHERE id=?',
    )
      .bind(id)
      .first<{
        undone: number;
      }>();
    check(!event?.undone, '取り消した回答は再送できません。', 409);
  }
  const request = JSON.stringify({ path: c.req.path, body });
  const db = c.env.DB;
  const read = () =>
    db
      .prepare('SELECT request,response FROM practice_receipts WHERE id=?')
      .bind(id)
      .first<{
        request: string;
        response: string;
      }>();
  const prior = await read();
  if (prior) {
    check(
      prior.request === request,
      '操作IDが別の操作で使用されています。',
      409,
    );
    return parse(prior.response);
  }
  const { result, statements } = await build();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO practice_receipts(id,request,response) VALUES(?,?,?)',
        )
        .bind(id, request, JSON.stringify(result)),
      ...statements,
      db.prepare('DELETE FROM practice_guards'),
    ]);
  } catch (e) {
    const retry = await read();
    if (retry && retry.request === request) return parse(retry.response);
    if (/constraint|UNIQUE|CHECK/i.test(String(e)))
      throw new Failure(
        '別の操作で更新されています。最新の練習を取得してください。',
        409,
      );
    throw e;
  }
  return result;
}
export const practice = new Hono<ManagementEnv>();
practice.onError((e, c) => {
  if (e instanceof Failure) return c.json({ error: e.message }, e.status);
  throw e;
});
practice.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    try {
      const b = await c.req.json();
      check(
        b && typeof b === 'object' && !Array.isArray(b),
        '入力が不正です。',
      );
      c.set('input', b);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure('入力が不正です。');
    }
  }
  await next();
});
practice.get('/', async (c) => {
  const rows = (
    await c.env.DB.prepare(
      'SELECT * FROM practice_sessions WHERE deleted_at IS NULL ORDER BY created_at DESC,id',
    ).all<Session>()
  ).results;
  const sessions: PracticeSession[] = [];
  for (const s of rows) {
    const r = await response(c.env.DB, s);
    sessions.push({
      id: s.id,
      name: s.name,
      round: s.round,
      position: r.practice.position,
      total: r.practice.total,
      order: s.ordering,
      deckIds: parse(s.deck_ids),
    });
  }
  return c.json({ sessions });
});
practice.post('/', async (c) => {
  const b = c.get('input');
  return c.json(
    await mutate(c, b, key(b.requestId), async () => {
      check(
        typeof b.name === 'string' &&
          b.name.trim().length > 0 &&
          b.name.length <= 200,
        '練習名を入力してください。',
      );
      check(
        Array.isArray(b.deckIds) &&
          b.deckIds.length > 0 &&
          b.deckIds.length <= 100 &&
          b.deckIds.every((x) => typeof x === 'string'),
        'デッキを選択してください。',
      );
      check(b.order === 'deck' || b.order === 'shuffle', '出題順が不正です。');
      const ids = [...new Set(b.deckIds as string[])];
      const cards = await scope(c.env.DB, ids, b.order);
      const id = crypto.randomUUID();
      const s: Session = {
        id,
        name: b.name.trim(),
        deck_ids: JSON.stringify(ids),
        ordering: b.order,
        round: 1,
        revision: 0,
        last_event_id: null,
      };
      return {
        result: {
          session: {
            id,
            name: s.name,
            round: 1,
            position: 0,
            total: cards.length,
            order: b.order,
            deckIds: ids,
          },
        },
        statements: [
          c.env.DB.prepare(
            'INSERT INTO practice_sessions(id,name,deck_ids,ordering,created_at) VALUES(?,?,?,?,?)',
          ).bind(id, s.name, s.deck_ids, s.ordering, new Date().toISOString()),
          insertMembers(c.env.DB, id, 1, cards),
        ],
      };
    }),
  );
});
practice.get('/:id', async (c) =>
  c.json(await response(c.env.DB, await session(c.env.DB, c.req.param('id')))),
);
practice.post('/:id/delete', async c => {
  const body = c.get('input');
  return c.json(await mutate(c, body, key(body.requestId), async () => {
    const selected = await session(c.env.DB, c.req.param('id'));
    return { result: { ok: true }, statements: [
      guard(c.env.DB, 'EXISTS(SELECT 1 FROM practice_sessions WHERE id=? AND deleted_at IS NULL)', [selected.id]),
      c.env.DB.prepare('UPDATE practice_sessions SET deleted_at=?,revision=revision+1,last_event_id=NULL WHERE id=?')
        .bind(Date.now(), selected.id),
      c.env.DB.prepare('DELETE FROM practice_members WHERE session_id=?').bind(selected.id),
    ] };
  }));
});
practice.post('/:id/review', async (c) => {
  const b = c.get('input');
  return c.json(
    await mutate(c, b, key(b.eventId), async () => {
      check(
        Number.isInteger(b.rating) &&
          Number(b.rating) >= 1 &&
          Number(b.rating) <= 4,
        '評価が不正です。',
      );
      const s = await session(c.env.DB, c.req.param('id'));
      check(b.revision === s.revision, '練習が更新されています。', 409);
      const rows = await members(c.env.DB, s);
      check(
        rows.find((r) => r.rating === null)?.card_id === b.cardId,
        '現在のカードを回答してください。',
        409,
      );
      return {
        result: { ok: true, eventId: b.eventId, revision: s.revision + 1 },
        statements: [
          guard(
            c.env.DB,
            'EXISTS(SELECT 1 FROM practice_sessions WHERE id=? AND revision=?) AND EXISTS(SELECT 1 FROM cards WHERE id=? AND queue>=0)',
            [s.id, s.revision, String(b.cardId)],
          ),
          c.env.DB.prepare(
            'INSERT INTO practice_events(id,session_id,round,card_id,rating,previous_event_id,reviewed_at) VALUES(?,?,?,?,?,?,?)',
          ).bind(
            String(b.eventId),
            s.id,
            s.round,
            String(b.cardId),
            Number(b.rating),
            s.last_event_id,
            Date.now(),
          ),
          c.env.DB.prepare(
            'UPDATE practice_members SET rating=?,event_id=? WHERE session_id=? AND round=? AND card_id=?',
          ).bind(
            Number(b.rating),
            String(b.eventId),
            s.id,
            s.round,
            String(b.cardId),
          ),
          c.env.DB.prepare(
            'UPDATE practice_sessions SET revision=revision+1,last_event_id=? WHERE id=?',
          ).bind(String(b.eventId), s.id),
        ],
      };
    }),
  );
});
practice.post('/:id/round', async (c) => {
  const b = c.get('input');
  return c.json(
    await mutate(c, b, key(b.requestId), async () => {
      const s = await session(c.env.DB, c.req.param('id'));
      check(s.revision === b.revision, '練習が更新されています。', 409);
      check(b.mode === 'all' || b.mode === 'again', '周回モードが不正です。');
      const rows = await members(c.env.DB, s);
      check(
        !rows.some((r) => r.rating === null),
        '現在の周回を完了してください。',
        409,
      );
      const cards =
        b.mode === 'all'
          ? await scope(c.env.DB, parse(s.deck_ids), s.ordering)
          : rows.filter((r) => r.rating === 1).map((r) => r.card_id);
      if (b.mode === 'again' && s.ordering === 'shuffle') shuffle(cards);
      return {
        result: { ok: true, round: s.round + 1, revision: s.revision + 1 },
        statements: [
          guard(
            c.env.DB,
            'EXISTS(SELECT 1 FROM practice_sessions WHERE id=? AND revision=?) AND NOT EXISTS(SELECT 1 FROM practice_members m JOIN cards c ON c.id=m.card_id WHERE m.session_id=? AND m.round=? AND m.rating IS NULL AND c.queue>=0)',
            [s.id, s.revision, s.id, s.round],
          ),
          insertMembers(c.env.DB, s.id, s.round + 1, cards),
          c.env.DB.prepare(
            'UPDATE practice_sessions SET round=round+1,revision=revision+1,last_event_id=NULL WHERE id=?',
          ).bind(s.id),
        ],
      };
    }),
  );
});
practice.post('/:id/undo', async (c) => {
  const b = c.get('input');
  const eventId = key(b.eventId);
  const s = await session(c.env.DB, c.req.param('id'));
  const e = await c.env.DB.prepare(
    'SELECT * FROM practice_events WHERE id=? AND session_id=?',
  )
    .bind(eventId, s.id)
    .first<{
      round: number;
      card_id: string;
      previous_event_id: string | null;
      undone: number;
    }>();
  check(e, '回答が見つかりません。', 404);
  if (e.undone) return c.json({ ok: true });
  check(
    s.last_event_id === eventId && e.round === s.round,
    '最後の回答だけ取り消せます。',
    409,
  );
  try {
    await c.env.DB.batch([
      guard(
        c.env.DB,
        'EXISTS(SELECT 1 FROM practice_sessions WHERE id=? AND revision=? AND last_event_id=?)',
        [s.id, s.revision, eventId],
      ),
      c.env.DB.prepare(
        'UPDATE practice_members SET rating=NULL,event_id=NULL WHERE session_id=? AND round=? AND card_id=?',
      ).bind(s.id, s.round, e.card_id),
      c.env.DB.prepare('UPDATE practice_events SET undone=1 WHERE id=?').bind(
        eventId,
      ),
      c.env.DB.prepare(
        'UPDATE practice_sessions SET revision=revision+1,last_event_id=NULL WHERE id=?',
      ).bind(s.id),
      c.env.DB.prepare('DELETE FROM practice_guards'),
    ]);
  } catch (error) {
    if (/constraint|CHECK/i.test(String(error)))
      throw new Failure('練習が更新されています。', 409);
    throw error;
  }
  return c.json({ ok: true });
});
export default practice;
