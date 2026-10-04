import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server/index';
import { importStatements } from '../src/lib/import';
import type { ProgressResponse } from '../src/lib/types';
import type { ScheduleState } from '../src/lib/scheduler';
import { fixture } from './fixture';
import { TestDb } from './test-db';

let db: TestDb;
function request(path = '/api/progress', body?: unknown, password?: string, headers?: Record<string,string>) {
  return app.request(`http://localhost${path}`, body === undefined ? { headers } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }, { DB: db as unknown as D1Database, APP_PASSWORD: password, MEDIA: {} as R2Bucket, ASSETS: {} as Fetcher });
}
async function readProgress() {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json() as Promise<ProgressResponse>;
}
function imported(id: string, time: string, type = 1, rating = 3) {
  const review = { ...fixture().reviews[0], id, reviewedAt: Date.parse(time), type, rating };
  db.sqlite.prepare('INSERT INTO imported_reviews(id,card_id,data) VALUES(?,?,?)').run(id,'1',JSON.stringify(review));
}
function state(due: number, value = 2): ScheduleState {
  return { state: value, due, stability: value ? 21 : 0, difficulty: value ? 4 : 0,
    elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, lastReview: null, learningSteps: 0 };
}
function card(id: string, schedule: ScheduleState, queue = schedule.state, revision = 0) {
  db.sqlite.prepare(`INSERT OR REPLACE INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,revision)
    VALUES(?,'1','1',0,?,?,?,?,?,?)`).run(id,queue,schedule.state,schedule.due,JSON.stringify(schedule),'{}',revision);
}
function event(id: string, cardId: string, before: ScheduleState, after: ScheduleState, revision: number, undone = 0) {
  db.sqlite.prepare(`INSERT INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision,undone)
    VALUES(?,?,'1',3,?,?,?,?,?)`).run(id,cardId,Date.now(),JSON.stringify(before),JSON.stringify(after),revision,undone);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T18:59:00Z'));
  db = new TestDb();
  for (const migration of ['0001_initial','0002_history_time','0003_authoring']) {
    db.sqlite.exec(readFileSync(`migrations/${migration}.sql`,'utf8'));
  }
  db.sqlite.exec(importStatements(fixture()).join(';')+';');
  db.sqlite.exec('DELETE FROM imported_reviews');
});
afterEach(() => { db.sqlite.close(); vi.useRealTimers(); });

describe('progress calendar and tomorrow workload', () => {
  it('counts only rated answers, assigns imported rollover boundaries, and retains older study days outside the 182-day window', async () => {
    imported('old','2026-01-01T00:00:00Z');
    imported('monday','2026-09-28T00:00:00Z');
    imported('before-rollover','2026-10-03T18:59:59.999Z');
    imported('at-rollover','2026-10-03T19:00:00Z',0);
    imported('repeat','2026-10-04T02:00:00Z',3);
    imported('manual','2026-10-04T03:00:00Z',4);
    imported('unrated','2026-10-04T04:00:00Z',1,0);
    imported('future','2026-10-04T19:00:00Z');
    const result = await readProgress();
    expect(result.today).toBe('2026-10-04');
    expect(result.days).toHaveLength(182);
    expect(result.days[0]).toEqual({ date: '2026-04-06', answers: 0 });
    expect(result.days.at(-1)).toEqual({ date: '2026-10-04', answers: 2 });
    expect(result.days.find(day => day.date === '2026-10-03')?.answers).toBe(1);
    expect(result).toMatchObject({ totalStudyDays: 4, weekStudyDays: 3, todayAnswers: 2 });
    expect(result.tomorrow).toEqual({ reviewedCards: 0, movedBeyondTomorrow: 0, addedForTomorrow: 0, netReduction: 0, dueCards: 1 });
  });

  it('counts a retried answer once and removes its calendar and tomorrow contribution after undo', async () => {
    const before = db.sqlite.prepare('SELECT * FROM cards').get();
    const answer = { eventId: 'progress-answer-0001', cardId: '1', revision: 0, rating: 4 };
    expect((await request('/api/review',answer)).status).toBe(200);
    expect((await request('/api/review',answer)).status).toBe(200);
    expect(await readProgress()).toMatchObject({ todayAnswers: 1, totalStudyDays: 1,
      tomorrow: { reviewedCards: 1, movedBeyondTomorrow: 1, netReduction: 1, dueCards: 0 } });
    expect((await request('/api/undo',{ eventId: answer.eventId })).status).toBe(200);
    expect((await request('/api/undo',{ eventId: answer.eventId })).status).toBe(200);
    expect(await readProgress()).toMatchObject({ todayAnswers: 0, totalStudyDays: 0,
      tomorrow: { reviewedCards: 0, movedBeyondTomorrow: 0, netReduction: 0, dueCards: 1 } });
    expect(db.sqlite.prepare('SELECT schedule FROM cards').get()?.schedule).toBe(before?.schedule);
  });

  it('compares each active card once using revision order, includes new learning and signed increases, and excludes the end boundary', async () => {
    const cutoff = Date.parse('2026-10-05T19:00:00Z');
    const near = state(cutoff-1), far = state(cutoff), fresh = state(Date.now(),0);
    // Equal timestamps and reverse lexical IDs deliberately disagree with revision order.
    card('1',far,2,3);
    event('z-first','1',near,far,1);
    event('a-middle','1',far,near,2);
    event('m-last','1',near,far,3);
    card('2',near,1,1); event('new-learning','2',fresh,state(cutoff-1,1),1);
    card('3',near,2,1); event('added-existing','3',far,near,1);
    card('4',far,2,1); event('new-long','4',fresh,far,1);
    card('5',far,-1,1); event('suspended','5',near,far,1);
    card('6',near,2,2); event('undone','6',near,far,1,1);
    // Future event does not affect today's effort or workload change.
    event('future','6',near,far,3);
    db.sqlite.prepare('UPDATE review_events SET reviewed_at=? WHERE id=?').run(Date.now()+1,'future');
    const result = await readProgress();
    expect(result.todayAnswers).toBe(7);
    expect(result.tomorrow).toEqual({ reviewedCards: 4, movedBeyondTomorrow: 1, addedForTomorrow: 1, netReduction: -1, dueCards: 3 });
    // Suspending cards affects current workload, while their completed answers remain in history.
    db.sqlite.exec("UPDATE cards SET queue=-1 WHERE id IN ('2','3')");
    expect(await readProgress()).toMatchObject({ todayAnswers: 7,
      tomorrow: { reviewedCards: 2, movedBeyondTomorrow: 1, addedForTomorrow: 0, netReduction: 1, dueCards: 1 } });
  });

  it.each([
    { now: '2026-03-08T12:00:00Z', dayStart: 2, before: '2026-03-08T06:59:59.999Z', at: '2026-03-08T07:00:00Z', today: '2026-03-08', previous: '2026-03-07', cutoff: '2026-03-10T06:00:00Z' },
    { now: '2026-11-01T12:00:00Z', dayStart: 1, before: '2026-11-01T04:59:59.999Z', at: '2026-11-01T05:00:00Z', today: '2026-11-01', previous: '2026-10-31', cutoff: '2026-11-03T06:00:00Z' },
  ])('uses local study days across DST ($today)', async ({ now, dayStart, before, at, today, previous, cutoff }) => {
    vi.setSystemTime(new Date(now));
    const meta = JSON.parse(String(db.sqlite.prepare('SELECT metadata FROM collections').get()?.metadata));
    meta.collection.timeZone = 'America/New_York'; meta.collection.dayStart = dayStart;
    db.sqlite.prepare('UPDATE collections SET metadata=?').run(JSON.stringify(meta));
    imported('before',before); imported('at',at);
    card('1',state(Date.parse(cutoff)-1)); card('2',state(Date.parse(cutoff)));
    const result = await readProgress();
    expect(result.today).toBe(today);
    expect(result.days.find(day => day.date === previous)?.answers).toBe(1);
    expect(result.todayAnswers).toBe(1);
    expect(result.totalStudyDays).toBe(2);
    expect(result.tomorrow.dueCards).toBe(1);
  });

  it('requires the normal session, bars management bearer credentials, and returns null before collection setup', async () => {
    expect((await request('/api/progress',undefined,'secret')).status).toBe(401);
    const login = await request('/api/login',{ password: 'secret' },'secret');
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    expect((await request('/api/progress',undefined,'secret',{ Cookie: cookie })).status).toBe(200);
    expect((await request('/api/progress',undefined,'secret',{ Cookie: cookie, Authorization: 'Bearer management-token' })).status).toBe(401);
    db.sqlite.exec('DELETE FROM collections');
    expect(await (await request()).json()).toBeNull();
  });
});
