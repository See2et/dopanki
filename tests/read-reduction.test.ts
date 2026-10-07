import { readFileSync,readdirSync } from 'node:fs';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { TestDb } from './test-db';
import { fixture } from './fixture';
import { importStatements } from '../src/lib/import';
import { app } from '../src/server/index';
import { studyCandidates,studyContext,preloadOverviewCandidates } from '../src/server/study-options';
import type { ProgressResponse } from '../src/lib/types';

let db:TestDb;
const now=Date.parse('2026-10-04T18:59:00Z');
const migrations=readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort();
function migrate(files=migrations) { for(const f of files)db.sqlite.exec(readFileSync(`migrations/${f}`,'utf8')); }
function seed() {db.sqlite.exec(importStatements(fixture()).join(';')+';');db.sqlite.exec('DELETE FROM imported_reviews');}
function imported(id:string,at:number,rating=3) {
  db.sqlite.prepare('INSERT INTO imported_reviews(id,card_id,data) VALUES(?,\'1\',?)')
    .run(id,JSON.stringify({...fixture().reviews[0],id,reviewedAt:at,rating,type:1}));
}
async function request(path='/api/progress') {
  return app.request(`http://localhost${path}`,{}, {DB:db as unknown as D1Database,MEDIA:{} as R2Bucket,ASSETS:{} as Fetcher});
}
async function progress() {const r=await request();expect(r.status).toBe(200);return await r.json() as ProgressResponse;}
function plan(sql:string,args:(string|number|null)[]=[]) {
  return db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r=>String(r.detail)).join('\n');
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);db=new TestDb();});
afterEach(()=>{db.sqlite.close();vi.useRealTimers();});

describe('read reduction: SQLite plans and materialized resource bounds (not D1 rows_read)',()=>{
  it('migrates an existing large history without loss, backfills days in SQL, and reuses the historical projection',async()=>{
    migrate(migrations.slice(0,-1));seed();
    const at=Date.parse('2025-01-01T00:00:00Z');
    db.sqlite.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<40000)
      INSERT INTO imported_reviews SELECT 'old-'||i,'1',json_object('reviewedAt',?+i,'rating',3,'type',1) FROM n`).run(at);
    const schedule=String(db.sqlite.prepare('SELECT schedule FROM cards').get()?.schedule);
    db.sqlite.prepare(`INSERT INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision)
      VALUES('old-normal','1','1',3,?,?,?,1)`).run(at,schedule,schedule);
    db.sqlite.exec(`INSERT INTO practice_sessions(id,name,deck_ids,ordering,created_at) VALUES('old-session','p','["1"]','deck','now')`);
    db.sqlite.prepare(`INSERT INTO practice_events(id,session_id,round,card_id,rating,reviewed_at) VALUES('old-practice','old-session',1,'1',3,?)`).run(at);
    const before=db.sqlite.prepare('SELECT COUNT(*) count FROM imported_reviews').get();
    migrate(migrations.slice(-1));
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM imported_reviews').get()).toEqual(before);
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM review_events').get()?.count).toBe(1);
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM practice_events').get()?.count).toBe(1);
    expect((await progress()).totalStudyDays).toBe(1);
    expect(db.sqlite.prepare('SELECT SUM(answers) answers FROM progress_days').get()?.answers).toBe(40002);
    const historical=db.sqlite.prepare('SELECT * FROM progress_days').all();
    db.reads=[];let writes=0;db.beforeRun=()=>{writes++;};
    const start=db.queries;expect((await progress()).totalStudyDays).toBe(1);
    expect(db.queries-start).toBeLessThan(10);expect(writes).toBe(0);
    expect(db.sqlite.prepare('SELECT * FROM progress_days').all()).toEqual(historical);
    expect(db.reads.filter(r=>r.method==='all')).toEqual([expect.objectContaining({rows:0,sql:expect.stringContaining('progress_dirty')})]);
    const read=db.reads.find(r=>r.sql.includes('WITH contributions'))!;
    const detail=plan(read.sql,read.args);
    expect(detail).toContain('imported_reviews_time');
    expect(detail).toContain('review_events_active_time (reviewed_at>? AND reviewed_at<?)');
    expect(detail).toContain('practice_events_active_time (reviewed_at>? AND reviewed_at<?)');
    // Historical reviews only participate in the cold/dirty-date build, not repeated reads.
    expect(read.args[2]).toBe(JSON.stringify([
      ['2026-10-04','2026-10-04',Date.parse('2026-10-04T00:00:00Z'),now+1,now],
    ]));
  });

  it('keeps fractional imported timestamps in their exact UTC bucket and excludes even sub-millisecond future answers',async()=>{
    migrate(migrations.slice(0,-1));seed();
    const at=Date.parse('2025-01-01T23:59:59.999Z')+0.5;imported('fraction',at);
    migrate(migrations.slice(-1));
    expect(db.sqlite.prepare('SELECT utc_day FROM progress_dirty').get()?.utc_day).toBe('2025-01-01');
    imported('future',now+0.5);expect(await progress()).toMatchObject({totalStudyDays:1,todayAnswers:0});
    expect(db.sqlite.prepare('SELECT SUM(answers) n FROM progress_days').get()?.n).toBe(1);
    db.sqlite.prepare("UPDATE imported_reviews SET data=json_set(data,'$.reviewedAt',?) WHERE id='fraction'").run(at+1);
    await progress();expect(db.sqlite.prepare("SELECT SUM(answers) n FROM progress_days WHERE utc_day='2025-01-01'").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT SUM(answers) n FROM progress_days WHERE utc_day='2025-01-02'").get()?.n).toBe(1);
  });

  it('bounds exceptionally large cold builds below the D1 Free statement budget and resumes without serving truncated history',async()=>{
    migrate(migrations.slice(0,-1));seed();
    const at=Date.parse('2004-01-01T00:00:00Z');
    db.sqlite.prepare(`WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<8192)
      INSERT INTO imported_reviews SELECT 'day-'||i,'1',json_object('reviewedAt',?+i*86400000,'rating',3,'type',1) FROM n`).run(at);
    migrate(migrations.slice(-1));const start=db.queries;
    expect((await request()).status).toBe(500);expect(db.queries-start).toBeLessThan(50);
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM progress_buckets').get()?.n).toBe(8192);
    expect(await progress()).toMatchObject({totalStudyDays:8193});
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM imported_reviews').get()?.n).toBe(8193);
  });

  it('refreshes only changed historical UTC dates, and supports calendar changes, deletion, eligibility edits and future visibility',async()=>{
    migrate();seed();
    const old=Date.parse('2025-01-01T18:59:59Z'),other=Date.parse('2025-06-01T00:00:00Z');
    imported('before',old);imported('after',old+2000);imported('other',other);imported('future',now+0.5);
    expect((await progress()).totalStudyDays).toBe(3);
    const untouched=db.sqlite.prepare("SELECT * FROM progress_buckets WHERE utc_day='2025-06-01'").get();
    db.sqlite.exec("UPDATE imported_reviews SET data=json_set(data,'$.rating',0) WHERE id='before'");
    db.reads=[];expect((await progress()).totalStudyDays).toBe(2);
    expect(db.reads.find(r=>r.method==='all')?.rows).toBe(1);
    expect(db.sqlite.prepare("SELECT * FROM progress_buckets WHERE utc_day='2025-06-01'").get()).toEqual(untouched);
    db.sqlite.exec("DELETE FROM imported_reviews WHERE id='after'");
    expect((await progress()).totalStudyDays).toBe(1);
    vi.setSystemTime(now+1);expect(await progress()).toMatchObject({todayAnswers:1,totalStudyDays:2});
    const meta=JSON.parse(String(db.sqlite.prepare('SELECT metadata FROM collections').get()?.metadata));
    meta.collection.timeZone='America/New_York';meta.collection.dayStart=1;
    db.sqlite.prepare('UPDATE collections SET metadata=?').run(JSON.stringify(meta));
    const changed=await progress();expect(changed.totalStudyDays).toBe(2);expect(changed.todayAnswers).toBe(1);
    expect(db.sqlite.prepare('SELECT COUNT(DISTINCT calendar) calendars FROM progress_buckets').get()?.calendars).toBe(2);
  });

  it('rejects stale publication and retries a concurrent history mutation; failed batches never mark a partial build clean',async()=>{
    migrate();seed();const old=Date.parse('2025-01-01T00:00:00Z');imported('one',old);
    db.afterAll=sql=>{if(sql.includes('progress_dirty')){db.afterAll=undefined;imported('two',old+1);}};
    expect((await progress()).totalStudyDays).toBe(1);
    expect(db.sqlite.prepare('SELECT SUM(answers) answers FROM progress_days').get()?.answers).toBe(2);
    imported('three',old+2);
    db.beforeRun=sql=>{if(sql.includes('INSERT INTO progress_buckets'))throw new Error('simulated publication failure');};
    expect((await request()).status).toBe(500);
    expect(db.sqlite.prepare('SELECT SUM(answers) answers FROM progress_days').get()?.answers).toBe(2);
    expect(db.sqlite.prepare(`SELECT b.revision=d.revision clean FROM progress_buckets b JOIN progress_dirty d USING(utc_day)`).get()?.clean).toBe(0);
    db.beforeRun=undefined;await progress();
    expect(db.sqlite.prepare('SELECT SUM(answers) answers FROM progress_days').get()?.answers).toBe(3);
  });

  it('invalidates old normal/practice dates on undo, time moves and delete, with canonical histories intact',async()=>{
    migrate();seed();const old=Date.parse('2025-01-01T00:00:00Z');
    const schedule=String(db.sqlite.prepare('SELECT schedule FROM cards').get()?.schedule);
    db.sqlite.prepare(`INSERT INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision)
      VALUES('normal','1','1',3,?,?,?,1)`).run(old,schedule,schedule);
    db.sqlite.exec(`INSERT INTO practice_sessions(id,name,deck_ids,ordering,created_at) VALUES('p','p','["1"]','deck','now')`);
    db.sqlite.prepare(`INSERT INTO practice_events(id,session_id,round,card_id,rating,reviewed_at) VALUES('practice','p',1,'1',3,?)`).run(old);
    await progress();expect(db.sqlite.prepare('SELECT SUM(answers) n FROM progress_days').get()?.n).toBe(2);
    db.sqlite.exec("UPDATE review_events SET undone=1 WHERE id='normal'");
    db.sqlite.prepare("UPDATE practice_events SET reviewed_at=? WHERE id='practice'").run(old+86400000);
    await progress();expect(db.sqlite.prepare("SELECT SUM(answers) n FROM progress_days WHERE study_date='2025-01-01'").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT SUM(answers) n FROM progress_days WHERE study_date='2025-01-02'").get()?.n).toBe(1);
    db.sqlite.exec("DELETE FROM practice_events WHERE id='practice'");
    expect((await progress()).totalStudyDays).toBe(0);
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events').get()?.n).toBe(1);
  });

  it('bounds scoped/focused card materialization and uses one explicit overview cache without poisoning sibling/parent scopes',async()=>{
    migrate();seed();
    const deck=fixture().decks[0];
    db.sqlite.prepare('INSERT INTO decks(id,name,data) VALUES(\'2\',\'Other\',?)').run(JSON.stringify({...deck,id:'2',name:'Other'}));
    db.sqlite.exec(`WITH RECURSIVE n(i) AS(SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<4001)
      INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original)
      SELECT CAST(i AS TEXT),'1','2',0,queue,state,due,schedule,original FROM n,cards WHERE cards.id='1'`);
    const ctx=(await studyContext(db as unknown as D1Database,now))!;
    db.reads=[];const first=(await studyCandidates(ctx,'1'))!;expect(first.row?.id).toBe('1');
    const read=db.reads.find(r=>r.method==='all')!;expect(read.rows).toBe(1);expect(plan(read.sql,read.args)).toContain('cards_due (deck_id=? AND queue>?)');
    expect(ctx.cards).toBeUndefined();expect((await studyCandidates(ctx,'2'))!.counts.total).toBe(4000);
    db.reads=[];const focused=(await studyCandidates(ctx,'2',['2','3']))!;
    expect(focused.counts.total).toBe(2);expect(focused.focusRemainingIds).toEqual(['2','3']);
    const focusRead=db.reads.find(r=>r.method==='all')!;expect(focusRead.rows).toBe(2);
    expect(plan(focusRead.sql,focusRead.args)).toContain('sqlite_autoindex_cards_1 (id=?)');
    db.reads=[];await preloadOverviewCandidates(ctx);
    await studyCandidates(ctx,'1');await studyCandidates(ctx,'2');
    expect(db.reads.filter(r=>r.method==='all')).toHaveLength(1);
    expect(ctx.cards).toHaveLength(4001);
  });

  it('uses matching buried/time indexes and returns live summary controls without a detailed plan or card rows just to count',async()=>{
    migrate();seed();
    expect(plan('UPDATE cards SET queue=2 WHERE queue IN(-2,-3)')).toContain('cards_buried (queue=?)');
    for(const table of ['review_events','practice_events']) {
      expect(plan(`SELECT COUNT(*) FROM ${table} WHERE undone=0 AND reviewed_at>=? AND reviewed_at<=?`,[now-1000,now]))
        .toContain(`${table}_active_time (reviewed_at>? AND reviewed_at<?)`);
    }
    db.reads=[];const study=await (await request('/api/study/1')).json() as any;
    expect(study.status).toMatchObject({available:{new:0,review:1},restart:null});
    expect(db.reads.some(r=>r.method==='all'&&r.sql.includes('SELECT * FROM cards'))).toBe(false);
    expect((await (await request('/api/study-options/1')).json() as any).available).toEqual(study.status.available);
  });
});
