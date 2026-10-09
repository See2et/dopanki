import { Hono, type Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { AccessBindings } from './access';
import { defaultConfig, validateConfig, type ScheduleState } from '../lib/scheduler';
import { schedulerConfig, type Deck, type DeckConfig, type Note, type NoteType } from '../lib/types';
import type { ApiScope, ManagedDeck, ManagedNote, ManagedNoteType, NoteInput, NotePatch, NoteTypeInput, TokenInfo } from '../lib/manage-types';

export type ManagementEnv = { Bindings: AccessBindings & { DB: D1Database; MEDIA: R2Bucket; ASSETS: Fetcher; APP_PASSWORD?: string }; Variables: { actor: string; input: Record<string,unknown>; accessClaims: JWTPayload | null } };
type C = Context<ManagementEnv>;
class DomainError extends Error { constructor(message: string, public status: 400|404|409|413 = 400) { super(message); } }
const requireValue: (value: unknown, message: string) => asserts value = (value,message) => { if (!value) throw new DomainError(message); };
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, label: string, max = 10000): string => { requireValue(typeof v === 'string' && v.length <= max, `${label}が不正です。`); return v; };
const name = (v: unknown, label: string): string => { const s=text(v,label,200).trim(); requireValue(!/[\x00-\x1f\x7f]/.test(s),`${label}に制御文字は使えません。`); requireValue(s.length>0, `${label}を入力してください。`); return s; };
const definitionId=(v:unknown,label:string)=>{const s=text(v,label,100);requireValue(/^[A-Za-z0-9_-]{1,100}$/.test(s),`${label}は英数字・ハイフン・アンダースコアで指定してください。`);return s;};
const id = () => BigInt(`0x${crypto.randomUUID().replaceAll('-','')}`).toString();
const timestamp = () => new Date().toISOString();
const digest = async (v: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const p = <T>(s:string) => JSON.parse(s) as T;
const version = (v: unknown) => { requireValue(Number.isInteger(v) && Number(v)>0,'編集バージョンを指定してください。'); return Number(v); };
export function managedType(raw: NoteType, v=1): ManagedNoteType {
 const extra=raw as Partial<ManagedNoteType>;
 return {...raw,version:v,fieldDefinitions:raw.fields.map((n,i)=>({id:extra.fieldDefinitions?.[i]?.id??`field-${i}`,name:n,required:extra.fieldDefinitions?.[i]?.required??false})),templates:raw.templates.map((t,i)=>({...t,id:(t as {id?:string}).id??`template-${i}`}))};
}
async function getType(db:D1Database, typeId:string) {
 const r=await db.prepare('SELECT data,content_version FROM note_types WHERE id=?').bind(typeId).first<{data:string;content_version:number}>();
 if(!r)throw new DomainError('ノートタイプが見つかりません。',404);
 return managedType(p<NoteType>(r.data),r.content_version);
}
async function getDeck(db:D1Database, deckId:string):Promise<ManagedDeck> {
 const r=await db.prepare('SELECT data,content_version FROM decks WHERE id=?').bind(deckId).first<{data:string;content_version:number}>();
 if(!r)throw new DomainError('デッキが見つかりません。',404);
 return {...p<Deck>(r.data),version:r.content_version};
}
interface NoteRow { data:string; content_version:number; type_data:string; type_version:number; card_data:string }
const noteSelect = `SELECT notes.data,notes.content_version,note_types.data AS type_data,note_types.content_version AS type_version,
 (SELECT json_group_array(json_object('id',id,'deckId',deck_id,'ordinal',ordinal,'queue',queue)) FROM cards WHERE note_id=notes.id) AS card_data
 FROM notes JOIN note_types ON note_types.id=json_extract(notes.data,'$.noteTypeId')`;
function noteFromRow(r:NoteRow):ManagedNote {
 const n=p<Note>(r.data);const t=managedType(p<NoteType>(r.type_data),r.type_version);
 const cards=p<{id:string;deckId:string;ordinal:number;queue:number}[]>(r.card_data);
 return {id:n.id,noteTypeId:n.noteTypeId,fields:Object.fromEntries(t.fields.map((f,i)=>[f,n.fields[i]??''])),tags:n.tags,version:r.content_version,contentFormat:n.contentFormat??'html',cards:cards.map(c=>({id:c.id,deckId:c.deckId,templateId:t.templates[t.kind==='cloze'?0:c.ordinal]?.id??'',suspended:c.queue===-1}))};
}
async function getNote(db:D1Database,noteId:string):Promise<ManagedNote> {
 const r=await db.prepare(`${noteSelect} WHERE notes.id=?`).bind(noteId).first<NoteRow>();
 if(!r)throw new DomainError('教材が見つかりません。',404);
 return noteFromRow(r);
}
// Bearer credentials only reach the authoring API, never study, export or token administration.
export async function authorizeBearer(c:C):Promise<boolean> {
 const auth=c.req.header('Authorization');if(!auth)return false;
 if(!auth.startsWith('Bearer ')||!c.req.path.startsWith('/api/manage/'))return false;
 const row=await c.env.DB.prepare('SELECT id,scopes FROM api_tokens WHERE token_hash=? AND revoked=0').bind(await digest(auth.slice(7))).first<{id:string;scopes:string}>();
 if(!row)return false;
 const route=c.req.path.slice('/api/manage/'.length);
 if(/^(tokens|setup)(\/|$)/.test(route))return false;
 const needed:ApiScope=['GET','HEAD'].includes(c.req.method)?'content:read':route.startsWith('note-types')?'types:write':'content:write';
 if(!p<string[]>(row.scopes).includes(needed))return false;
 c.set('actor',`token:${row.id}`);return true;
}
const guard=(db:D1Database, condition:string, args:unknown[]=[])=>db.prepare(`INSERT INTO content_guards(id,valid) VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`).bind(crypto.randomUUID(),...args);
const existingGuard=(db:D1Database,table:string,entityId:string,v:number)=>guard(db,`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND content_version=?)`,[entityId,v]);
const history=(db:D1Database,entity:string,entityId:string,before:unknown,after:unknown,actor:string)=>db.prepare('INSERT INTO content_history(id,entity,entity_id,before_data,after_data,actor,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),entity,entityId,before===null?null:JSON.stringify(before),JSON.stringify(after),actor,timestamp());
async function mutate<T>(c:C,body:Record<string,unknown>,build:()=>Promise<{result:T;statements:D1PreparedStatement[]}>):Promise<T> {
 const requestId=text(body.requestId,'requestId',100);requireValue(/^[a-zA-Z0-9_-]{16,100}$/.test(requestId),'requestIdは16〜100文字の一意な文字列にしてください。');
 const receiptId=`${c.get('actor')??'session'}:${requestId}`;
 const requestHash=await digest(JSON.stringify({path:c.req.path,method:c.req.method,body}));
 const existing=await c.env.DB.prepare('SELECT request_hash,response FROM mutation_receipts WHERE id=?').bind(receiptId).first<{request_hash:string;response:string}>();
 if(existing){if(existing.request_hash!==requestHash)throw new DomainError('requestIdが別の操作で使用されています。',409);return p<T>(existing.response);}
 const {result,statements}=await build();
 const receipt=c.env.DB.prepare('INSERT INTO mutation_receipts(id,request_hash,response) VALUES(?,?,?)').bind(receiptId,requestHash,JSON.stringify(result));
 try{await c.env.DB.batch([receipt,...statements,c.env.DB.prepare('DELETE FROM content_guards')]);}
 catch(error){
  const retry=await c.env.DB.prepare('SELECT request_hash,response FROM mutation_receipts WHERE id=?').bind(receiptId).first<{request_hash:string;response:string}>();
  if(retry&&retry.request_hash===requestHash)return p<T>(retry.response);
  if(/constraint|UNIQUE|CHECK/i.test(String(error)))throw new DomainError('別の操作で更新されています。最新の内容を取得してください。',409);
  throw error;
 }
 return result;
}
function definition(input:Record<string,unknown>,old?:ManagedNoteType):ManagedNoteType {
 const typeName=name(input.name,'ノートタイプ名');
 requireValue(Array.isArray(input.fieldDefinitions)&&input.fieldDefinitions.length>0&&input.fieldDefinitions.length<=32,'フィールドは1〜32個で指定してください。');
 const fields=input.fieldDefinitions.map(f=>{requireValue(object(f),'フィールドが不正です。');const fieldName=name(f.name,'フィールド名');requireValue(!/[{}:\n\r]/.test(fieldName)&&!['Tags','Type','Deck','Subdeck','Card','FrontSide'].includes(fieldName),'このフィールド名は使えません。');requireValue(typeof f.required==='boolean','必須条件が不正です。');return {id:definitionId(f.id,'フィールドID'),name:fieldName,required:f.required};});
 requireValue(new Set(fields.map(f=>f.id)).size===fields.length&&new Set(fields.map(f=>f.name)).size===fields.length,'フィールドID・名前は重複できません。');
 requireValue(Array.isArray(input.templates)&&input.templates.length>0&&input.templates.length<=16,'テンプレートは1〜16個で指定してください。');
 const renames=new Map(old?.fieldDefinitions.filter(f=>fields.some(n=>n.id===f.id&&n.name!==f.name)).map(f=>[f.name,fields.find(n=>n.id===f.id)!.name]));
 const renameRefs=(s:string)=>s.replace(/{{([^{}]+)}}/g,(match,token:string)=>{
  const trimmed=token.trim();const prefix=/^[#^/]/.test(trimmed)?trimmed[0]:'';const rest=prefix?trimmed.slice(1):trimmed;const split=rest.lastIndexOf(':');const ref=rest.slice(split+1);return renames.has(ref)?`{{${prefix}${rest.slice(0,split+1)}${renames.get(ref)}}}`:match;
 });
 const templates=input.templates.map(t=>{requireValue(object(t),'テンプレートが不正です。');const templateId=definitionId(t.id,'テンプレートID');const previous=old?.templates.find(o=>o.id===templateId);const front=text(t.front,'表面',30000);const back=text(t.back,'裏面',30000);return {id:templateId,name:name(t.name,'テンプレート名'),front:previous?.front===front?renameRefs(front):front,back:previous?.back===back?renameRefs(back):back};});
 requireValue(new Set(templates.map(t=>t.id)).size===templates.length,'テンプレートIDは重複できません。');
 const known=new Set([...fields.map(f=>f.name),'Tags','Type','Deck','Subdeck','Card','FrontSide']);
 for(const t of templates){requireValue(t.front.trim()&&t.back.trim(),'表面・裏面を入力してください。');for(const s of [t.front,t.back])for(const m of s.matchAll(/{{([^{}]+)}}/g)){const token=m[1].trim().replace(/^[#^/]/,'');requireValue(known.has(token.split(':').at(-1)!),`不明なフィールド参照: ${m[1]}`);}}
 return {...(old??{}),id:old?.id??id(),name:typeName,kind:'normal',fields:fields.map(f=>f.name),fieldDefinitions:fields,templates,css:text(input.css,'CSS',40000),version:(old?.version??0)+1};
}
const newState=():ScheduleState=>({state:0,due:0,stability:0,difficulty:0,elapsedDays:0,scheduledDays:0,reps:0,lapses:0,lastReview:null,learningSteps:0});
function cardRecord(noteId:string,deckId:string,ordinal:number) {
 const cardId=id();const state=newState();const original={id:cardId,noteId,deckId,ordinal,type:0,queue:0,due:0,interval:0,easeFactor:2500,reps:0,lapses:0,left:0,originalDue:0,originalDeckId:deckId,flags:0,data:'',stability:null,difficulty:null,lastReview:null,dueAt:null,raw:{origin:'dopanki'}};
 return {id:cardId,note_id:noteId,deck_id:deckId,ordinal,schedule:JSON.stringify(state),original:JSON.stringify(original)};
}
function newCard(db:D1Database,noteId:string,deckId:string,ordinal:number) {
 const r=cardRecord(noteId,deckId,ordinal);
 return {id:r.id,statement:db.prepare('INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original) VALUES(?,?,?,?,0,0,0,?,?)').bind(r.id,r.note_id,r.deck_id,r.ordinal,r.schedule,r.original)};
}
function fieldsFor(t:ManagedNoteType,values:unknown,previous?:string[]) {
 requireValue(object(values),'fieldsをフィールド名と値のオブジェクトで指定してください。');
 requireValue(Object.keys(values).every(k=>t.fields.includes(k)),'未定義のフィールドがあります。');
 return t.fieldDefinitions.map((f,i)=>{const v=f.name in values?text(values[f.name],f.name,20000):previous?.[i]??'';requireValue(!f.required||v.trim(),`${f.name}は必須です。`);return v;});
}
const tagsFor=(values:unknown)=>{requireValue(Array.isArray(values)&&values.length<=100,'タグが不正です。');return [...new Set(values.map(v=>name(v,'タグ')))];};
function deckConfig(input:unknown,existing?:DeckConfig):DeckConfig {
 requireValue(input===undefined||object(input),'学習設定が不正です。');
 const config={...(existing??{...defaultConfig(),fsrsEnabled:true,newPerDay:20,reviewPerDay:200}),...(input??{})} as DeckConfig;
 if((config as unknown as {reviewPerDay:unknown}).reviewPerDay===null)delete config.reviewPerDay;
 for(const key of ['newPerDay','reviewPerDay'])if(key!=='reviewPerDay'||config.reviewPerDay!==undefined)requireValue(Number.isInteger(config[key as keyof DeckConfig])&&Number(config[key as keyof DeckConfig])>=0&&Number(config[key as keyof DeckConfig])<=100000,`${key}が不正です。`);
 try{validateConfig({...config,timeZone:'Asia/Tokyo',dayStart:4});}catch(e){throw new DomainError(String(e));}return config;
}
const manager=new Hono<ManagementEnv>();
manager.onError((e,c)=>e instanceof DomainError?c.json({error:e.message},e.status):(console.error(e),c.json({error:'保存に失敗しました。同じrequestIdで再送できます。'},500)));
manager.use('*',async(c,next)=>{
 if(!['GET','HEAD'].includes(c.req.method)){
  const reader=c.req.raw.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>512000){await reader.cancel();throw new DomainError('入力は512KB以下にしてください。',413);}chunks.push(value);}
  const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  let input:unknown;try{input=JSON.parse(new TextDecoder().decode(joined));}catch{throw new DomainError('JSONが不正です。');}
  requireValue(object(input),'JSONオブジェクトを指定してください。');c.set('input',input);
 }
 await next();
});
manager.post('/setup',async c=>{
 const body=c.get('input');
 const result=await mutate(c,body,async()=>{
  const zone=text(body.timeZone,'タイムゾーン',100);const hour=Number(body.dayStart);try{validateConfig({...defaultConfig(),timeZone:zone,dayStart:hour});}catch{throw new DomainError('タイムゾーン・日付切替時刻が不正です。');}
  const now=timestamp();const meta={source:{name:'Dopanki',sha256:'0'.repeat(64),importedAt:now,origin:'dopanki'},collection:{createdAt:Math.floor(Date.now()/1000),today:0,timeZone:zone,dayStart:hour}};
  return {result:{ok:true},statements:[guard(c.env.DB,'NOT EXISTS(SELECT 1 FROM collections)'),c.env.DB.prepare('INSERT INTO collections(id,source_hash,metadata,warnings,imported_at) VALUES(1,?,?,?,?)').bind('0'.repeat(64),JSON.stringify(meta),'[]',now)]};
 });return c.json(result);
});
manager.get('/decks',async c=>{const rows=await c.env.DB.prepare('SELECT data,content_version FROM decks ORDER BY name').all<{data:string;content_version:number}>();return c.json({decks:rows.results.map(r=>({...p<Deck>(r.data),version:r.content_version}))});});
manager.post('/decks',async c=>{
 const body=c.get('input');return c.json(await mutate(c,body,async()=>{
  const leaf=name(body.name,'デッキ名');requireValue(!leaf.includes('::'),'デッキ名に::は使えません。');
  const parent=body.parentId?await getDeck(c.env.DB,text(body.parentId,'親デッキID')):null;
  const deck:ManagedDeck={id:id(),name:parent?`${parent.name}::${leaf}`:leaf,configId:id(),config:deckConfig(body.config),version:1};
  const statements=[guard(c.env.DB,'EXISTS(SELECT 1 FROM collections)')];if(parent)statements.push(existingGuard(c.env.DB,'decks',parent.id,parent.version));
  statements.push(c.env.DB.prepare('INSERT INTO decks(id,name,data) VALUES(?,?,?)').bind(deck.id,deck.name,JSON.stringify(deck)),history(c.env.DB,'deck',deck.id,null,deck,c.get('actor')??'session'));
  return {result:{deck},statements};
 }));
});
manager.patch('/decks/:id',async c=>{
 const body=c.get('input');return c.json(await mutate(c,body,async()=>{
  const old=await getDeck(c.env.DB,c.req.param('id'));if(version(body.version)!==old.version)throw new DomainError('編集バージョンが古いです。',409);
  const leaf=body.name===undefined?old.name.split('::').at(-1)!:name(body.name,'デッキ名');requireValue(!leaf.includes('::'),'デッキ名に::は使えません。');
  let parentName=old.name.includes('::')?old.name.slice(0,old.name.lastIndexOf('::')):'';let parent:ManagedDeck|null=null;
  if('parentId' in body){parent=body.parentId?await getDeck(c.env.DB,text(body.parentId,'親デッキID')):null;parentName=parent?.name??'';}
  requireValue(!parent||!(parent.name===old.name||parent.name.startsWith(`${old.name}::`)),'自分や子デッキを親にはできません。');
  const deck={...old,name:parentName?`${parentName}::${leaf}`:leaf,config:deckConfig(body.config,old.config),version:old.version+1};
  const statements=[existingGuard(c.env.DB,'decks',old.id,old.version)];if(parent)statements.push(existingGuard(c.env.DB,'decks',parent.id,parent.version));
  const newNameExpr="? || substr(name,?)";
  const newDataExpr=`json_set(data,'$.name',${newNameExpr},'$.version',content_version+1)`;
  statements.push(c.env.DB.prepare(`INSERT INTO content_history(id,entity,entity_id,before_data,after_data,actor,created_at)
   SELECT lower(hex(randomblob(16))),'deck',id,data,${newDataExpr},?,? FROM decks WHERE substr(name,1,?)=?`).bind(deck.name,[...old.name].length+1,c.get('actor')??'session',timestamp(),[...old.name].length+2,old.name+'::'));
  statements.push(c.env.DB.prepare(`UPDATE decks SET data=${newDataExpr},name=${newNameExpr},content_version=content_version+1 WHERE substr(name,1,?)=?`).bind(deck.name,[...old.name].length+1,deck.name,[...old.name].length+1,[...old.name].length+2,old.name+'::'));
  statements.push(c.env.DB.prepare('UPDATE decks SET name=?,data=?,content_version=content_version+1 WHERE id=?').bind(deck.name,JSON.stringify(deck),old.id),history(c.env.DB,'deck',deck.id,old,deck,c.get('actor')??'session'));
  return {result:{deck},statements};
 }));
});
manager.get('/note-types',async c=>{const rows=await c.env.DB.prepare('SELECT data,content_version FROM note_types ORDER BY id').all<{data:string;content_version:number}>();return c.json({noteTypes:rows.results.map(r=>managedType(p<NoteType>(r.data),r.content_version))});});
manager.get('/note-types/:id',async c=>c.json({noteType:await getType(c.env.DB,c.req.param('id'))}));
manager.post('/note-types',async c=>{const body=c.get('input');return c.json(await mutate(c,body,async()=>{
 const t=definition(body);return {result:{noteType:t},statements:[c.env.DB.prepare('INSERT INTO note_types(id,data) VALUES(?,?)').bind(t.id,JSON.stringify(t)),history(c.env.DB,'note-type',t.id,null,t,c.get('actor')??'session')]};
}));});
manager.patch('/note-types/:id',async c=>{
 const body=c.get('input');return c.json(await mutate(c,body,async()=>{
  const old=await getType(c.env.DB,c.req.param('id'));if(version(body.version)!==old.version)throw new DomainError('編集バージョンが古いです。',409);requireValue(old.kind==='normal','穴埋めノートタイプの編集は未対応です。');
  const t=definition(body,old);const used=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE json_extract(data,\'$.noteTypeId\')=?').bind(old.id).first<{n:number}>();
  if(used?.n){requireValue(old.fieldDefinitions.every(f=>t.fieldDefinitions.some(n=>n.id===f.id)),'使用中のフィールドは削除できません。');requireValue(old.templates.every(f=>t.templates.some(n=>n.id===f.id)),'使用中のテンプレートは削除できません。');}
  const statements=[existingGuard(c.env.DB,'note_types',old.id,old.version)];
  if(old.fieldDefinitions.some(f=>!t.fieldDefinitions.some(n=>n.id===f.id))||old.templates.some(f=>!t.templates.some(n=>n.id===f.id)))statements.push(guard(c.env.DB,"NOT EXISTS(SELECT 1 FROM notes WHERE json_extract(data,'$.noteTypeId')=?)",[old.id]));
  const fieldMap=t.fieldDefinitions.map(f=>old.fieldDefinitions.findIndex(o=>o.id===f.id));
  const fieldExpr=`json_array(${fieldMap.map(i=>i<0?"''":`COALESCE(json_extract(data,'$.fields[${i}]'),'')`).join(',')})`;
  const newData=`json_set(data,'$.fields',${fieldExpr})`;
  const requiredIndices=t.fieldDefinitions.flatMap((f,i)=>f.required?[fieldMap[i]]:[]);
  const trimCharacters='\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  if(requiredIndices.length)statements.push(guard(c.env.DB,`NOT EXISTS(SELECT 1 FROM notes JOIN json_each(?) f WHERE json_extract(data,'$.noteTypeId')=? AND trim(CASE WHEN f.value<0 THEN '' ELSE COALESCE(json_extract(data,'$.fields['||f.value||']'),'') END,?)='')`,[JSON.stringify(requiredIndices),old.id,trimCharacters]));
  const schemaChanged=JSON.stringify(t.fieldDefinitions)!==JSON.stringify(old.fieldDefinitions);
  if(schemaChanged){statements.push(c.env.DB.prepare(`INSERT INTO content_history(id,entity,entity_id,before_data,after_data,actor,created_at) SELECT lower(hex(randomblob(16))),'note',id,data,${newData},?,? FROM notes WHERE json_extract(data,'$.noteTypeId')=?`).bind(c.get('actor')??'session',timestamp(),old.id));statements.push(c.env.DB.prepare(`UPDATE notes SET data=${newData},content_version=content_version+1 WHERE json_extract(data,'$.noteTypeId')=?`).bind(old.id));}
  const cases=old.templates.map((o,i)=>`WHEN ${i} THEN ${t.templates.findIndex(n=>n.id===o.id)}`).join(' ');
  // Existing cards retain schedules, queues and learning revisions; only their template ordinal follows its stable ID.
  statements.push(c.env.DB.prepare(`UPDATE cards SET ordinal=CASE ordinal ${cases} ELSE ordinal END WHERE note_id IN (SELECT id FROM notes WHERE json_extract(data,'$.noteTypeId')=?)`).bind(old.id));
  for(let i=0;i<t.templates.length;i++)if(!old.templates.some(o=>o.id===t.templates[i].id)){
   // One SQL statement per new template keeps migration bounded for large imported decks.
   statements.push(c.env.DB.prepare(`INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original,suspended_queue) SELECT replace(CAST(random() AS TEXT),'-','')||replace(CAST(random() AS TEXT),'-',''),n.id,(SELECT deck_id FROM cards WHERE note_id=n.id ORDER BY ordinal,id LIMIT 1),?,CASE WHEN NOT EXISTS(SELECT 1 FROM cards WHERE note_id=n.id AND queue<>-1) THEN -1 ELSE 0 END,0,0,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM cards WHERE note_id=n.id AND queue<>-1) THEN 0 ELSE NULL END FROM notes n WHERE json_extract(n.data,'$.noteTypeId')=?`).bind(i,JSON.stringify(newState()),JSON.stringify({origin:'dopanki',type:0,queue:0,due:0,interval:0,easeFactor:2500,reps:0,lapses:0,stability:null,difficulty:null,lastReview:null,dueAt:null}),old.id));
  }
  statements.push(c.env.DB.prepare('UPDATE note_types SET data=?,content_version=content_version+1 WHERE id=?').bind(JSON.stringify(t),old.id),history(c.env.DB,'note-type',t.id,old,t,c.get('actor')??'session'));
  return {result:{noteType:t},statements};
 }));
});
manager.get('/notes',async c=>{
 const limit=Math.max(1,Math.min(100,Number(c.req.query('limit'))||30));const offset=Math.max(0,Number(c.req.query('offset'))||0);requireValue(Number.isInteger(limit)&&Number.isInteger(offset),'ページ指定が不正です。');
 const q=c.req.query('q')??'';requireValue(q.length<=200,'検索語が長すぎます。');
 const conditions:string[]=[];const args:string[]=[];
 const noteTypeId=c.req.query('noteTypeId')??'';const deckId=c.req.query('deckId')??'';
 if(q){conditions.push('instr(notes.data,?)>0');args.push(q);}
 if(noteTypeId){conditions.push("json_extract(notes.data,'$.noteTypeId')=?");args.push(noteTypeId);}
 // LIMIT 1 keeps this a scalar existence check: SQLite 3.51.2's EXISTS-to-join
 // optimization can otherwise count matching cards toward OFFSET instead of notes.
 if(deckId){conditions.push('EXISTS(SELECT 1 FROM cards WHERE note_id=notes.id AND deck_id=? LIMIT 1)');args.push(deckId);}
 // Page and exact count use the same qualified predicates and bound values.
 const where=conditions.length?` WHERE ${conditions.join(' AND ')}`:'';
 const rows=await c.env.DB.prepare(`${noteSelect}${where} ORDER BY notes.id LIMIT ? OFFSET ?`).bind(...args,limit,offset).all<NoteRow>();
 const total=await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM notes${where}`).bind(...args).first<{n:number}>();
 return c.json({notes:rows.results.map(noteFromRow),total:total?.n??0});
});
manager.get('/notes/:id',async c=>c.json({note:await getNote(c.env.DB,c.req.param('id'))}));
async function buildNote(c:C,body:Record<string,unknown>) {
 const t=await getType(c.env.DB,text(body.noteTypeId,'ノートタイプID'));requireValue(t.kind==='normal','穴埋め教材の新規作成は未対応です。');
 const deck=await getDeck(c.env.DB,text(body.deckId,'デッキID'));const fields=fieldsFor(t,body.fields);const n:Note={id:id(),guid:crypto.randomUUID(),noteTypeId:t.id,fields,tags:tagsFor(body.tags??[]),contentFormat:'plain'};
 const cards=t.templates.map((template,i)=>({...newCard(c.env.DB,n.id,deck.id,i),templateId:template.id}));
 const note:ManagedNote={id:n.id,noteTypeId:t.id,fields:Object.fromEntries(t.fields.map((f,i)=>[f,fields[i]])),tags:n.tags,version:1,contentFormat:'plain',cards:cards.map(card=>({id:card.id,deckId:deck.id,templateId:card.templateId,suspended:false}))};
 const statements=[guard(c.env.DB,'EXISTS(SELECT 1 FROM collections)'),existingGuard(c.env.DB,'note_types',t.id,t.version),existingGuard(c.env.DB,'decks',deck.id,deck.version),c.env.DB.prepare('INSERT INTO notes(id,data) VALUES(?,?)').bind(n.id,JSON.stringify(n)),...cards.map(x=>x.statement),history(c.env.DB,'note',n.id,null,n,c.get('actor')??'session')];return {result:{note},statements};
}
async function patchNote(c:C,noteId:string,body:Record<string,unknown>){
 requireValue(!('noteTypeId' in body),'編集ではノートタイプを変更できません。');
 const joined=await c.env.DB.prepare(`${noteSelect} WHERE notes.id=?`).bind(noteId).first<NoteRow>();if(!joined)throw new DomainError('教材が見つかりません。',404);
 const old=noteFromRow(joined);if(version(body.version)!==old.version)throw new DomainError('編集バージョンが古いです。',409);
 const t=managedType(p<NoteType>(joined.type_data),joined.type_version);const raw=p<Note>(joined.data);
 // Imported HTML is kept unless explicitly converted; native notes always render as escaped text.
 const fields=fieldsFor(t,body.fields??{},raw.fields);const tags=body.tags===undefined?raw.tags:tagsFor(body.tags);
 const next={...raw,fields,tags};const statements=[existingGuard(c.env.DB,'notes',noteId,old.version),existingGuard(c.env.DB,'note_types',t.id,t.version),c.env.DB.prepare('UPDATE notes SET data=?,content_version=content_version+1 WHERE id=?').bind(JSON.stringify(next),noteId)];
 let deck:ManagedDeck|undefined;if(body.deckId!==undefined){deck=await getDeck(c.env.DB,text(body.deckId,'デッキID'));statements.push(existingGuard(c.env.DB,'decks',deck.id,deck.version),c.env.DB.prepare('UPDATE cards SET deck_id=? WHERE note_id=?').bind(deck.id,noteId));}
 if(body.suspended!==undefined){requireValue(typeof body.suspended==='boolean','出題停止の指定が不正です。');statements.push(body.suspended?c.env.DB.prepare('UPDATE cards SET suspended_queue=queue,queue=-1 WHERE note_id=? AND queue<>-1').bind(noteId):c.env.DB.prepare('UPDATE cards SET queue=COALESCE(suspended_queue,CASE WHEN state=0 THEN 0 WHEN state=2 THEN 2 ELSE 1 END),suspended_queue=NULL WHERE note_id=? AND queue=-1').bind(noteId));}
 statements.push(history(c.env.DB,'note',noteId,raw,next,c.get('actor')??'session'));
 const note:ManagedNote={...old,version:old.version+1,fields:Object.fromEntries(t.fields.map((f,i)=>[f,fields[i]])),tags,cards:old.cards.map(card=>({...card,deckId:deck?.id??card.deckId,suspended:typeof body.suspended==='boolean'?body.suspended:card.suspended}))};
 return {result:{note},statements};
}
manager.post('/notes',async c=>{const body=c.get('input');return c.json(await mutate(c,body,()=>buildNote(c,body)));});
manager.patch('/notes/:id',async c=>{const body=c.get('input');return c.json(await mutate(c,body,()=>patchNote(c,c.req.param('id'),body)));});
// Bulk preloads catalogs once and uses JSON table-valued inputs for bounded SQL work.
// Valid items share a transaction; invalid items get independent validation outcomes.
manager.post('/notes/bulk',async c=>{
 const body=c.get('input');requireValue(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=20,'一括操作は1〜20件で指定してください。');
 const requestId=text(body.requestId,'requestId',80);requireValue(/^[a-zA-Z0-9_-]{16,80}$/.test(requestId),'requestIdが不正です。');
 const actor=c.get('actor')??'session';
 const items=body.items as unknown[];
 const receiptIds=items.map((_,i)=>`${actor}:${requestId}_${i}`);
 type Receipt={id:string;request_hash:string;response:string};
 const readReceipts=()=>c.env.DB.prepare('SELECT id,request_hash,response FROM mutation_receipts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(receiptIds)).all<Receipt>();
 const oldReceipts=new Map((await readReceipts()).results.map(r=>[r.id,r]));
 const noteIds=items.filter(object).filter(x=>x.operation==='update'&&typeof x.id==='string').map(x=>x.id);
 const noteRows=await c.env.DB.prepare(`${noteSelect} WHERE notes.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(noteIds)).all<NoteRow>();
 const noteMap=new Map(noteRows.results.map(r=>[p<Note>(r.data).id,r]));
 const typeIds=items.filter(object).filter(x=>x.operation==='create'&&typeof x.noteTypeId==='string').map(x=>x.noteTypeId);
 const typeRows=await c.env.DB.prepare('SELECT id,data,content_version FROM note_types WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(typeIds)).all<{id:string;data:string;content_version:number}>();
 const typeMap=new Map(typeRows.results.map(r=>[r.id,managedType(p<NoteType>(r.data),r.content_version)]));
 const deckIds=items.filter(object).filter(x=>typeof x.deckId==='string').map(x=>x.deckId);
 const deckRows=await c.env.DB.prepare('SELECT id,data,content_version FROM decks WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(deckIds)).all<{id:string;data:string;content_version:number}>();
 const deckMap=new Map(deckRows.results.map(r=>[r.id,{...p<Deck>(r.data),version:r.content_version}]));
 const results:({index:number;ok:true;note:ManagedNote}|{index:number;ok:false;status:number;error:string})[]=[];
 const receipts:Receipt[]=[];const inserts:{id:string;data:string;version:number}[]=[];
 const updates=new Map<string,{id:string;data:string;version:number}>();
 const cards:ReturnType<typeof cardRecord>[]=[];
 const cardChanges=new Map<string,{noteId:string;deckId?:string;suspended?:boolean}>();
 const guards=new Map<string,{table:string;id:string;version:number}>();
 const histories:{id:string;entity_id:string;before_data:string|null;after_data:string;actor:string;created_at:string}[]=[];
 const guardVersion=(table:string,entityId:string,v:number)=>guards.set(`${table}:${entityId}:${v}`,{table,id:entityId,version:v});
 for(let i=0;i<items.length;i++){
  try{
   requireValue(object(items[i]),'項目が不正です。');const item=items[i] as Record<string,unknown>;
   requireValue(item.operation==='create'||item.operation==='update','operationはcreateまたはupdateです。');
   const sub={...item,requestId:`${requestId}_${i}`};const requestHash=await digest(JSON.stringify({path:c.req.path,method:c.req.method,body:sub}));
   const previous=oldReceipts.get(receiptIds[i]);
   if(previous){if(previous.request_hash!==requestHash)throw new DomainError('requestIdが別の操作で使用されています。',409);results.push({index:i,ok:true,...p<{note:ManagedNote}>(previous.response)});continue;}
   let raw:Note;let next:Note;let note:ManagedNote;let t:ManagedNoteType;let before:Note|null=null;
   let pendingCards:ReturnType<typeof cardRecord>[]=[];let change:{noteId:string;deckId?:string;suspended?:boolean}|undefined;
   let referencedDeck:ManagedDeck|undefined;
   if(item.operation==='create'){
    const typeId=text(item.noteTypeId,'ノートタイプID');const found=typeMap.get(typeId);if(!found)throw new DomainError('ノートタイプが見つかりません。',404);t=found;
    requireValue(t.kind==='normal','穴埋め教材の新規作成は未対応です。');
    referencedDeck=deckMap.get(text(item.deckId,'デッキID'));if(!referencedDeck)throw new DomainError('デッキが見つかりません。',404);
    const fields=fieldsFor(t,item.fields);raw={id:id(),guid:crypto.randomUUID(),noteTypeId:t.id,fields,tags:tagsFor(item.tags??[]),contentFormat:'plain'};next=raw;
    pendingCards=t.templates.map((_,ordinal)=>cardRecord(raw.id,referencedDeck!.id,ordinal));
    note={id:raw.id,noteTypeId:t.id,fields:Object.fromEntries(t.fields.map((f,j)=>[f,fields[j]])),tags:raw.tags,version:1,contentFormat:'plain',cards:pendingCards.map((card,j)=>({id:card.id,deckId:card.deck_id,templateId:t.templates[j].id,suspended:false}))};
   }else{
    requireValue(!('noteTypeId' in item),'編集ではノートタイプを変更できません。');const noteId=text(item.id,'教材ID');const row=noteMap.get(noteId);if(!row)throw new DomainError('教材が見つかりません。',404);
    const old=noteFromRow(row);if(version(item.version)!==old.version)throw new DomainError('編集バージョンが古いです。',409);
    t=managedType(p<NoteType>(row.type_data),row.type_version);raw=p<Note>(row.data);before=raw;
    next={...raw,fields:fieldsFor(t,item.fields??{},raw.fields),tags:item.tags===undefined?raw.tags:tagsFor(item.tags)};
    if(item.deckId!==undefined){referencedDeck=deckMap.get(text(item.deckId,'デッキID'));if(!referencedDeck)throw new DomainError('デッキが見つかりません。',404);}
    if(item.suspended!==undefined)requireValue(typeof item.suspended==='boolean','出題停止の指定が不正です。');
    note={...old,version:old.version+1,fields:Object.fromEntries(t.fields.map((f,j)=>[f,next.fields[j]])),tags:next.tags,cards:old.cards.map(card=>({...card,deckId:referencedDeck?.id??card.deckId,suspended:typeof item.suspended==='boolean'?item.suspended:card.suspended}))};
    if(referencedDeck||typeof item.suspended==='boolean')change={...(cardChanges.get(noteId)??{noteId}),...(referencedDeck?{deckId:referencedDeck.id}:{}),...(typeof item.suspended==='boolean'?{suspended:item.suspended}:{})};
   }
   // No plan is published until every validation for this item has succeeded.
   guardVersion('note_types',t.id,t.version);if(referencedDeck)guardVersion('decks',referencedDeck.id,referencedDeck.version);
   if(before){const row=noteMap.get(raw.id)!;if(!updates.has(raw.id))guardVersion('notes',raw.id,row.content_version);updates.set(raw.id,{id:raw.id,data:JSON.stringify(next),version:note.version});
    const priorCards=p<{id:string;deckId:string;ordinal:number;queue:number}[]>(row.card_data);
    noteMap.set(raw.id,{...row,data:JSON.stringify(next),content_version:note.version,card_data:JSON.stringify(priorCards.map(card=>({...card,deckId:referencedDeck?.id??card.deckId,queue:typeof item.suspended==='boolean'?(item.suspended?-1:0):card.queue})))});
   }else{inserts.push({id:raw.id,data:JSON.stringify(next),version:1});cards.push(...pendingCards);}
   if(change)cardChanges.set(raw.id,change);
   histories.push({id:crypto.randomUUID(),entity_id:raw.id,before_data:before?JSON.stringify(before):null,after_data:JSON.stringify(next),actor,created_at:timestamp()});
   receipts.push({id:receiptIds[i],request_hash:requestHash,response:JSON.stringify({note})});results.push({index:i,ok:true,note});
  }catch(e){if(!(e instanceof DomainError))throw e;results.push({index:i,ok:false,status:e.status,error:e.message});}
 }
 if(!receipts.length)return c.json({results});
 const encode=(v:unknown)=>{const s=JSON.stringify(v);if(new TextEncoder().encode(s).length>1500000)throw new DomainError('一括保存のデータが大きすぎます。少ない件数に分けてください。',413);return s;};
 const statements:D1PreparedStatement[]=[];
 const guardData=encode([...guards.values()]);
 statements.push(guard(c.env.DB,`NOT EXISTS(SELECT 1 FROM json_each(?) g WHERE
  (json_extract(g.value,'$.table')='notes' AND NOT EXISTS(SELECT 1 FROM notes WHERE id=json_extract(g.value,'$.id') AND content_version=json_extract(g.value,'$.version'))) OR
  (json_extract(g.value,'$.table')='note_types' AND NOT EXISTS(SELECT 1 FROM note_types WHERE id=json_extract(g.value,'$.id') AND content_version=json_extract(g.value,'$.version'))) OR
  (json_extract(g.value,'$.table')='decks' AND NOT EXISTS(SELECT 1 FROM decks WHERE id=json_extract(g.value,'$.id') AND content_version=json_extract(g.value,'$.version'))))`,[guardData]));
 if(inserts.length){statements.push(guard(c.env.DB,'EXISTS(SELECT 1 FROM collections)'));statements.push(c.env.DB.prepare(`INSERT INTO notes(id,data,content_version) SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),1 FROM json_each(?)`).bind(encode(inserts)));}
 if(updates.size)statements.push(c.env.DB.prepare(`UPDATE notes SET data=json_extract(j.value,'$.data'),content_version=json_extract(j.value,'$.version') FROM json_each(?) j WHERE notes.id=json_extract(j.value,'$.id')`).bind(encode([...updates.values()])));
 if(cards.length)statements.push(c.env.DB.prepare(`INSERT INTO cards(id,note_id,deck_id,ordinal,queue,state,due,schedule,original) SELECT json_extract(value,'$.id'),json_extract(value,'$.note_id'),json_extract(value,'$.deck_id'),json_extract(value,'$.ordinal'),0,0,0,json_extract(value,'$.schedule'),json_extract(value,'$.original') FROM json_each(?)`).bind(encode(cards)));
 if(cardChanges.size)statements.push(c.env.DB.prepare(`UPDATE cards SET
  deck_id=COALESCE(json_extract(j.value,'$.deckId'),deck_id),
  suspended_queue=CASE WHEN json_extract(j.value,'$.suspended')=1 AND queue<>-1 THEN queue WHEN json_extract(j.value,'$.suspended')=0 AND queue=-1 THEN NULL ELSE suspended_queue END,
  queue=CASE WHEN json_extract(j.value,'$.suspended')=1 THEN -1 WHEN json_extract(j.value,'$.suspended')=0 AND queue=-1 THEN COALESCE(suspended_queue,CASE WHEN state=0 THEN 0 WHEN state=2 THEN 2 ELSE 1 END) ELSE queue END
  FROM json_each(?) j WHERE cards.note_id=json_extract(j.value,'$.noteId')`).bind(encode([...cardChanges.values()])));
 statements.push(c.env.DB.prepare(`INSERT INTO content_history(id,entity,entity_id,before_data,after_data,actor,created_at) SELECT json_extract(value,'$.id'),'note',json_extract(value,'$.entity_id'),json_extract(value,'$.before_data'),json_extract(value,'$.after_data'),json_extract(value,'$.actor'),json_extract(value,'$.created_at') FROM json_each(?)`).bind(encode(histories)));
 statements.push(c.env.DB.prepare(`INSERT INTO mutation_receipts(id,request_hash,response) SELECT json_extract(value,'$.id'),json_extract(value,'$.request_hash'),json_extract(value,'$.response') FROM json_each(?)`).bind(encode(receipts)),c.env.DB.prepare('DELETE FROM content_guards'));
 try{await c.env.DB.batch(statements);}catch(e){
  if(!/constraint|UNIQUE|CHECK/i.test(String(e)))throw e;
  const concurrent=new Map((await readReceipts()).results.map(r=>[r.id,r]));
  for(const receipt of receipts){const index=receiptIds.indexOf(receipt.id);const saved=concurrent.get(receipt.id);results[index]=saved?.request_hash===receipt.request_hash?{index,ok:true,...p<{note:ManagedNote}>(saved.response)}:{index,ok:false,status:409,error:'別の操作で更新されています。最新の内容を取得してください。'};}
 }
 return c.json({results});
});
manager.get('/notes/:id/history',async c=>{
 await getNote(c.env.DB,c.req.param('id'));const rows=await c.env.DB.prepare('SELECT * FROM content_history WHERE entity=\'note\' AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(c.req.param('id')).all<{id:string;before_data:string|null;after_data:string;actor:string;created_at:string}>();
 return c.json({history:rows.results.map(r=>({id:r.id,before:r.before_data?p(r.before_data):null,after:p(r.after_data),actor:r.actor,createdAt:r.created_at}))});
});
const tokenInfo=(r:{id:string;name:string;scopes:string;created_at:string;revoked:number}):TokenInfo=>({id:r.id,name:r.name,scopes:p<ApiScope[]>(r.scopes),createdAt:r.created_at,revoked:!!r.revoked});
manager.get('/tokens',async c=>{const rows=await c.env.DB.prepare('SELECT id,name,scopes,created_at,revoked FROM api_tokens ORDER BY created_at DESC').all<Parameters<typeof tokenInfo>[0]>();return c.json({tokens:rows.results.map(tokenInfo)});});
manager.post('/tokens',async c=>{
 const body=c.get('input');
 // Token plaintext is returned once, and never stored in a mutation receipt or history.
 const tokenName=name(body.name,'トークン名');requireValue(Array.isArray(body.scopes)&&body.scopes.length>0&&body.scopes.every(s=>['content:read','content:write','types:write'].includes(String(s))),'権限が不正です。');
 const token=`dpk_${crypto.randomUUID().replaceAll('-','')}${crypto.randomUUID().replaceAll('-','')}`;const tokenId=id();const now=timestamp();const hash=await digest(token);
 const result=await mutate(c,body,async()=>({result:{info:{id:tokenId,name:tokenName,scopes:[...new Set(body.scopes as ApiScope[])],createdAt:now,revoked:false}},statements:[c.env.DB.prepare('INSERT INTO api_tokens(id,name,token_hash,scopes,created_at) VALUES(?,?,?,?,?)').bind(tokenId,tokenName,hash,JSON.stringify([...new Set(body.scopes as ApiScope[])]),now)]}));
 return c.json({...result,token:result.info.id===tokenId?token:null});
});
manager.post('/tokens/:id/revoke',async c=>{const body=c.get('input');return c.json(await mutate(c,body,async()=>({result:{ok:true},statements:[c.env.DB.prepare('UPDATE api_tokens SET revoked=1 WHERE id=?').bind(c.req.param('id'))]})));});
export default manager;
