import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TestDb } from './test-db';
import { fixture } from './fixture';
import { importStatements } from '../src/lib/import';
import { app } from '../src/server/index';
import { studyDayBoundary, nextStudyDayBoundary } from '../src/lib/scheduler';
import type { ImportDocument } from '../src/lib/types';
let db:TestDb;
const now=Date.parse('2026-10-04T03:00:00Z');
const boundary=studyDayBoundary(now,'Asia/Tokyo',4);
function req(path:string,body?:unknown,headers?:Record<string,string>) {
  return app.request('http://localhost'+path,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)},
    {DB:db as unknown as D1Database,MEDIA:{} as R2Bucket,ASSETS:{} as Fetcher});
}
const get=async(path:string)=>await(await req(path)).json() as any;
async function post(path:string,body:unknown,status=200){const r=await req(path,body);expect(r.status).toBe(status);return await r.json() as any;}
function seed(d:ImportDocument) {
  db.sqlite.exec('DELETE FROM imported_reviews;DELETE FROM cards;DELETE FROM notes;DELETE FROM note_types;DELETE FROM decks;DELETE FROM collections');
  db.sqlite.exec(importStatements(d).join(';')+';');
}
function doc(review=6,future=3,newCards=2) {
  const d=fixture();d.reviews=[];d.decks[0].config.newPerDay=1;d.decks[0].config.reviewPerDay=2;
  d.cards=Array.from({length:review+future+newCards},(_,i)=>{
    const c=structuredClone(fixture().cards[0]);c.id=String(i+1);c.lastReview=boundary-10*86400000;
    c.stability=i+1;c.dueAt=i<review?boundary-86400000:i<review+future?nextStudyDayBoundary(boundary,'Asia/Tokyo',4):null;
    if(i>=review+future){c.type=c.queue=0;c.stability=c.difficulty=c.lastReview=null;c.reps=c.lapses=0;}
    return c;
  });return d;
}
const extra=(newN:number,review:number,id='extra-request-id-0001')=>post('/api/study-options/1/extra',{requestId:id,new:newN,review});
const restart=(flatten=false,dailyReviewLimit=2,backlogPerDay=2,previewToken?:string)=>post('/api/study-options/1/restart',{requestId:'restart-request-0001',flatten,dailyReviewLimit,backlogPerDay,previewToken});
const answer=(id:string,revision=0,rating=3,deckId='1',eventId=`answer-event-${id.padStart(5,'0')}`)=>post('/api/review',{eventId,cardId:id,revision,rating,deckId});
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);db=new TestDb();
  for(const f of ['0001_initial','0002_history_time','0003_authoring','0004_custom_practice','0005_practice_deletion','0006_study_options','0007_restart_new_limit'])db.sqlite.exec(readFileSync(`migrations/${f}.sql`,'utf8'));
  seed(doc());
});
afterEach(()=>{db.sqlite.close();vi.useRealTimers();});
describe('new cards alongside restart and Flatten',()=>{
  it('introduces the daily new quota before backlog, keeps learning first, and preserves FSRS on apply/undo',async()=>{
    const setup={dailyReviewLimit:2,backlogPerDay:2,dailyNewLimit:1,flatten:true};
    const before=db.sqlite.prepare('SELECT id,schedule FROM cards ORDER BY id').all();
    const preview=await post('/api/study-options/1/restart/preview',setup);
    const noNew=await post('/api/study-options/1/restart/preview',{...setup,dailyNewLimit:0});
    await post('/api/study-options/1/restart',{...setup,dailyNewLimit:2,previewToken:preview.token,requestId:'mismatched-new-preview-0001'},409);
    expect(preview.days).toEqual(noNew.days);
    await post('/api/study-options/1/restart',{...setup,previewToken:preview.token,requestId:'with-new-restart-0001'});
    expect(db.sqlite.prepare('SELECT id,schedule FROM cards ORDER BY id').all()).toEqual(before);
    const first=await get('/api/study/1');expect(first.card.id).toBe('10');expect(first.counts).toMatchObject({new:1,review:2});
    await answer('10',0,1);
    expect((await get('/api/study/1')).counts).toMatchObject({new:0,review:2});
    await post('/api/review',{eventId:'over-new-restart-0001',cardId:'11',revision:0,rating:3,deckId:'1'},409);
    vi.setSystemTime(now+61000);
    expect((await get('/api/study/1')).card.id).toBe('10');
    await post('/api/undo',{eventId:'answer-event-00010'});
    expect((await get('/api/study/1')).counts.new).toBe(1);
    expect(db.sqlite.prepare('SELECT id,schedule FROM cards ORDER BY id').all()).toEqual(before);
  });
  it('keeps old plans at zero and admits an explicitly granted new credit',async()=>{
    const r=await restart();expect(r.dailyNewLimit).toBe(0);
    expect((await get('/api/study/1')).counts.new).toBe(0);
    await extra(1,0);expect((await get('/api/study/1')).counts.new).toBe(1);
    await answer('10');expect((await get('/api/study/1')).counts.new).toBe(0);
    expect(db.sqlite.prepare("SELECT restart_extra_deck_id FROM review_events WHERE id='answer-event-00010'").get()).toMatchObject({restart_extra_deck_id:'1'});
    await post('/api/undo',{eventId:'answer-event-00010'});expect((await get('/api/study/1')).counts.new).toBe(1);
  });
  it('edits the active new pace with identity/revision/retry protection and retains the Flatten assignments',async()=>{
    const setup={dailyReviewLimit:2,backlogPerDay:2,dailyNewLimit:0,flatten:true};
    const preview=await post('/api/study-options/1/restart/preview',setup);
    const r=await post('/api/study-options/1/restart',{...setup,previewToken:preview.token,requestId:'edit-new-restart-0001'});
    const before=db.sqlite.prepare('SELECT * FROM study_restart_members ORDER BY card_id').all();
    const stale=await post('/api/study-options/1/restart/preview',setup);
    const edit={requestId:'edit-new-limit-0001',restartId:r.id,revision:0,action:'set-new-limit',dailyNewLimit:2};
    const updated=await post('/api/study-options/1/restart/state',edit);
    expect(updated).toMatchObject({dailyNewLimit:2,revision:1,paused:false});
    expect(await post('/api/study-options/1/restart/state',edit)).toEqual(updated);
    await post('/api/study-options/1/restart/state',{...edit,dailyNewLimit:1},409);
    await post('/api/study-options/1/restart/state',{...edit,requestId:'stale-new-limit-0001'},409);
    await post('/api/study-options/1/restart/state',{...edit,requestId:'invalid-new-limit-0001',dailyNewLimit:-1},400);
    await post('/api/study-options/1/restart/state',{...edit,requestId:'identity-new-limit-0001',revision:1,restartId:'wrong-plan-id-0001'},409);
    await post('/api/study-options/1/restart',{...setup,previewToken:stale.token,requestId:'stale-new-preview-0001'},409);
    expect(db.sqlite.prepare('SELECT * FROM study_restart_members ORDER BY card_id').all()).toEqual(before);
    expect((await get('/api/study/1')).counts.new).toBe(2);
    await post('/api/study-options/1/restart/state',{requestId:'pause-new-pace-0001',restartId:r.id,revision:1,action:'pause'});
    expect((await get('/api/study/1')).counts.new).toBe(1);
    await post('/api/study-options/1/restart/state',{requestId:'paused-new-edit-0001',restartId:r.id,revision:2,action:'set-new-limit',dailyNewLimit:1});
    expect((await get('/api/study-options/1')).restart.paused).toBe(true);
    await post('/api/study-options/1/restart/state',{requestId:'resume-new-pace-0001',restartId:r.id,revision:3,action:'resume'});
    expect((await get('/api/study-options/1')).restart.dailyNewLimit).toBe(1);
  });
  it('shares the daily new baseline across children and charges child-only surplus without lending it to siblings',async()=>{
    const d=doc(2,0,4);d.decks=[{...d.decks[0],name:'A'},...['A::B','A::C'].map((name,i)=>({...structuredClone(d.decks[0]),id:String(i+2),name}))];
    d.cards.forEach((c,i)=>c.deckId=i<3?'2':'3');seed(d);
    await post('/api/study-options/1/restart',{requestId:'shared-new-plan-0001',dailyReviewLimit:2,backlogPerDay:2,dailyNewLimit:1,flatten:false});
    await answer('3',0,3,'2');expect((await get('/api/study/3')).counts.new).toBe(0);
    await post('/api/study-options/2/extra',{requestId:'child-new-credit-0001',new:1,review:0});
    expect((await get('/api/study/3')).counts.new).toBe(0);
    await post('/api/review',{eventId:'sibling-new-denied-0001',cardId:'4',revision:0,rating:3,deckId:'3'},409);
    await post('/api/undo',{eventId:'answer-event-00003'});
    expect((await get('/api/study/3')).counts.new).toBe(1);
    await answer('4',0,3,'3');
    vi.setSystemTime(nextStudyDayBoundary(now,'Asia/Tokyo',4));
    expect((await get('/api/study/3')).counts.new).toBe(1);
  });
});
describe('daily extra admission and shared quotas',()=>{
  it('increments once, rejects reused IDs, expires at local rollover, and undo restores spent quotas',async()=>{
    await extra(2,1);await extra(2,1);
    const o=await get('/api/study-options/1');expect(o.extra).toEqual({new:2,review:1});expect(o.limits).toEqual({new:3,review:3});
    await post('/api/study-options/1/extra',{requestId:'extra-request-id-0001',new:1,review:1},409);
    for(const id of ['1','2','3'])await answer(id);
    await post('/api/review',{eventId:'over-quota-event-0001',cardId:'4',revision:0,rating:3,deckId:'1'},409);
    await post('/api/undo',{eventId:'answer-event-00003'});await answer('4');
    vi.setSystemTime(nextStudyDayBoundary(now,'Asia/Tokyo',4));
    expect((await get('/api/study-options/1')).extra).toEqual({new:0,review:0});
  });
  it('does not spend extra new quota on intraday learning repeats',async()=>{
    await extra(1,0);await answer('10',0,1);vi.setSystemTime(now+61000);
    await answer('10',1,3,'1','repeat-learning-0001');
    expect((await get('/api/study/1')).counts.new).toBe(1);
  });
  it('shares a parent grant across sibling selections without permitting out-of-scope cards',async()=>{
    const d=doc(4,0,0);d.decks=[{...d.decks[0],name:'A'},...['A::B','A::C'].map((name,i)=>({...structuredClone(d.decks[0]),id:String(i+2),name}))];
    for(const deck of d.decks)deck.config.reviewPerDay=0;
    d.cards.forEach((c,i)=>c.deckId=i<2?'2':'3');seed(d);
    await extra(0,2);
    await answer('1',0,3,'2');await answer('3',0,3,'3');
    await post('/api/review',{eventId:'sibling-quota-0001',cardId:'2',revision:0,rating:3,deckId:'2'},409);
    await post('/api/review',{eventId:'outside-scope-0001',cardId:'2',revision:0,rating:3,deckId:'3'},409);
    expect((await get('/api/study/1')).card).toBeNull();
  });
  it.each(['new','review'] as const)('a parent %s-only grant leaves the other direct-child category unchanged',async granted=>{
    const d=doc(2,0,2);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    d.decks[0].config.newPerDay=d.decks[0].config.reviewPerDay=0;
    d.decks[1].config.newPerDay=d.decks[1].config.reviewPerDay=10;
    d.cards.forEach(c=>c.deckId='2');seed(d);
    const unaffected=granted==='new'?'review':'new';
    const before=await get('/api/study/2');expect(before.counts[unaffected]).toBe(2);
    await extra(granted==='new'?1:0,granted==='review'?1:0);
    const after=await get('/api/study/2');expect(after.counts[unaffected]).toBe(before.counts[unaffected]);
    expect(after.counts[granted]).toBe(before.counts[granted]);
    const unaffectedIds=unaffected==='new'?['3','4']:['1','2'];
    for(const id of unaffectedIds)await answer(id,0,4,'2');
    const grantedIds=granted==='new'?['3','4']:['1','2'];
    await answer(grantedIds[0],0,4,'2');
    await answer(grantedIds[1],0,4,'2');
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events WHERE undone=0').get()!.n).toBe(4);
  });
  it.each(['new','review'] as const)('preserves sibling %s baselines and spends their parent extra only once',async category=>{
    const d=doc(category==='review'?8:0,0,category==='new'?8:0);
    d.decks=[{...d.decks[0],name:'A'},...['A::B','A::C'].map((name,i)=>({...structuredClone(d.decks[0]),id:String(i+2),name}))];
    d.decks[0].config.newPerDay=d.decks[0].config.reviewPerDay=0;
    for(const deck of d.decks.slice(1)){deck.config.newPerDay=2;deck.config.reviewPerDay=2;}
    d.cards.forEach((c,i)=>c.deckId=i<4?'2':'3');seed(d);
    await answer('1',0,4,'2');expect((await get('/api/study/2')).counts[category]).toBe(1);
    await extra(category==='new'?1:0,category==='review'?1:0);await extra(category==='new'?1:0,category==='review'?1:0);
    expect((await get('/api/study/2')).counts[category]).toBe(2);expect((await get('/api/study/3')).counts[category]).toBe(3);
    await answer('2',0,4,'2');await answer('3',0,4,'2');
    expect(db.sqlite.prepare('SELECT ordinary_extra_deck_id FROM review_events WHERE card_id=3').get()!.ordinary_extra_deck_id).toBe('1');
    expect((await get('/api/study/3')).counts[category]).toBe(2);
    await answer('5',0,4,'3');await answer('6',0,4,'3');
    await post('/api/review',{eventId:'sibling-shared-credit-0001',cardId:'7',revision:0,rating:4,deckId:'3'},409);
    expect((await get('/api/study/3')).counts[category]).toBe(0);
    await post('/api/undo',{eventId:'answer-event-00003'});expect((await get('/api/study/3')).counts[category]).toBe(1);
    await answer('7',0,4,'3');expect((await get('/api/study/2')).counts[category]).toBe(0);
    vi.setSystemTime(nextStudyDayBoundary(now,'Asia/Tokyo',4));
    expect((await get('/api/study-options/2')).extra[category]).toBe(0);
    expect((await get('/api/study/2')).counts[category]).toBe(2);
  });
  it('cannot spend the last shared ordinary credit after another tab takes it',async()=>{
    const d=doc(2,0,0);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    for(const deck of d.decks)deck.config.reviewPerDay=0;
    d.cards.forEach(c=>c.deckId='2');seed(d);await extra(0,1);
    let injected=false;
    db.afterFirst=sql=>{
      if(!injected&&sql.includes('AS credits')) {
        injected=true;const state=String(db.sqlite.prepare('SELECT schedule FROM cards WHERE id=2').get()!.schedule);
        db.sqlite.prepare(`INSERT INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision,ordinary_extra_deck_id)
          VALUES('other-tab-extra-0001','2','2',3,?,?,?,1,'1')`).run(now,state,state);
      }
    };
    await post('/api/review',{eventId:'shared-credit-race-0001',cardId:'1',revision:0,rating:3,deckId:'2'},409);
    expect(db.sqlite.prepare('SELECT revision FROM cards WHERE id=1').get()!.revision).toBe(0);
    db.afterFirst=undefined;expect((await get('/api/study/2')).counts.review).toBe(0);
  });
  it('checks quota atomically when another answer lands after admission reads',async()=>{
    const d=doc(2,0,0);d.decks[0].config.reviewPerDay=1;seed(d);
    let injected=false;
    db.afterFirst=sql=>{
      if(!injected&&sql.includes('AS credits')){
        injected=true;const schedule=db.sqlite.prepare('SELECT schedule FROM cards WHERE id=2').get()!.schedule;
        db.sqlite.prepare(`INSERT INTO review_events(id,card_id,deck_id,rating,reviewed_at,before_state,after_state,after_revision) VALUES('racing-answer-0001','2','1',3,?,?,?,1)`).run(now,String(schedule),String(schedule));
      }
    };
    await post('/api/review',{eventId:'racing-answer-0002',cardId:'1',revision:0,rating:3,deckId:'1'},409);
    expect(db.sqlite.prepare('SELECT revision FROM cards WHERE id=1').get()!.revision).toBe(0);
  });
});
describe('restart backlog and truthful Flatten admission',()=>{
  it('operates the displayed parent restart from a descendant with revision and retry protection',async()=>{
    const d=doc(4,0,0);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    d.cards.forEach(c=>c.deckId='2');seed(d);const r=await restart(false,4,4);
    expect((await get('/api/study-options/2')).restart.id).toBe(r.id);
    const pause={requestId:'descendant-pause-0001',restartId:r.id,revision:r.revision,action:'pause'};
    const paused=await post('/api/study-options/2/restart/state',pause);expect(paused.id).toBe(r.id);expect(paused.paused).toBe(true);
    expect(await post('/api/study-options/2/restart/state',pause)).toEqual(paused);
    await post('/api/study-options/2/restart/state',{requestId:'descendant-stale-0001',restartId:r.id,revision:0,action:'resume'},409);
    const resumed=await post('/api/study-options/2/restart/state',{requestId:'descendant-resume-0001',restartId:r.id,revision:1,action:'resume'});
    expect(resumed.paused).toBe(false);expect((await get('/api/study-options/1')).restart.revision).toBe(2);
    const cancel={requestId:'descendant-cancel-0001',restartId:r.id,revision:2,action:'cancel'};
    expect(await post('/api/study-options/2/restart/state',cancel)).toBeNull();
    expect(await post('/api/study-options/2/restart/state',cancel)).toBeNull();
    expect((await get('/api/study-options/1')).restart).toBeNull();
    const replacement=await post('/api/study-options/1/restart',{requestId:'replacement-plan-0001',flatten:false,dailyReviewLimit:4,backlogPerDay:4});
    expect(replacement.revision).toBe(0);
    await post('/api/study-options/2/restart/state',{requestId:'replacement-stale-0001',restartId:r.id,revision:0,action:'pause'},409);
    expect((await get('/api/study-options/2')).restart.paused).toBe(false);
  });
  it('uses the same unique descendant plan for parent controls and hides an ambiguous multi-plan parent',async()=>{
    const d=doc(4,0,0);d.decks=[{...d.decks[0],name:'A'},...['A::B','A::C'].map((name,i)=>({...structuredClone(d.decks[0]),id:String(i+2),name}))];
    d.cards.forEach((c,i)=>c.deckId=i<2?'2':'3');seed(d);
    const first=await post('/api/study-options/2/restart',{requestId:'unique-child-plan-0001',flatten:false,dailyReviewLimit:2,backlogPerDay:2});
    expect((await get('/api/study-options/1')).restart.id).toBe(first.id);
    await post('/api/study-options/1/restart/state',{requestId:'unique-child-pause-0001',restartId:first.id,revision:0,action:'pause'});
    expect((await get('/api/study-options/2')).restart.paused).toBe(true);
    const second=await post('/api/study-options/3/restart',{requestId:'second-child-plan-0001',flatten:false,dailyReviewLimit:2,backlogPerDay:2});
    expect((await get('/api/study-options/1')).restart).toBeNull();
    await post('/api/study-options/1/restart/state',{requestId:'ambiguous-parent-0001',restartId:first.id,revision:1,action:'cancel'},404);
    expect((await get('/api/study-options/2')).restart.id).toBe(first.id);expect((await get('/api/study-options/3')).restart.id).toBe(second.id);
  });
  it('a parent grant increases descendant restart admission without reinstating the ordinary cap',async()=>{
    const d=doc(12,0,0);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    d.cards.forEach(c=>c.deckId='2');seed(d);await restart(false,10,10);
    for(const id of ['1','2','3'])await answer(id,0,3,'2');
    expect((await get('/api/study/2')).counts.review).toBe(7);
    await extra(0,1);await extra(0,1);
    expect((await get('/api/study/2')).counts.review).toBe(8);
    for(const id of ['4','5','6','7','8','9','10','11'])await answer(id,0,3,'2');
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events WHERE undone=0').get()!.n).toBe(11);
    expect(db.sqlite.prepare('SELECT restart_extra_deck_id FROM review_events WHERE card_id=11').get()!.restart_extra_deck_id).toBe('1');
    await post('/api/review',{eventId:'parent-grant-quota-0001',cardId:'12',revision:0,rating:3,deckId:'2'},409);
    expect((await get('/api/study/2')).card).toBeNull();
  });
  it('charges restart extras to the granting child so a sibling cannot spend them',async()=>{
    const d=doc(4,0,0);d.decks=[{...d.decks[0],name:'A'},...['A::B','A::C'].map((name,i)=>({...structuredClone(d.decks[0]),id:String(i+2),name}))];
    d.cards.forEach((c,i)=>c.deckId=i<2?'2':'3');seed(d);await restart(false,1,1);
    await answer('4',0,3,'3');
    await post('/api/study-options/2/extra',{requestId:'child-extra-grant-0001',new:0,review:1});
    await post('/api/review',{eventId:'sibling-cannot-spend-0001',cardId:'3',revision:0,rating:3,deckId:'3'},409);
    expect((await get('/api/study/2')).card.id).toBe('2');await answer('2',0,3,'2');
    expect(db.sqlite.prepare('SELECT restart_extra_deck_id FROM review_events WHERE card_id=2').get()!.restart_extra_deck_id).toBe('2');
    expect((await get('/api/study/1')).card).toBeNull();
    await post('/api/undo',{eventId:'answer-event-00002'});
    expect((await get('/api/study/2')).card.id).toBe('2');
  });
  it('spent ordinary extras remain spent while the restart baseline remains available',async()=>{
    const d=doc(9,0,0);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    for(const deck of d.decks)deck.config.reviewPerDay=0;
    d.cards.forEach(c=>c.deckId='2');seed(d);await extra(0,3);
    for(const id of ['1','2','3'])await answer(id,0,3,'2');
    expect((await get('/api/study/2')).counts.review).toBe(0);
    await restart(false,3,3);
    expect((await get('/api/study-options/1')).restart.backlogToday).toBe(3);
    expect((await get('/api/study/2')).counts.review).toBe(3);
    for(const id of ['4','5','6'])await answer(id,0,3,'2');
    await post('/api/review',{eventId:'mode-switch-spent-credit-0001',cardId:'7',revision:0,rating:3,deckId:'2'},409);
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events WHERE undone=0').get()!.n).toBe(6);
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events WHERE ordinary_extra_deck_id IS NOT NULL').get()!.n).toBe(3);
    expect((await get('/api/study-options/1')).restart.backlogToday).toBe(0);
  });
  it('pause excludes restart extra answers from ordinary baseline and shares the still-unspent grant',async()=>{
    const d=doc(7,0,0);d.decks=[{...d.decks[0],name:'A'},{...structuredClone(d.decks[0]),id:'2',name:'A::B'}];
    d.cards.forEach(c=>c.deckId='2');seed(d);const r=await restart(false,3,1);await extra(0,3);
    for(const id of ['1','2','3'])await answer(id,0,3,'2');
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM review_events WHERE restart_extra_deck_id IS NOT NULL').get()!.n).toBe(2);
    await post('/api/study-options/2/restart/state',{requestId:'credit-ledger-pause-0001',restartId:r.id,revision:0,action:'pause'});
    expect((await get('/api/study/2')).counts.review).toBe(2);
    await answer('4',0,3,'2');expect(db.sqlite.prepare('SELECT ordinary_extra_deck_id FROM review_events WHERE card_id=4').get()!.ordinary_extra_deck_id).toBeNull();
    await answer('5',0,3,'2');expect(db.sqlite.prepare('SELECT ordinary_extra_deck_id FROM review_events WHERE card_id=5').get()!.ordinary_extra_deck_id).toBe('1');
    expect((await get('/api/study/2')).counts.review).toBe(0);
    await post('/api/study-options/2/restart/state',{requestId:'credit-ledger-resume-0001',restartId:r.id,revision:1,action:'resume'});
    expect((await get('/api/study/2')).counts.review).toBe(0);
    await post('/api/undo',{eventId:'answer-event-00005'});
    expect((await get('/api/study/2')).counts.review).toBe(1);
  });
  it('sorts a thousand-card backlog with one batched R calculation per deck',async()=>{
    const d=doc(1000,0,0);seed(d);await restart(false,100,100);
    const response=await get('/api/study/1');expect(response.card.id).toBe('1000');expect(response.counts.review).toBe(100);
  });
  it('default restart admits all backlog now ordered by R, prioritizes learning/regular reviews, stops new and observes total target',async()=>{
    const r=await restart(false,3,2);expect(r.backlogRemaining).toBe(6);
    const study=await get('/api/study/1');expect(study.card.id).toBe('6');expect(study.counts.new).toBe(0);
    const available=db.sqlite.prepare('SELECT COUNT(DISTINCT available_at) n FROM study_restart_members').get()!;expect(available.n).toBe(1);
    await answer('6');await answer('5');
    expect((await get('/api/study/1')).card).toBeNull();
    const s=db.sqlite.prepare('SELECT schedule FROM cards WHERE id=9').get()!;const state=JSON.parse(String(s.schedule));state.due=now-1000;
    db.sqlite.prepare('UPDATE cards SET due=?,schedule=? WHERE id=9').run(state.due,JSON.stringify(state));
    expect((await get('/api/study/1')).card.id).toBe('9');await answer('9');
    expect((await get('/api/study-options/1')).restart.backlogToday).toBe(0);
    await extra(0,1);expect((await get('/api/study/1')).card.id).toBe('4');
  });
  it('flattens backlog and future review peaks without changing FSRS memory or due, and stale cards cannot bypass admission',async()=>{
    const before=db.sqlite.prepare('SELECT id,schedule,revision FROM cards ORDER BY id').all();
    const preview=await post('/api/study-options/1/restart/preview',{dailyReviewLimit:2,backlogPerDay:2,flatten:true});
    expect(preview.total).toBe(9);expect(preview.days.every((d:any)=>d.cards<=2)).toBe(true);expect(preview.delayedCards).toBeGreaterThan(0);
    await restart(true,2,2,preview.token);
    expect(db.sqlite.prepare('SELECT id,schedule,revision FROM cards ORDER BY id').all()).toEqual(before);
    expect((await get('/api/study/1')).card.id).toBe('2');
    await post('/api/review',{eventId:'deferred-bypass-0001',cardId:'6',revision:0,rating:3,deckId:'1'},409);
    expect((await get('/api/study-options/1')).available.review).toBe(6);
    await answer('2');await answer('1');expect((await get('/api/study/1')).card).toBeNull();
    await extra(0,1);await extra(0,1);
    const options=await get('/api/study-options/1');expect(options.restart.backlogToday).toBe(1);expect(options.limits.review).toBe(3);
    const accelerated=(await get('/api/study/1')).card;expect(accelerated.id).toBe('3');
    await answer('3');await post('/api/undo',{eventId:'answer-event-00003'});
    expect((await get('/api/study/1')).card.id).toBe('3');
    const pulled=db.sqlite.prepare('SELECT available_at,revision FROM study_restart_members WHERE card_id=3').get()!;
    expect(pulled.available_at).toBe(boundary);expect(pulled.revision).toBe(2);
    expect(db.sqlite.prepare('SELECT MIN(available_at) day FROM study_restart_members WHERE backlog=0').get()!.day).toBeGreaterThan(boundary);
  });
  it('preview detects card answers, new cards, deck config and collection calendar changes',async()=>{
    for(const change of ['answer','card','config','calendar']){
      const p=await post('/api/study-options/1/restart/preview',{dailyReviewLimit:2,backlogPerDay:2,flatten:true});
      if(change==='answer'){await answer('1');await post('/api/undo',{eventId:'answer-event-00001'});}
      if(change==='card')db.sqlite.exec(`UPDATE cards SET revision=revision+1 WHERE id=2`);
      if(change==='config')db.sqlite.exec('UPDATE decks SET name=name WHERE id=1');
      if(change==='calendar')db.sqlite.exec('UPDATE collections SET metadata=metadata');
      await post('/api/study-options/1/restart',{requestId:`stale-preview-${change}-0001`,dailyReviewLimit:2,backlogPerDay:2,flatten:true,previewToken:p.token},409);
    }
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM study_restarts').get()!.n).toBe(0);
  });
  it('accounts for reviews already completed today in Flatten capacity',async()=>{
    await answer('1');
    const p=await post('/api/study-options/1/restart/preview',{dailyReviewLimit:2,backlogPerDay:2,flatten:true});
    expect(p.days[0].cards).toBe(1);
  });
  it('pause enables ordinary study, resume keeps progress and undo restores prior admission; cancel preserves actual answers',async()=>{
    const r=await restart(false,2,2);
    await post('/api/study-options/1/restart/state',{requestId:'pause-request-0001',restartId:r.id,revision:r.revision,action:'pause'});
    expect((await get('/api/study/1')).counts.new).toBe(1);
    await answer('1');
    await post('/api/study-options/1/restart/state',{requestId:'resume-request-0001',restartId:r.id,revision:1,action:'resume'});
    expect((await get('/api/study-options/1')).restart.backlogRemaining).toBe(5);
    await post('/api/undo',{eventId:'answer-event-00001'});
    expect((await get('/api/study-options/1')).restart.backlogRemaining).toBe(6);
    await answer('2');const schedule=db.sqlite.prepare('SELECT schedule FROM cards WHERE id=2').get()!.schedule;
    await post('/api/study-options/1/restart/state',{requestId:'cancel-request-0001',restartId:r.id,revision:2,action:'cancel'});
    expect((await get('/api/study-options/1')).restart).toBeNull();
    expect(db.sqlite.prepare('SELECT schedule FROM cards WHERE id=2').get()!.schedule).toBe(schedule);
    expect((await get('/api/study/1')).counts.new).toBe(1);
  });
  it('rejects overlapping plans, replays operations exactly, and exports all persistent admission state',async()=>{
    const r=await restart();expect(await restart()).toEqual(r);
    await post('/api/study-options/1/restart',{requestId:'overlapping-plan-0001',dailyReviewLimit:3,backlogPerDay:2,flatten:false},409);
    const b={requestId:'pause-idempotent-0001',restartId:r.id,revision:0,action:'pause'};const paused=await post('/api/study-options/1/restart/state',b);expect(await post('/api/study-options/1/restart/state',b)).toEqual(paused);
    await post('/api/study-options/1/restart/state',{...b,action:'cancel'},409);
    const backup=await get('/api/export');expect(backup.studyRestarts).toHaveLength(1);expect(backup.studyRestartMembers).toHaveLength(6);expect(backup.studyReceipts).toHaveLength(2);expect(backup.studyGeneration).toHaveLength(1);
  });
  it('excludes suspended, buried, learning and moved-away cards from plan admission/remaining',async()=>{
    db.sqlite.exec('UPDATE cards SET queue=-1 WHERE id=1;UPDATE cards SET queue=-2 WHERE id=2;UPDATE cards SET queue=1,state=1 WHERE id=3');
    const meta=JSON.parse(String(db.sqlite.prepare('SELECT metadata FROM collections').get()!.metadata));meta.source.importedAt=new Date(now).toISOString();db.sqlite.prepare('UPDATE collections SET metadata=?').run(JSON.stringify(meta));
    const r=await restart();expect(r.backlogTotal).toBe(3);
    const d=fixture().decks[0];d.id='2';d.name='Other';db.sqlite.prepare('INSERT INTO decks(id,name,data) VALUES(?,?,?)').run(d.id,d.name,JSON.stringify(d));
    db.sqlite.exec('UPDATE cards SET deck_id=2 WHERE id=4;UPDATE cards SET queue=-1 WHERE id=5');
    expect((await get('/api/study-options/1')).restart.backlogRemaining).toBe(1);
    expect((await get('/api/study/2')).card.id).toBe('4');
  });
});

describe('pending learning, learn ahead and focus batches',()=>{
  function learningDoc(minutes=10) {
    const d=doc(2,0,0);
    d.cards[0]={...d.cards[0],type:1,queue:1,interval:0,dueAt:now+minutes*60000,left:2};
    return d;
  }
  it('reports waiting intraday steps and learns ahead only after other eligible cards',async()=>{
    seed(learningDoc());
    let result=await get('/api/study/1');
    expect(result).toMatchObject({studyDayBoundary:boundary,learningPending:1,nextLearningDue:now+600000});
    expect(result.card.id).toBe('2');expect(result.candidateIds).toEqual(['2','1']);
    expect(result.counts).toMatchObject({learning:1,review:1});
    await post('/api/review',{eventId:'early-before-review-0001',cardId:'1',revision:0,rating:1,deckId:'1'},409);
    await answer('2');result=await get('/api/study/1');expect(result.card.id).toBe('1');
    const event={eventId:'early-learning-answer-0001',cardId:'1',revision:0,rating:1,deckId:'1'};
    const answered=await post('/api/review',event);
    expect(answered.schedule).toMatchObject({state:1,scheduledDays:0,due:now+60000});
    expect(answered.completedForToday).toBe(false);
    expect(answered.studyDayBoundary).toBe(boundary);
    const duplicate=await post('/api/review',event);expect(duplicate.schedule).toEqual(answered.schedule);
    expect(duplicate.completedForToday).toBe(false);
    await post('/api/undo',{eventId:event.eventId});
    expect((await get('/api/study/1')).learningPending).toBe(1);
    expect(db.sqlite.prepare('SELECT queue FROM cards WHERE id=1').get()!.queue).toBe(1);
  });
  it('keeps a long intraday wait pending, while daily-cap exhaustion permits the 20-minute fallback',async()=>{
    const d=learningDoc(21);d.decks[0].config.reviewPerDay=0;seed(d);
    let result=await get('/api/study/1');expect(result.card).toBeNull();
    expect(result).toMatchObject({learningPending:1,nextLearningDue:now+21*60000,nextDue:now+21*60000});
    expect(result.counts).toMatchObject({learning:1,review:0});expect(result.candidateIds).toEqual(['1']);
    await post('/api/review',{eventId:'outside-ahead-window-0001',cardId:'1',revision:0,rating:1,deckId:'1'},409);
    vi.setSystemTime(now+60000);result=await get('/api/study/1');expect(result.card.id).toBe('1');
    await post('/api/review',{eventId:'at-ahead-window-0001',cardId:'1',revision:0,rating:1,deckId:'1'});
  });
  it('restricts priority and answer membership to a focus batch without expanding it',async()=>{
    seed(learningDoc());
    const result=await get('/api/study/1?focusIds=1');
    expect(result.card.id).toBe('1');expect(result.focusRemainingIds).toEqual(['1']);
    expect(result.counts).toEqual({new:0,review:0,learning:1,total:1});
    await post('/api/review',{eventId:'outside-focus-answer-0001',cardId:'2',revision:0,rating:3,deckId:'1',focusIds:['1']},409);
    await post('/api/review',{eventId:'focused-learning-answer-0001',cardId:'1',revision:0,rating:1,deckId:'1',focusIds:['1']});
    expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual(['1']);
    await post('/api/review',{eventId:'focused-learning-graduate-0001',cardId:'1',revision:1,rating:4,deckId:'1',focusIds:['1']});
    expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual([]);
    expect((await get('/api/study/1?focusIds=1')).card).toBeNull();
    expect((await get('/api/study/1')).card.id).toBe('2');
  });
  it('preserves imported intraday identity on undo even when the imported interval is positive',async()=>{
    const d=learningDoc();d.cards[0].interval=21;d.decks[0].config.reviewPerDay=0;seed(d);
    const before=db.sqlite.prepare('SELECT schedule FROM cards WHERE id=1').get()!.schedule;
    await post('/api/review',{eventId:'imported-learning-answer-0001',cardId:'1',revision:0,rating:4,deckId:'1'});
    await post('/api/undo',{eventId:'imported-learning-answer-0001'});
    expect(db.sqlite.prepare('SELECT schedule,queue FROM cards WHERE id=1').get()).toMatchObject({schedule:before,queue:1});
    expect((await get('/api/study/1')).card.id).toBe('1');expect((await get('/api/study/1')).learningPending).toBe(1);
  });
  it('stores generated interday steps distinctly and treats them as resolved for today',async()=>{
    const d=doc(0,0,1);d.decks[0].config.learningSteps=[1440];seed(d);
    const answered=await post('/api/review',{eventId:'interday-learning-answer-0001',cardId:'1',revision:0,rating:1,deckId:'1',focusIds:['1']});
    expect(answered.schedule).toMatchObject({state:1,scheduledDays:1});
    expect(answered.completedForToday).toBe(true);
    expect(db.sqlite.prepare('SELECT queue FROM cards WHERE id=1').get()!.queue).toBe(3);
    expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual([]);
    vi.setSystemTime(answered.schedule.due);expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual(['1']);
  });
  it('reserves candidate quotas, caps batches at ten and retains temporarily quota-blocked focus members',async()=>{
    const d=doc(20,0,3);seed(d);
    const result=await get('/api/study/1');expect(result.candidateIds).toHaveLength(3);
    expect(result.counts).toMatchObject({new:1,review:2});
    d.decks[0].config.reviewPerDay=20;seed(d);
    expect((await get('/api/study/1')).candidateIds).toHaveLength(10);
    d.decks[0].config.reviewPerDay=0;seed(d);
    const focused=await get('/api/study/1?focusIds=1,2');
    expect(focused.focusRemainingIds).toEqual(['1','2']);expect(focused.candidateIds).toEqual([]);expect(focused.card).toBeNull();
    await extra(0,1);expect((await get('/api/study/1?focusIds=1,2')).candidateIds).toEqual(['1']);
  });
  it('does not learn ahead ordinary reviews, interday steps or learning across the day boundary',async()=>{
    const d=learningDoc();d.cards[0].queue=3;d.cards[0].interval=1;
    d.cards[1].dueAt=now+5*60000;seed(d);
    expect((await get('/api/study/1')).card).toBeNull();expect((await get('/api/study/1')).learningPending).toBe(0);
    for(const id of ['1','2'])await post('/api/review',{eventId:`future-kind-answer-${id}`,cardId:id,revision:0,rating:3,deckId:'1'},409);
    d.cards[0].queue=1;d.cards[0].interval=0;d.cards[0].dueAt=nextStudyDayBoundary(boundary,'Asia/Tokyo',4)+60000;seed(d);
    vi.setSystemTime(nextStudyDayBoundary(boundary,'Asia/Tokyo',4)-60000);
    db.sqlite.exec('UPDATE cards SET queue=-1 WHERE id=2');
    const pending=await get('/api/study/1');expect(pending.card).toBeNull();expect(pending.learningPending).toBe(0);
    await post('/api/review',{eventId:'across-boundary-answer-0001',cardId:'1',revision:0,rating:3,deckId:'1'},409);
  });
  it('reports intraday steps crossing rollover as completed for the answered day, including later duplicates',async()=>{
    const d=doc(0,0,1);seed(d);
    const nextBoundary=nextStudyDayBoundary(boundary,'Asia/Tokyo',4);
    vi.setSystemTime(nextBoundary-30000);
    const event={eventId:'crossing-rollover-answer-0001',cardId:'1',revision:0,rating:1,deckId:'1',focusIds:['1']};
    const answered=await post('/api/review',event);
    expect(answered.schedule).toMatchObject({state:1,scheduledDays:0,due:nextBoundary+30000});
    expect(answered.completedForToday).toBe(true);
    expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual([]);
    vi.setSystemTime(nextBoundary+60000);
    const duplicate=await post('/api/review',event);
    expect(duplicate.completedForToday).toBe(true);expect(duplicate.studyDayBoundary).toBe(boundary);
    expect((await get('/api/study/1?focusIds=1')).focusRemainingIds).toEqual(['1']);
  });
  it('prunes removed or resolved focus members and keeps due interday learning',async()=>{
    const d=doc(7,0,0);d.decks.push({...structuredClone(d.decks[0]),id:'2',name:'Outside'});
    d.cards[0].queue=3;d.cards[0].type=1;d.cards[0].interval=1;
    d.cards[1].queue=3;d.cards[1].type=1;d.cards[1].interval=1;d.cards[1].dueAt=nextStudyDayBoundary(boundary,'Asia/Tokyo',4);
    d.cards[2].dueAt=now+86400000;d.cards[3].queue=-1;d.cards[4].deckId='2';seed(d);
    db.sqlite.exec('DELETE FROM cards WHERE id=6');
    const focused=await get('/api/study/1?focusIds=1,2,3,4,5,6,7');
    expect(focused.focusRemainingIds).toEqual(['1','7']);expect(focused.card.id).toBe('1');
    await post('/api/review',{eventId:'focus-cross-deck-answer-0001',cardId:'5',revision:0,rating:3,deckId:'1',focusIds:['5']},409);
    await post('/api/review',{eventId:'focus-suspended-answer-0001',cardId:'4',revision:0,rating:3,deckId:'1',focusIds:['4']},404);
  });
  it.each(['','1,1','1,x','-1','1,,2',Array.from({length:11},(_,i)=>String(i+1)).join(',')])('rejects malformed focus query %j',async focus=>{
    expect((await req('/api/study/1?focusIds='+encodeURIComponent(focus))).status).toBe(400);
  });
  it.each([[],['1','1'],['x'],[1],null,Array.from({length:11},(_,i)=>String(i+1))])('rejects malformed focus body %j',async focusIds=>{
    await post('/api/review',{eventId:'bad-focus-answer-0001',cardId:'1',revision:0,rating:3,deckId:'1',focusIds},400);
  });
  it('rejects a competing card change after learning eligibility was computed',async()=>{
    const d=learningDoc();d.decks[0].config.reviewPerDay=0;seed(d);
    const batch=db.batch.bind(db);let raced=false;
    db.batch=async statements=>{
      if(!raced){raced=true;db.sqlite.exec('UPDATE cards SET queue=queue WHERE id=2');}
      return batch(statements);
    };
    await post('/api/review',{eventId:'learning-generation-race-0001',cardId:'1',revision:0,rating:1,deckId:'1'},409);
    expect(db.sqlite.prepare('SELECT revision FROM cards WHERE id=1').get()!.revision).toBe(0);
  });
});
