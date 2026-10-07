import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { TestDb } from './test-db';
import { app } from '../src/server/index';
import { fixture } from './fixture';
import { importStatements } from '../src/lib/import';
import { renderCard } from '../src/lib/render';
let db:TestDb;
let seq=0;
const key=()=>`authoring-operation-${++seq}`;
async function req(path:string,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={}) {
 return app.request(`http://localhost${path}`,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)},{DB:db as unknown as D1Database,MEDIA:{} as R2Bucket,ASSETS:{} as Fetcher});
}
const manage=(path:string,body?:Record<string,unknown>,method?:string,headers?:Record<string,string>)=>req('/api/manage'+path,body===undefined?undefined:{requestId:key(),...body},method,headers);
const definition={name:'言語',fieldDefinitions:[{id:'prompt',name:'問題',required:true},{id:'answer',name:'答え',required:true},{id:'hint',name:'補足',required:false}],templates:[{id:'forward',name:'順方向',front:'{{問題}}',back:'{{FrontSide}}<hr>{{答え}}{{#補足}}<aside>{{補足}}</aside>{{/補足}}'}],css:'.card {font-size:24px}'};
beforeEach(()=>{db=new TestDb();for(const f of ['0001_initial.sql','0002_history_time.sql','0003_authoring.sql','0004_custom_practice.sql','0005_practice_deletion.sql','0006_study_options.sql','0007_restart_new_limit.sql','0008_read_reduction.sql'])db.sqlite.exec(readFileSync(`migrations/${f}`,'utf8'));db.sqlite.exec(importStatements(fixture()).join(';')+';');});
afterEach(()=>db.sqlite.close());
describe('authoring through the shared API',()=>{
 it.each(['field','template'])('guards %s removal against concurrent first-note creation',async(kind)=>{
  db.sqlite.exec('DELETE FROM review_events;DELETE FROM imported_reviews;DELETE FROM cards;DELETE FROM notes');
  const d=fixture();d.noteTypes[0].templates.push({name:'second',front:'{{JP}}',back:'{{KR}}'});d.cards[0].ordinal=1;
  db.sqlite.prepare('UPDATE note_types SET data=? WHERE id=\'1\'').run(JSON.stringify(d.noteTypes[0]));
  const {noteType:t}=await (await manage('/note-types/1')).json() as any;
  let fired=false;db.afterFirst=sql=>{if(!fired&&sql.includes('COUNT(*) AS n FROM notes')){fired=true;db.sqlite.exec(importStatements(d).filter(s=>s.startsWith('INSERT INTO notes')||s.startsWith('INSERT INTO cards')).join(';')+';');}};
  const change=kind==='field'?{...t,fieldDefinitions:t.fieldDefinitions.slice(0,1),templates:t.templates.map((x:any)=>({...x,front:'{{JP}}',back:'{{JP}}'}))}:{...t,templates:t.templates.slice(0,1)};
  expect((await manage('/note-types/1',change,'PATCH')).status).toBe(409);
  expect(JSON.parse(String(db.sqlite.prepare('SELECT data FROM notes').get()?.data)).fields).toEqual(d.notes[0].fields);
  expect(db.sqlite.prepare('SELECT ordinal FROM cards').get()?.ordinal).toBe(1);
 });
 it('propagates emoji parent names through descendants and history',async()=>{
  const {deck:parent}=await (await manage('/decks',{name:'🍎'})).json() as any;
  const {deck:child}=await (await manage('/decks',{name:'単語',parentId:parent.id})).json() as any;
  expect((await manage(`/decks/${parent.id}`,{version:1,name:'果物🍏'},'PATCH')).status).toBe(200);
  const {decks}=await (await manage('/decks')).json() as any;expect(decks.find((d:any)=>d.id===child.id).name).toBe('果物🍏::単語');
  const change=db.sqlite.prepare('SELECT after_data FROM content_history WHERE entity=\'deck\' AND entity_id=? ORDER BY rowid DESC').get(child.id);
  expect(JSON.parse(String(change?.after_data)).name).toBe('果物🍏::単語');
 });
 it('accepts twenty bulk creates within the Free D1 query budget and replays them',async()=>{
  const {noteType:t}=await (await manage('/note-types',{...definition,templates:Array.from({length:16},(_,i)=>({id:`card-${i}`,name:`Card ${i}`,front:'{{問題}}',back:'{{答え}}'}))})).json() as any;
  const bulk={requestId:key(),items:Array.from({length:20},(_,i)=>({operation:'create',noteTypeId:t.id,deckId:'1',fields:{問題:`bulk twenty ${i}`,答え:`답 ${i}`}}))};
  db.queries=0;const first=await (await manage('/notes/bulk',bulk)).json() as any;expect(first.results.every((r:any)=>r.ok)).toBe(true);expect(db.queries).toBeLessThanOrEqual(49);
  const retried=await (await manage('/notes/bulk',bulk)).json() as any;expect(retried).toEqual(first);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get()?.n).toBe(21);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM cards').get()?.n).toBe(321);
 });
 it('applies ordered bulk edits to the same note while preserving learning and receipts',async()=>{
  const before=db.sqlite.prepare('SELECT * FROM cards').all();
  const body={requestId:key(),items:[{operation:'update',id:'1',version:1,fields:{JP:'first edit'},suspended:true},{operation:'update',id:'1',version:2,fields:{KR:'second edit'},suspended:false},{operation:'update',id:'1',version:1,fields:{JP:'stale'}}]};
  const first=await (await manage('/notes/bulk',body)).json() as any;expect(first.results.map((r:any)=>r.ok)).toEqual([true,true,false]);expect(first.results[2].status).toBe(409);
  expect(db.sqlite.prepare('SELECT * FROM cards').all()).toEqual(before);const {note}=await (await manage('/notes/1')).json() as any;expect(note.fields).toEqual({JP:'first edit',KR:'second edit'});expect(note.version).toBe(3);
  const retry=await (await manage('/notes/bulk',body)).json() as any;expect(retry).toEqual(first);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM content_history').get()?.n).toBe(2);
 });
 it('starts without Anki, creates a deck/type/note, and learns an escaped multiline card',async()=>{
  db.sqlite.exec('DELETE FROM imported_reviews;DELETE FROM cards;DELETE FROM notes;DELETE FROM note_types;DELETE FROM decks;DELETE FROM collections');
  expect((await manage('/setup',{timeZone:'Asia/Tokyo',dayStart:4})).status).toBe(200);
  const {deck}=await (await manage('/decks',{name:'語学'})).json() as any;
  const {noteType}=await (await manage('/note-types',definition)).json() as any;
  const body={requestId:key(),noteTypeId:noteType.id,deckId:deck.id,fields:{問題:'a < b\n二行目',答え:'<script>alert(1)</script>'}};
  const first=await manage('/notes',body);expect(first.status).toBe(200);const {note}=await first.json() as any;
  const repeated=await (await manage('/notes',body)).json() as any;expect(repeated.note.id).toBe(note.id);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get()?.n).toBe(1);
  const response=await req(`/api/study/${deck.id}`);const study=await response.json() as any;expect(study.card.schedule.state).toBe(0);
  expect(renderCard(study.card,'front').html).toBe('a &lt; b<br>二行目');expect(renderCard(study.card,'back').html).toContain('&lt;script&gt;');
  expect((await manage('/notes',{...body,fields:{問題:'changed',答え:'答え'}})).status).toBe(409);
 });
 it('edits content and keeps every learning value and history, including undo after an edit',async()=>{
  const review={eventId:'authoring-review-0001',cardId:'1',revision:0,rating:3};expect((await req('/api/review',review)).status).toBe(200);
  const before=db.sqlite.prepare('SELECT * FROM cards').get();const reviews=db.sqlite.prepare('SELECT * FROM review_events').all();
  const updated=await manage('/notes/1',{version:1,fields:{KR:'반갑습니다'}},'PATCH');expect(updated.status).toBe(200);
  expect(db.sqlite.prepare('SELECT * FROM cards').get()).toEqual(before);expect(db.sqlite.prepare('SELECT * FROM review_events').all()).toEqual(reviews);
  expect((await manage('/notes/1',{version:1,fields:{KR:'stale'}},'PATCH')).status).toBe(409);
  const {history}=await (await manage('/notes/1/history')).json() as any;expect(history[0].before.fields[1]).toBe('안녕하세요');expect(history[0].after.fields[1]).toBe('반갑습니다');
  expect((await req('/api/undo',{eventId:review.eventId})).status).toBe(200);
  const exported=await (await req('/api/export')).json() as any;expect(exported.contentHistory).toHaveLength(1);expect(exported.cards[0].deck_id).toBe('1');expect(exported).not.toHaveProperty('apiTokens');
 });
 it('renames and reorders fields/templates while preserving identity, and adds only fresh cards',async()=>{
  const {noteType:old}=await (await manage('/note-types/1')).json() as any;
  const before=db.sqlite.prepare('SELECT * FROM cards WHERE id=\'1\'').get() as any;
  const input={...old,fieldDefinitions:[{...old.fieldDefinitions[1],name:'韓国語'},{...old.fieldDefinitions[0],name:'日本語'},{id:'instruction',name:'指示',required:false}],templates:[{id:'reverse',name:'逆方向',front:'{{韓国語}}',back:'{{日本語}}'},...old.templates]};
  const response=await manage('/note-types/1',input,'PATCH');expect(response.status).toBe(200);const {noteType}=await response.json() as any;
  expect(noteType.templates[1].front).toContain('{{日本語}}');expect(noteType.templates[1].back).toContain(':韓国語}}');
  const card=db.sqlite.prepare('SELECT * FROM cards WHERE id=\'1\'').get() as any;expect({...card,ordinal:before.ordinal}).toEqual(before);expect(card.ordinal).toBe(1);
  const {note}=await (await manage('/notes/1')).json() as any;expect(note.fields).toEqual({韓国語:'안녕하세요',日本語:'こんにちは',指示:''});expect(note.cards).toHaveLength(2);
  const added=db.sqlite.prepare('SELECT * FROM cards WHERE id<>\'1\'').get() as any;expect(added.id).toMatch(/^\d+$/);expect(JSON.parse(added.schedule).state).toBe(0);expect(added.revision).toBe(0);
  const invalid=await manage('/note-types/1',{...noteType,fieldDefinitions:noteType.fieldDefinitions.slice(1)},'PATCH');expect(invalid.status).toBe(400);
 });
 it('rejects a new required empty field atomically and validates native input',async()=>{
  const {noteType}=await (await manage('/note-types/1')).json() as any;
  const change={...noteType,fieldDefinitions:[...noteType.fieldDefinitions,{id:'required',name:'必須追加',required:true}]};
  expect((await manage('/note-types/1',change,'PATCH')).status).toBe(409);
  expect((await (await manage('/note-types/1')).json() as any).noteType.version).toBe(1);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM content_history').get()?.n).toBe(0);
  const {noteType:t}=await (await manage('/note-types',definition)).json() as any;
  expect((await manage('/notes',{noteTypeId:t.id,deckId:'1',fields:{問題:'only'}})).status).toBe(400);
 });
 it('moves a subtree without overwriting its scheduling settings or allowing cycles',async()=>{
  const {deck:child}=await (await manage('/decks',{name:'子',parentId:'1',config:{newPerDay:7}})).json() as any;
  const {deck:other}=await (await manage('/decks',{name:'別'})).json() as any;
  expect((await manage('/decks/1',{version:1,parentId:child.id},'PATCH')).status).toBe(400);
  expect((await manage('/decks/1',{version:1,name:'名前変更',parentId:other.id},'PATCH')).status).toBe(200);
  const {decks}=await (await manage('/decks')).json() as any;expect(decks.find((d:any)=>d.id===child.id).name).toBe('別::名前変更::子');expect(decks.find((d:any)=>d.id===child.id).config.newPerDay).toBe(7);
  const moved=decks.find((d:any)=>d.id===child.id);expect((await manage(`/decks/${child.id}`,{version:moved.version,config:{reviewPerDay:null}},'PATCH')).status).toBe(200);
  const cleared=(await (await manage('/decks')).json() as any).decks.find((d:any)=>d.id===child.id);expect(cleared.config.reviewPerDay).toBeUndefined();
  expect((await manage(`/decks/${child.id}`,{version:cleared.version,name:'子改名'},'PATCH')).status).toBe(200);
  expect((await (await manage('/decks')).json() as any).decks.find((d:any)=>d.id===child.id).config.reviewPerDay).toBeUndefined();
 });
 it('suspends and resumes without changing memory, and undo cannot reactivate a suspended card',async()=>{
  const review={eventId:'suspension-review-01',cardId:'1',revision:0,rating:1};expect((await req('/api/review',review)).status).toBe(200);
  const before=db.sqlite.prepare('SELECT schedule,revision FROM cards').get();
  expect((await manage('/notes/1',{version:1,suspended:true},'PATCH')).status).toBe(200);
  expect(db.sqlite.prepare('SELECT schedule,revision FROM cards').get()).toEqual(before);expect((await (await req('/api/study/1')).json() as any).card).toBeNull();
  expect((await req('/api/undo',{eventId:review.eventId})).status).toBe(200);expect(db.sqlite.prepare('SELECT queue FROM cards').get()?.queue).toBe(-1);
  expect((await manage('/notes/1',{version:2,suspended:false},'PATCH')).status).toBe(200);expect(db.sqlite.prepare('SELECT queue FROM cards').get()?.queue).toBe(2);
 });
 it('returns bounded searchable pages and per-item bulk outcomes with retry safety',async()=>{
  const bulk={requestId:key(),items:[{operation:'create',noteTypeId:'1',deckId:'1',fields:{JP:'bulk unique',KR:'새 카드'}},{operation:'update',id:'1',version:1,fields:{KR:'새 정답'}},{operation:'create',noteTypeId:'missing',deckId:'1',fields:{}}]};
  const first=await (await manage('/notes/bulk',bulk)).json() as any;expect(first.results.map((r:any)=>r.ok)).toEqual([true,true,false]);
  const second=await (await manage('/notes/bulk',bulk)).json() as any;expect(second.results[0].note.id).toBe(first.results[0].note.id);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get()?.n).toBe(2);
  db.queries=0;const result=await (await manage('/notes?q=bulk%20unique&limit=100')).json() as any;expect(result.total).toBe(1);expect(result.notes).toHaveLength(1);expect(db.queries).toBeLessThan(5);
 });
});
describe('AI token isolation',()=>{
 it('stores only hashes, enforces scopes, prevents privilege escalation, and supports revocation',async()=>{
  const requestId=key();const issued=await (await manage('/tokens',{requestId,name:'AI',scopes:['content:read','content:write']})).json() as any;
  expect(issued.token).toMatch(/^dpk_/);const authorization={Authorization:`Bearer ${issued.token}`};
  expect((await manage('/notes',undefined,undefined,authorization)).status).toBe(200);
  expect((await manage('/notes/1',{version:1,fields:{JP:'AI編集'}},'PATCH',authorization)).status).toBe(200);
  for(const route of ['/tokens','/setup'])expect((await manage(route,{},'POST',authorization)).status).toBe(401);
  expect((await manage('/note-types',definition,'POST',authorization)).status).toBe(401);
  for(const route of ['/api/review','/api/export','/api/logout'])expect((await req(route,{},'POST',authorization)).status).toBe(401);
  const retry=await (await manage('/tokens',{requestId,name:'AI',scopes:['content:read','content:write']})).json() as any;expect(retry.token).toBeNull();
  expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM api_tokens').all())).not.toContain(issued.token);expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM mutation_receipts').all())).not.toContain(issued.token);
  expect((await manage(`/tokens/${issued.info.id}/revoke`,{})).status).toBe(200);expect((await manage('/notes',undefined,undefined,authorization)).status).toBe(401);
 });
});
