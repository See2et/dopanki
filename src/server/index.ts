import { Hono, type Context } from 'hono';
import { accessEnabled, verifyAccess } from './access';
import manager, { authorizeBearer, type ManagementEnv } from './manage';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { preview, schedule, studyDayBoundary, nextStudyDayBoundary, type ScheduleState } from '../lib/scheduler';
import { schedulerConfig, type ImportDocument, type Deck, type StoredCard, type StudyResponse, type Note, type NoteType } from '../lib/types';
import { progress } from '../lib/progress';
import practice from './practice';
import studyOptions, { studyContext, studyCandidates, answerAdmission, validFocusIds, intradayLearning, importedIntraday, preloadOverviewCandidates, optionsResponse } from './study-options';

type Env = ManagementEnv;
export const app = new Hono<Env>();
const cookieName = 'dopanki_session';
const encoder = new TextEncoder();
const json = <T>(v: string) => JSON.parse(v) as T;
const loopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))).map(x => x.toString(16).padStart(2, '0')).join('');
const equal = (a: string, b: string) => {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
};
async function signature(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))).map(x => x.toString(16).padStart(2, '0')).join('');
}
async function accessClaims(c: Context<Env>) {
  if (c.get('accessClaims') === undefined) c.set('accessClaims', await verifyAccess(c.req.raw, c.env));
  return c.get('accessClaims');
}
async function authenticated(c: Context<Env>) {
  if (accessEnabled(c.env)) {
    const claims = await accessClaims(c);
    // Service tokens must still use a scoped authoring token, never a browser session.
    return typeof claims?.email === 'string' && !!claims.email;
  }
  const secret = c.env.APP_PASSWORD;
  if (!secret) return loopback(c.req.url);
  const token = getCookie(c, cookieName);
  if (!token) return false;
  const [expires, mac] = token.split('.');
  return /^\d+$/.test(expires || '') && Number(expires) > Date.now() && !!mac && equal(mac, await signature(secret, expires));
}
app.onError((error, c) => {
  console.error(error.message);
  return c.json({ error: '処理に失敗しました。通信を確認してもう一度お試しください。' }, 500);
});
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '別のサイトからの操作はできません。' }, 403);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'JSONリクエストが必要です。' }, 415);
  }
  if (accessEnabled(c.env)) {
    if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return c.json({ error: 'サーバーのAccess認証設定が不完全です。' }, 503);
    if (!await accessClaims(c)) return c.json({ error: 'Cloudflare Accessでログインしてください。' }, 401);
  } else if (!c.env.APP_PASSWORD && !loopback(c.req.url)) return c.json({ error: 'サーバーのAPP_PASSWORDが未設定です。' }, 503);
  if (c.req.header('Authorization')) {
    if (!await authorizeBearer(c)) return c.json({ error: 'APIトークンまたは権限が無効です。' }, 401);
  } else if (!['/api/session', '/api/login'].includes(c.req.path) && !await authenticated(c)) return c.json({ error: 'ログインしてください。' }, 401);
  else c.set('actor','session');
  await next();
});
app.route('/api/manage', manager);
app.route('/api/practice', practice);
app.route('/api/study-options', studyOptions);
app.get('/api/session', async c => c.json({ authenticated: await authenticated(c), passwordRequired: !accessEnabled(c.env) && !!c.env.APP_PASSWORD, ...(accessEnabled(c.env) ? { logoutUrl: '/cdn-cgi/access/logout' } : {}) }));
app.post('/api/login', async c => {
  if (accessEnabled(c.env)) return c.json({ error: 'Cloudflare Accessを使ってログインしてください。' }, 403);
  const body = await c.req.json().catch(() => null) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string' || body.password.length > 1024) return c.json({ error: 'パスワードを入力してください。' }, 400);
  if (!c.env.APP_PASSWORD) return c.json({ authenticated: true });
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const key = await digest(ip);
  const now = Date.now();
  const attempt = await c.env.DB.prepare('SELECT failures,since FROM login_attempts WHERE key=?').bind(key).first<{ failures: number; since: number }>();
  if (attempt && now - attempt.since < 900000 && attempt.failures >= 10) return c.json({ error: '試行回数が多いため、15分ほど待ってください。' }, 429);
  if (!equal(await digest(body.password), await digest(c.env.APP_PASSWORD))) {
    await c.env.DB.prepare('INSERT INTO login_attempts(key,failures,since) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN ?-since>=900000 THEN 1 ELSE failures+1 END, since=CASE WHEN ?-since>=900000 THEN ? ELSE since END').bind(key,now,now,now,now).run();
    return c.json({ error: 'パスワードが違います。' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(key).run();
  const expires = String(now + 30 * 86400000);
  setCookie(c, cookieName, `${expires}.${await signature(c.env.APP_PASSWORD, expires)}`, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: 30 * 86400 });
  return c.json({ authenticated: true });
});
app.post('/api/logout', c => {
  deleteCookie(c, cookieName, { path: '/' });
  return c.json({ ok: true, ...(accessEnabled(c.env) ? { logoutUrl: '/cdn-cgi/access/logout' } : {}) });
});

interface Metadata { source: ImportDocument['source']; collection: ImportDocument['collection'] }
function completedForToday(state: ScheduleState, reviewedAt: number, collection?: ImportDocument['collection']): boolean {
  return state.state===2||state.scheduledDays>0||!!collection&&
    state.due>=nextStudyDayBoundary(reviewedAt,collection.timeZone,collection.dayStart);
}
async function metadata(db: D1Database) {
  const row = await db.prepare('SELECT metadata,warnings FROM collections WHERE id=1').first<{ metadata: string; warnings: string }>();
  return row ? { ...json<Metadata>(row.metadata), warnings: json<string[]>(row.warnings) } : null;
}
async function getDeck(db: D1Database, id: string) {
  const row = await db.prepare('SELECT data FROM decks WHERE id=?').bind(id).first<{ data: string }>();
  return row ? json<Deck>(row.data) : null;
}
/** Timestamp of the current study-day rollover in the collection's timezone. */
export function dayBoundary(now: number, zone: string, hour: number): number {
  return studyDayBoundary(now,zone,hour);
}
async function restoreBuried(db: D1Database, meta: Metadata, now: number) {
  const importedAt = Date.parse(meta.source.importedAt);
  if (dayBoundary(now,meta.collection.timeZone,meta.collection.dayStart) > dayBoundary(importedAt,meta.collection.timeZone,meta.collection.dayStart)) {
    await db.prepare(`UPDATE cards SET queue=CASE WHEN state=0 THEN 0 WHEN state=2 THEN 2
      WHEN last_event_id IS NULL AND json_extract(original,'$.queue')=3 THEN 3
      WHEN last_event_id IS NOT NULL AND json_extract(schedule,'$.scheduledDays')>0 AND NOT (
        json_extract(original,'$.queue')=1 AND json_extract(schedule,'$.reps')=json_extract(original,'$.reps')
        AND json_extract(schedule,'$.lastReview') IS json_extract(original,'$.lastReview')) THEN 3 ELSE 1 END WHERE queue IN (-2,-3)`).run();
  }
}
async function deckSummaries(db: D1Database, _meta: Metadata, now: number) {
  const ctx=await studyContext(db,now);
  if(!ctx)return [];
  await preloadOverviewCandidates(ctx);
  for(const deck of ctx.decks) {
    const candidates=await studyCandidates(ctx,deck.id);
    if(candidates)deck.counts=candidates.counts;
  }
  return ctx.decks;
}
app.get('/api/overview', async c => {
  const meta = await metadata(c.env.DB);
  if (!meta) return c.json({ imported: false, decks: [], warnings: [] });
  const now = Date.now();
  await restoreBuried(c.env.DB,meta,now);
  const decks = await deckSummaries(c.env.DB,meta,now);
  return c.json({ imported: true, decks, warnings: meta.warnings, source: meta.source, collection: meta.collection });
});
app.get('/api/progress', async c => {
  const meta = await metadata(c.env.DB);
  return c.json(meta ? await progress(c.env.DB,meta.collection,Date.now()) : null);
});
app.get('/api/study/:deck', async c => {
  const focusQuery=c.req.queries('focusIds');
  const focusIds=focusQuery?.[0]?.split(',');
  if(focusQuery&&(focusQuery.length!==1||!validFocusIds(focusIds)))return c.json({error:'集中学習のカード指定が不正です。'},400);
  const meta = await metadata(c.env.DB);
  if (!meta) return c.json({ error: 'デッキが見つかりません。' }, 404);
  const now = Date.now();
  await restoreBuried(c.env.DB,meta,now);
  const ctx=(await studyContext(c.env.DB,now))!;
  const decks=ctx.decks;
  const deck=decks.find(d=>d.id===c.req.param('deck'));
  if(!deck)return c.json({error:'デッキが見つかりません。'},404);
  const candidates=(await studyCandidates(ctx,deck.id,focusIds))!;
  const options=(await optionsResponse(ctx,deck.id,false))!;
  const restart=options.restart;
  const status={...options,restart:restart?((({days: _days,...summary})=>summary)(restart)):null};
  const counts={status,counts:candidates.counts,answeredToday:deck.answeredToday,studyDayBoundary:ctx.boundary,
    learningPending:candidates.learningPending,nextLearningDue:candidates.nextLearningDue,candidateIds:candidates.candidateIds,
    ...(candidates.focusRemainingIds?{focusRemainingIds:candidates.focusRemainingIds}:{})};
  const row=candidates.row;
  if(!row)return c.json({card:null,...counts,nextDue:candidates.nextDue} satisfies StudyResponse);
  const n = await c.env.DB.prepare('SELECT data FROM notes WHERE id=?').bind(row.note_id).first<{ data: string }>();
  const note = json<Note>(n!.data);
  const nt = await c.env.DB.prepare('SELECT data FROM note_types WHERE id=?').bind(note.noteTypeId).first<{ data: string }>();
  const state = json<ScheduleState>(row.schedule);
  const cardDeck = decks.find(deck => deck.id === row.deck_id)!;
  // The selected parent controls scope; the card's own deck controls scheduling.
  const actualDeck: Deck = { id: cardDeck.id, name: cardDeck.name, configId: cardDeck.configId,
    config: cardDeck.config, ...(cardDeck.raw === undefined ? {} : { raw: cardDeck.raw }) };
  return c.json({ card: { id: row.id, revision: row.revision, ordinal: row.ordinal, schedule: state,
    note, noteType: json<NoteType>(nt!.data), deck: actualDeck,
    preview: preview(state,now,schedulerConfig(actualDeck,meta.collection)) }, ...counts, nextDue: candidates.nextDue } satisfies StudyResponse);
});
app.post('/api/review', async c => {
  const body = await c.req.json().catch(() => null) as { eventId: string; cardId: string; revision: number; rating: 1 | 2 | 3 | 4; deckId?: string; focusIds?:string[] } | null;
  if (!body || !/^[a-zA-Z0-9-]{16,80}$/.test(body.eventId) || !/^\d+$/.test(body.cardId) || !Number.isInteger(body.revision) || ![1,2,3,4].includes(body.rating) || (body.deckId!==undefined&&typeof body.deckId!=='string') || (body.focusIds!==undefined&&!validFocusIds(body.focusIds))) return c.json({ error: '回答データが不正です。' }, 400);
  const existing = await c.env.DB.prepare('SELECT card_id,rating,after_revision,after_state,reviewed_at,undone FROM review_events WHERE id=?').bind(body.eventId).first<{ card_id: string; rating: number; after_revision: number; after_state:string; reviewed_at:number; undone: number }>();
  if (existing) {
    if (existing.card_id !== body.cardId || existing.rating !== body.rating || existing.after_revision !== body.revision + 1 || existing.undone) return c.json({ error: '回答IDが別の操作に使用されています。' }, 409);
    const meta=await metadata(c.env.DB);
    const after=json<ScheduleState>(existing.after_state);
    return c.json({ ok: true, eventId: body.eventId, duplicate: true,schedule:after,
      completedForToday:completedForToday(after,existing.reviewed_at,meta?.collection),
      ...(meta?{studyDayBoundary:studyDayBoundary(existing.reviewed_at,meta.collection.timeZone,meta.collection.dayStart)}:{}) });
  }
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id=?').bind(body.cardId).first<StoredCard>();
  if (!card || card.queue < 0) return c.json({ error: 'このカードは回答できません。' }, 404);
  if (card.revision !== body.revision) return c.json({ error: '別の画面で更新されました。カードを読み直してください。' }, 409);
  const deck = await getDeck(c.env.DB,card.deck_id);
  const meta = await metadata(c.env.DB);
  if (!deck || !meta) return c.json({ error: 'デッキが見つかりません。' }, 404);
  const now = Date.now();
  const ctx=(await studyContext(c.env.DB,now))!;
  const admission=answerAdmission(ctx,card,body.deckId);
  if(!admission)return c.json({error:'選択したデッキのカードではありません。'},409);
  if(body.focusIds&&!body.focusIds.includes(card.id))return c.json({error:'集中学習の対象カードではありません。'},409);
  const before = json<ScheduleState>(card.schedule);
  if (card.queue !== 0 && before.due > now) {
    const candidates=intradayLearning(card)?await studyCandidates(ctx,body.deckId??card.deck_id,body.focusIds):null;
    if(candidates?.row?.id!==card.id)return c.json({ error: 'まだ復習時刻になっていません。' }, 409);
  }
  const after = schedule(before,body.rating,now,schedulerConfig(deck,meta.collection));
  const afterText = JSON.stringify(after);
  const queue = after.state === 2 ? 2 : after.scheduledDays > 0 ? 3 : 1;
  const result = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE cards SET schedule=?,state=?,due=?,queue=?,revision=revision+1,last_event_id=? WHERE id=? AND revision=? AND queue>=0 AND '+admission.sql)
      .bind(afterText,after.state,after.due,queue,body.eventId,card.id,body.revision,...admission.args),
    c.env.DB.prepare(`INSERT OR IGNORE INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision,restart_id,restart_backlog,restart_available_at,restart_extra_deck_id,ordinary_extra_deck_id)
      SELECT ?,id,deck_id,?,?,?,schedule,revision,?,?,?,?,? FROM cards WHERE id=? AND revision=? AND last_event_id=?`)
      .bind(body.eventId,body.rating,now,card.schedule,admission.restartId??admission.member?.restart_id??null,admission.member?.backlog??0,admission.member?.available_at??null,admission.extraDeckId??null,admission.ordinaryExtraDeckId??null,card.id,body.revision+1,body.eventId),
    c.env.DB.prepare(`UPDATE study_restart_members SET answered_event_id=? WHERE card_id=? AND revision=? AND EXISTS(SELECT 1 FROM cards WHERE id=? AND last_event_id=? AND revision=?)`)
      .bind(body.eventId,card.id,card.revision,card.id,body.eventId,card.revision+1),
  ]);
  if (!result[0].meta.changes) {
    const retry = await c.env.DB.prepare('SELECT after_state,reviewed_at FROM review_events WHERE id=? AND card_id=? AND rating=? AND after_revision=? AND undone=0').bind(body.eventId,body.cardId,body.rating,body.revision+1).first<{after_state:string;reviewed_at:number}>();
    return retry ? c.json({ ok: true, eventId: body.eventId, duplicate: true,schedule:json<ScheduleState>(retry.after_state),
      completedForToday:completedForToday(json<ScheduleState>(retry.after_state),retry.reviewed_at,meta.collection),
      studyDayBoundary:studyDayBoundary(retry.reviewed_at,meta.collection.timeZone,meta.collection.dayStart) }) : c.json({ error: '別の画面で更新されました。カードを読み直してください。' }, 409);
  }
  return c.json({ ok: true, eventId: body.eventId, schedule: after,studyDayBoundary:ctx.boundary,
    completedForToday:completedForToday(after,now,meta.collection) });
});
app.post('/api/undo', async c => {
  const body = await c.req.json().catch(() => null) as { eventId?: unknown } | null;
  if (!body || typeof body.eventId !== 'string') return c.json({ error: '取り消す回答が不正です。' }, 400);
  const event = await c.env.DB.prepare('SELECT e.*,(SELECT original FROM cards WHERE id=e.card_id) AS original FROM review_events e WHERE id=?').bind(body.eventId).first<{ card_id: string; before_state: string; after_revision: number; undone: number; original:string|null; restart_id?:string|null; restart_available_at?:number|null }>();
  if (!event) return c.json({ error: '回答が見つかりません。' }, 404);
  if (event.undone) return c.json({ ok: true, duplicate: true });
  const before = json<ScheduleState>(event.before_state);
  const beforeQueue=before.state===0?0:before.state===2?2:before.scheduledDays>0&&!(event.original&&importedIntraday(before,event.original))?3:1;
  const marker = `undo:${body.eventId}`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE cards SET schedule=?,state=?,due=?,suspended_queue=CASE WHEN queue=-1 THEN ? ELSE suspended_queue END,queue=CASE WHEN queue=-1 THEN -1 ELSE ? END,revision=revision+1,last_event_id=? WHERE id=? AND revision=? AND last_event_id=?')
      .bind(event.before_state,before.state,before.due,beforeQueue,beforeQueue,marker,event.card_id,event.after_revision,body.eventId),
    c.env.DB.prepare('UPDATE review_events SET undone=1 WHERE id=? AND EXISTS(SELECT 1 FROM cards WHERE id=? AND revision=? AND last_event_id=?)')
      .bind(body.eventId,event.card_id,event.after_revision+1,marker),
    c.env.DB.prepare(`UPDATE study_restart_members SET answered_event_id=NULL,revision=? WHERE card_id=? AND answered_event_id=?
      AND EXISTS(SELECT 1 FROM cards WHERE id=? AND revision=? AND last_event_id=?)`)
      .bind(event.after_revision+1,event.card_id,body.eventId,event.card_id,event.after_revision+1,marker),
  ]);
  return results[0].meta.changes ? c.json({ ok: true, cardId: event.card_id }) : c.json({ error: 'このカードはその後に更新されているため、取り消せません。' }, 409);
});
app.get('/api/export', async c => {
  const meta = await metadata(c.env.DB);
  const [decks,types,notes,cards,history,events,media,contentHistory,practiceSessions,practiceMembers,practiceEvents,practiceReceipts,studyExtras,studyRestarts,studyMembers,studyReceipts,studyPreviews,studyGeneration] = await Promise.all([
    c.env.DB.prepare('SELECT data FROM decks').all(), c.env.DB.prepare('SELECT data FROM note_types').all(),
    c.env.DB.prepare('SELECT data FROM notes').all(), c.env.DB.prepare('SELECT id,note_id,deck_id,ordinal,original,schedule,revision,queue,suspended_queue FROM cards').all(),
    c.env.DB.prepare('SELECT data FROM imported_reviews').all(), c.env.DB.prepare('SELECT * FROM review_events').all(),
    c.env.DB.prepare('SELECT * FROM media').all(), c.env.DB.prepare('SELECT * FROM content_history').all(),
    c.env.DB.prepare('SELECT * FROM practice_sessions').all(), c.env.DB.prepare('SELECT * FROM practice_members').all(),
    c.env.DB.prepare('SELECT * FROM practice_events').all(), c.env.DB.prepare('SELECT * FROM practice_receipts').all(),
    c.env.DB.prepare('SELECT * FROM study_extras').all(), c.env.DB.prepare('SELECT * FROM study_restarts').all(),
    c.env.DB.prepare('SELECT * FROM study_restart_members').all(), c.env.DB.prepare('SELECT * FROM study_receipts').all(),
    c.env.DB.prepare('SELECT * FROM study_previews').all(), c.env.DB.prepare('SELECT * FROM study_generation').all(),
  ]);
  c.header('Content-Disposition', 'attachment; filename="dopanki-backup.json"');
  return c.json({ format: 'dopanki-backup', schemaVersion: 1, exportedAt: new Date().toISOString(), metadata: meta,
    decks: decks.results.map(r => json(String(r.data))), noteTypes: types.results.map(r => json(String(r.data))),
    notes: notes.results.map(r => json(String(r.data))), cards: cards.results.map(r => ({ ...r, original: json(String(r.original)), schedule: json(String(r.schedule)) })),
    importedReviews: history.results.map(r => json(String(r.data))), reviewEvents: events.results, media: media.results, contentHistory: contentHistory.results,
    practiceSessions: practiceSessions.results, practiceMembers: practiceMembers.results, practiceEvents: practiceEvents.results, practiceReceipts: practiceReceipts.results,
    studyExtras: studyExtras.results, studyRestarts: studyRestarts.results, studyRestartMembers: studyMembers.results,
    studyReceipts: studyReceipts.results, studyPreviews: studyPreviews.results, studyGeneration: studyGeneration.results });
});
app.get('/media/:name', async c => {
  if (!await authenticated(c)) return c.text('Unauthorized', 401);
  const name = c.req.param('name');
  const row = await c.env.DB.prepare('SELECT object_key FROM media WHERE name=?').bind(name).first<{ object_key: string }>();
  if (!row) return c.notFound();
  const object = await c.env.MEDIA.get(row.object_key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
});
app.all('/api/*', c => c.json({ error: 'APIが見つかりません。' }, 404));
app.get('*', c => c.env.ASSETS.fetch(c.req.raw));
export default app;
