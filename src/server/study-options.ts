import { Hono } from 'hono';
import type { ManagementEnv } from './manage';
import { summarizeDecks, type DeckAnswers, type DeckTotals } from '../lib/decks';
import { nextStudyDayBoundary, retrievabilities, studyDate, studyDayBoundary, type ScheduleState } from '../lib/scheduler';
import { schedulerConfig, type Deck, type DeckSummary, type ImportDocument, type StoredCard } from '../lib/types';
import type { RestartPreview, RestartStatus, StudyOptionsResponse } from '../lib/study-options-types';

export const validFocusIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 10 &&
  ids.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(ids).size === ids.length;
export function importedIntraday(state: ScheduleState, original: string): boolean {
  const source=parse<{queue:number;reps:number;lastReview:number|null}>(original);
  return source.queue===1&&state.reps===source.reps&&state.lastReview===source.lastReview;
}
/** Imports use Anki's queue; older local answers stored interday steps in queue 1. */
export function intradayLearning(card: StoredCard): boolean {
  if(card.queue!==1||(card.state!==1&&card.state!==3))return false;
  const state=parse<ScheduleState>(card.schedule);
  return card.last_event_id===null||state.scheduledDays===0||importedIntraday(state,card.original);
}

interface RestartRow {
  id: string; deck_id: string; scope: string; revision: number; daily_review_limit: number; daily_new_limit: number;
  backlog_per_day: number; paused: number; flattened: number; cancelled: number;
  created_at: number; backlog_total: number;
}
interface ExtraRow { deck_id: string; study_day: number; new_extra: number; review_extra: number }
interface Member { restart_id: string; card_id: string; revision: number; original_due: number;
  available_at: number; backlog: number; answered_event_id: string | null }
interface CreditEvent { restart_id:string|null; grant_deck_id:string; backlog:number; deck_id:string; category:"new"|"review" }
interface Assignment { cardId: string; revision: number; due: number; availableAt: number; backlog: number }
interface PreviewRow { token: string; deck_id: string; generation: number; study_day: number;
  daily_review_limit: number; daily_new_limit: number; backlog_per_day: number; flattened: number; scope: string;
  assignments: string; summary: string }
export interface StudyContext {
  db: D1Database; now: number; boundary: number; generation: number;
  collection: ImportDocument['collection']; decks: DeckSummary[]; originalDecks: Deck[];
  totals: DeckTotals[]; answers: DeckAnswers[]; extras: ExtraRow[]; restarts: RestartRow[]; members: Member[];
  restartUsage: {id:string;cards:number}[]; creditEvents:CreditEvent[]; cards?:StoredCard[]; retrievabilities?:Map<string,number>; memberIndex?:Map<string,Member>; activeMemberCache?:Map<string,Member|undefined>;
}
const parse = <T>(value: string): T => JSON.parse(value) as T;
const requestId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(v);
const limit = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 99999;
const newLimit = (v: unknown): v is number => limit(v) && Number(v) <= 10000;
const positive = (v: unknown): v is number => limit(v) && Number(v) > 0;
const scopeOf = (decks: { id: string; name: string; virtual?: boolean }[], deck: { name: string }): string[] =>
  decks.filter(d => !d.virtual && (d.name === deck.name || d.name.startsWith(deck.name+'::'))).map(d => d.id);
const inScope = (scope: string, deckId: string) => parse<string[]>(scope).includes(deckId);
function restartContains(ctx:StudyContext,restart:RestartRow,deckId:string):boolean {
  const owner=ctx.decks.find(d=>d.id===restart.deck_id);
  return !!owner&&(restart.deck_id===deckId||(inScope(restart.scope,deckId)&&scopeOf(ctx.decks,owner).includes(deckId)));
}

/** SQL definition shared by rendering and atomic answer admission. Intraday steps consume no new/review quota. */
export const dailyAnswersSql = `SELECT deck_id,SUM(answered) AS answered,SUM(new) AS new,SUM(review) AS review FROM (
  SELECT deck_id,COUNT(*) AS answered,
    SUM(CASE WHEN json_extract(before_state,'$.state')=0 THEN 1 ELSE 0 END) AS new,
    SUM(CASE WHEN json_extract(before_state,'$.state')=2 THEN 1 ELSE 0 END) AS review
  FROM review_events WHERE reviewed_at>=? AND reviewed_at<=? AND undone=0 GROUP BY deck_id
  UNION ALL
  SELECT c.deck_id,COUNT(*) AS answered,
    SUM(CASE WHEN json_extract(r.data,'$.type')=0 AND json_extract(r.data,'$.reviewedAt')=(
      SELECT MIN(json_extract(first.data,'$.reviewedAt')) FROM imported_reviews first WHERE first.card_id=r.card_id
      AND json_extract(first.data,'$.rating') BETWEEN 1 AND 4 AND json_extract(first.data,'$.type') IN (0,1,2,3)
    ) THEN 1 ELSE 0 END) AS new,
    SUM(CASE WHEN json_extract(r.data,'$.type')=1 THEN 1 ELSE 0 END) AS review
  FROM imported_reviews r JOIN cards c ON c.id=r.card_id
  WHERE json_extract(r.data,'$.reviewedAt')>=? AND json_extract(r.data,'$.reviewedAt')<=?
    AND json_extract(r.data,'$.rating') BETWEEN 1 AND 4 AND json_extract(r.data,'$.type') IN (0,1,2,3)
  GROUP BY c.deck_id
) GROUP BY deck_id`;

export async function studyContext(db: D1Database, now: number): Promise<StudyContext | null> {
  // Capture before all reads, so any intervening card/config/control change invalidates admission.
  const meta=await db.prepare(`SELECT metadata,(SELECT revision FROM study_generation WHERE id=1) AS generation FROM collections WHERE id=1`).first<{metadata:string;generation:number}>();
  if(!meta)return null;
  const {collection}=parse<{collection:ImportDocument['collection']}>(meta.metadata);
  const boundary=studyDayBoundary(now,collection.timeZone,collection.dayStart);
  // A bounded number of D1 calls even for large deck trees. Each aggregate is one JSON array.
  const data=await db.prepare(`SELECT
    (SELECT json_group_array(json(data)) FROM decks) AS decks,
    (SELECT json_group_array(json_object('deck_id',deck_id,'total',total,'new',new,'learning',learning,'review',review)) FROM (
      SELECT deck_id,COUNT(*) total,SUM(queue=0) new,SUM(queue IN(1,3) AND due<=?) learning,SUM(queue=2 AND due<=?) review FROM cards GROUP BY deck_id)) AS totals,
    (SELECT json_group_array(json_object('deck_id',deck_id,'answered',answered,'new',new,'review',review)) FROM (${dailyAnswersSql})) AS answers,
    (SELECT json_group_array(json_object('deck_id',deck_id,'study_day',study_day,'new_extra',new_extra,'review_extra',review_extra)) FROM study_extras WHERE study_day=?) AS extras,
    (SELECT json_group_array(json_object('id',id,'deck_id',deck_id,'scope',scope,'revision',revision,'daily_review_limit',daily_review_limit,'daily_new_limit',daily_new_limit,
      'backlog_per_day',backlog_per_day,'paused',paused,'flattened',flattened,'cancelled',cancelled,'created_at',created_at,'backlog_total',backlog_total)) FROM study_restarts WHERE cancelled=0) AS restarts,
    (SELECT json_group_array(json_object('restart_id',m.restart_id,'card_id',m.card_id,'revision',m.revision,'original_due',m.original_due,
      'available_at',m.available_at,'backlog',m.backlog,'answered_event_id',m.answered_event_id)) FROM study_restart_members m JOIN study_restarts r ON r.id=m.restart_id WHERE r.cancelled=0) AS members,
    (SELECT json_group_array(json_object('id',restart_id,'cards',cards)) FROM (SELECT restart_id,COUNT(*) cards FROM review_events
      WHERE restart_backlog=1 AND reviewed_at>=? AND reviewed_at<=? AND undone=0 GROUP BY restart_id)) AS restart_usage,
    (SELECT json_group_array(json_object('restart_id',restart_id,'grant_deck_id',COALESCE(ordinary_extra_deck_id,restart_extra_deck_id),'backlog',restart_backlog,'deck_id',deck_id,'category',CASE WHEN json_extract(before_state,'$.state')=0 THEN 'new' ELSE 'review' END))
      FROM review_events WHERE (ordinary_extra_deck_id IS NOT NULL OR restart_extra_deck_id IS NOT NULL) AND reviewed_at>=? AND reviewed_at<=? AND undone=0) AS credits
  `).bind(now,now,boundary,now,boundary,now,boundary,boundary,now,boundary,now).first<Record<string,string>>();
  const rows={results:parse<Deck[]>(data!.decks).map(d=>({data:JSON.stringify(d)}))};
  const totals={results:parse<DeckTotals[]>(data!.totals)};
  const answers={results:parse<DeckAnswers[]>(data!.answers)};
  const extras={results:parse<ExtraRow[]>(data!.extras)};
  const restarts={results:parse<RestartRow[]>(data!.restarts)};
  const members={results:parse<Member[]>(data!.members)};
  const originalDecks = rows.results.map(r => parse<Deck>(r.data));
  const rawSummaries = summarizeDecks(originalDecks,totals.results,answers.results);
  const adjusted = rawSummaries.map(d => {
    const granted = extras.results.filter(e => {
      const owner = rawSummaries.find(owner => owner.id===e.deck_id);
      return owner && (d.name===owner.name || d.name.startsWith(owner.name+'::'));
    });
    return { ...d,config:{...d.config,
      newPerDay:Math.min(Number.MAX_SAFE_INTEGER,d.config.newPerDay+granted.reduce((n,e)=>n+e.new_extra,0)),
      reviewPerDay:Math.min(Number.MAX_SAFE_INTEGER,(d.config.reviewPerDay??9999)+granted.reduce((n,e)=>n+e.review_extra,0)) } };
  });
  // summarizeDecks also derives virtual ancestors; keep the adjusted virtual configuration below.
  const adjustedTotals = summarizeDecks(adjusted,totals.results,answers.results);
  return { db,now,boundary,generation:meta.generation,collection,decks:adjustedTotals,originalDecks,
    totals:totals.results,answers:answers.results,extras:extras.results,restarts:restarts.results,members:members.results,restartUsage:parse(data!.restart_usage),creditEvents:parse(data!.credits) };
}

function restartExtra(ctx:StudyContext,restart:RestartRow,category:'new'|'review'='review'):number {
  const ids=parse<string[]>(restart.scope);
  return ctx.extras.filter(e=>{
    const owner=ctx.decks.find(d=>d.id===e.deck_id);
    return owner&&scopeOf(ctx.decks,owner).some(id=>ids.includes(id));
  }).reduce((n,e)=>n+(category==='new'?e.new_extra:e.review_extra),0);
}
interface Cap { scope:string[]; new:number; review:number }
/** Ordinary caps come only from the selected path. Grants are a separate shared credit ledger. */
function capsFor(ctx:StudyContext,selected:DeckSummary,actual:DeckSummary):Cap[] {
  const active=ctx.restarts.find(r=>!r.paused&&restartContains(ctx,r,actual.id));
  return ctx.decks.filter(d=>(d.name===actual.name||actual.name.startsWith(d.name+'::'))&&
    (d.name===selected.name||d.name.startsWith(selected.name+'::'))&&
    (!active||!(active.deck_id===d.id||inScope(active.scope,d.id)))).map(d=>{
    const original=ctx.originalDecks.find(original=>original.id===d.id);
    return {scope:scopeOf(ctx.decks,d),new:original?.config.newPerDay??Number.MAX_SAFE_INTEGER,
      review:original?(original.config.reviewPerDay??9999):Number.MAX_SAFE_INTEGER};
  });
}
function used(ctx: StudyContext, scope: string[], category: 'new'|'review'): number {
  return ctx.answers.filter(a=>scope.includes(a.deck_id)).reduce((n,a)=>n+(a[category]??0),0);
}
function baseUsed(ctx:StudyContext,scope:string[],category:'new'|'review'):number {
  return used(ctx,scope,category)-ctx.creditEvents.filter(e=>e.category===category&&scope.includes(e.deck_id)).length;
}
function grantUsed(ctx:StudyContext,deckId:string,category:'new'|'review'):number {
  return ctx.creditEvents.filter(e=>e.grant_deck_id===deckId&&e.category===category).length;
}
function remainingRestartExtra(ctx:StudyContext,restart:RestartRow):number {
  const ids=parse<string[]>(restart.scope);
  return ctx.extras.filter(e=>{
    const owner=ctx.decks.find(d=>d.id===e.deck_id);
    return owner&&scopeOf(ctx.decks,owner).some(id=>ids.includes(id));
  }).reduce((n,e)=>n+Math.max(0,e.review_extra-grantUsed(ctx,e.deck_id,'review')),0);
}
export function activeMember(ctx: StudyContext, card: StoredCard): Member | undefined {
  if(card.queue!==2||card.state!==2)return undefined;
  if(!ctx.memberIndex)ctx.memberIndex=new Map(ctx.members.map(m=>[m.card_id,m]));
  if(!ctx.activeMemberCache)ctx.activeMemberCache=new Map();
  if(ctx.activeMemberCache.has(card.id))return ctx.activeMemberCache.get(card.id);
  const m=ctx.memberIndex.get(card.id);
  const valid=m&&m.revision===card.revision&&!m.answered_event_id&&
    ctx.restarts.some(r=>r.id===m.restart_id&&!r.paused&&restartContains(ctx,r,card.deck_id))?m:undefined;
  ctx.activeMemberCache.set(card.id,valid);
  return valid;
}
function backlogUsed(ctx: StudyContext, restartId: string): number {
  return ctx.restartUsage.find(r=>r.id===restartId)?.cards??0;
}
interface Reservations { base:Map<string,number>; restart:Map<string,number>; backlog:Map<string,number>; grants:Map<string,number> }
const capKey=(cap:Cap,category:'new'|'review')=>JSON.stringify([category,cap.scope,cap[category]]);
const grantKey=(deckId:string,category:'new'|'review')=>category+':'+deckId;
/** One decision serves candidate counts and writes: preserve baseline first, then spend one matching shared extra. */
function cardAllowance(ctx:StudyContext,selected:DeckSummary,card:StoredCard,reserved?:Reservations):{allowed:boolean;restart?:RestartRow;grant?:string;caps:Cap[]} {
  const actual=ctx.decks.find(d=>d.id===card.deck_id)!;
  const caps=capsFor(ctx,selected,actual);
  if(card.state!==0&&card.state!==2)return {allowed:true,caps};
  const category=card.state===0?'new':'review';
  const restart=ctx.restarts.find(r=>!r.paused&&restartContains(ctx,r,card.deck_id));
  const normalRoom=caps.every(cap=>baseUsed(ctx,cap.scope,category)+(reserved?.base.get(capKey(cap,category))??0)<cap[category]);
  const member=activeMember(ctx,card);
  const backlogCredits=restart?ctx.creditEvents.filter(e=>e.restart_id===restart.id&&e.backlog).length:0;
  const restartRoom=!restart||(baseUsed(ctx,parse(restart.scope),category)+(reserved?.restart.get(grantKey(restart.id,category))??0)<(category==='new'?restart.daily_new_limit:restart.daily_review_limit)&&
    (!member?.backlog||backlogUsed(ctx,restart.id)-backlogCredits+(reserved?.backlog.get(restart.id)??0)<restart.backlog_per_day));
  if(normalRoom&&restartRoom)return {allowed:true,restart,caps};
  const grant=ctx.extras.find(e=>{
    const owner=ctx.decks.find(d=>d.id===e.deck_id);
    const budget=category==='new'?e.new_extra:e.review_extra;
    return owner&&scopeOf(ctx.decks,owner).includes(card.deck_id)&&
      grantUsed(ctx,e.deck_id,category)+(reserved?.grants.get(grantKey(e.deck_id,category))??0)<budget;
  });
  return {allowed:!!grant,restart,caps,...(grant?{grant:grant.deck_id}:{})};
}
/** Live baseline usage excludes all recorded ordinary/restart extra answers, independent of the selected scope. */
function baseUsageSql(category:'new'|'review'):string {
  const state=category==='new'?0:2;
  return `(COALESCE((SELECT SUM(${category}) FROM (${dailyAnswersSql}) daily WHERE deck_id IN(SELECT value FROM json_each(?))),0)-
    (SELECT COUNT(*) FROM review_events WHERE undone=0 AND reviewed_at>=? AND reviewed_at<=?
      AND json_extract(before_state,'$.state')=${state} AND (ordinary_extra_deck_id IS NOT NULL OR restart_extra_deck_id IS NOT NULL)
      AND deck_id IN(SELECT value FROM json_each(?))))`;
}
function baseArgs(ctx:StudyContext,scope:string[]):(string|number)[] {
  return [ctx.boundary,ctx.now,ctx.boundary,ctx.now,JSON.stringify(scope),ctx.boundary,ctx.now,JSON.stringify(scope)];
}
/** Live quota/credit predicates execute inside the same guarded cards UPDATE that stores the actual answer. */
export function answerAdmission(ctx: StudyContext, card: StoredCard, selectedId?: string): { sql:string; args:(string|number)[]; member?:Member; restartId?:string; extraDeckId?:string; ordinaryExtraDeckId?:string } | null {
  const selected=ctx.decks.find(d=>d.id===(selectedId??card.deck_id));
  if(!selected||!scopeOf(ctx.decks,selected).includes(card.deck_id))return null;
  const member=activeMember(ctx,card);
  const strict=selectedId!==undefined||ctx.restarts.some(r=>!r.paused&&restartContains(ctx,r,card.deck_id));
  const allowance=cardAllowance(ctx,selected,card);
  const predicates=['(SELECT revision FROM study_generation WHERE id=1)=?'];
  const args:(string|number)[]=[ctx.generation];
  if(member){predicates.push('?<=?');args.push(member.available_at,ctx.now);}
  if(strict&&(card.state===0||card.state===2)) {
    predicates.push('?=1');args.push(allowance.allowed?1:0);
    const category=card.state===0?'new':'review';
    if(allowance.grant) {
      const column=category==='new'?'new_extra':'review_extra';
      predicates.push(`COALESCE((SELECT ${column} FROM study_extras WHERE deck_id=? AND study_day=?),0)>
        (SELECT COUNT(*) FROM review_events WHERE COALESCE(ordinary_extra_deck_id,restart_extra_deck_id)=?
          AND json_extract(before_state,'$.state')=? AND reviewed_at>=? AND reviewed_at<=? AND undone=0)`);
      args.push(allowance.grant,ctx.boundary,allowance.grant,card.state,ctx.boundary,ctx.now);
    } else {
      for(const cap of allowance.caps){predicates.push(baseUsageSql(category)+'<?');args.push(...baseArgs(ctx,cap.scope),cap[category]);}
      if(allowance.restart) {
        predicates.push(baseUsageSql(category)+'<?');args.push(...baseArgs(ctx,parse(allowance.restart.scope)),category==='new'?allowance.restart.daily_new_limit:allowance.restart.daily_review_limit);
        if(member?.backlog) {
          predicates.push(`(SELECT COUNT(*) FROM review_events WHERE restart_id=? AND restart_backlog=1
            AND restart_extra_deck_id IS NULL AND ordinary_extra_deck_id IS NULL AND reviewed_at>=? AND reviewed_at<=? AND undone=0)<?`);
          args.push(allowance.restart.id,ctx.boundary,ctx.now,allowance.restart.backlog_per_day);
        }
      }
    }
  }
  const grant=strict?allowance.grant:undefined;
  return {sql:predicates.join(' AND '),args,member,restartId:allowance.restart?.id,
    extraDeckId:allowance.restart?grant:undefined,ordinaryExtraDeckId:allowance.restart?undefined:grant};
}

export async function restartStatus(ctx: StudyContext, restart: RestartRow, detailed=true): Promise<RestartStatus> {
  const owner=ctx.decks.find(d=>d.id===restart.deck_id);
  const validIds=owner?scopeOf(ctx.decks,owner):[];
  const from=`FROM study_restart_members m JOIN cards c ON c.id=m.card_id
    WHERE m.restart_id=? AND m.answered_event_id IS NULL AND m.revision=c.revision AND c.queue=2 AND c.state=2
    AND c.deck_id IN(SELECT value FROM json_each(?))`;
  const args=[restart.id,JSON.stringify(validIds)];
  if(!detailed) {
    const counts=await ctx.db.prepare(`SELECT COALESCE(SUM(m.backlog),0) AS remaining,
      COALESCE(SUM(m.backlog=1 AND m.available_at<=?),0) AS available ${from}`).bind(ctx.now,...args).first<{remaining:number;available:number}>();
    const extraLeft=remainingRestartExtra(ctx,restart);
    const totalLeft=Math.max(0,restart.daily_review_limit-baseUsed(ctx,parse(restart.scope),'review'))+extraLeft;
    const usedToday=backlogUsed(ctx,restart.id)-ctx.creditEvents.filter(e=>e.restart_id===restart.id&&e.backlog).length;
    return {id:restart.id,revision:restart.revision,dailyReviewLimit:restart.daily_review_limit,dailyNewLimit:restart.daily_new_limit,
      backlogPerDay:restart.backlog_per_day,paused:!!restart.paused,flattened:!!restart.flattened,
      backlogTotal:restart.backlog_total,backlogRemaining:counts!.remaining,
      backlogToday:Math.min(totalLeft,Math.max(0,restart.backlog_per_day-usedToday)+extraLeft,counts!.available),days:[]};
  }
  const current=await ctx.db.prepare(`SELECT m.* ${from}`).bind(...args).all<Member>();
  const validMembers=current.results;
  const remaining=validMembers.filter(m=>m.backlog);
  const daily=new Map<string,number>();
  for(const m of validMembers) {
    const date=studyDate(Math.max(ctx.boundary,m.available_at),ctx.collection.timeZone,ctx.collection.dayStart);
    daily.set(date,(daily.get(date)??0)+1);
  }
  const usedToday=backlogUsed(ctx,restart.id);
  const extraLeft=remainingRestartExtra(ctx,restart);
  const totalLeft=Math.max(0,restart.daily_review_limit-baseUsed(ctx,parse(restart.scope),'review'))+extraLeft;
  const baseBacklogUsed=usedToday-ctx.creditEvents.filter(e=>e.restart_id===restart.id&&e.backlog).length;
  if(!restart.flattened) {
    daily.clear();
    let left=remaining.length,day=ctx.boundary;
    while(left>0) {
      const capacity=day===ctx.boundary?Math.min(totalLeft,Math.max(0,restart.backlog_per_day-baseBacklogUsed)+extraLeft):Math.min(restart.backlog_per_day,restart.daily_review_limit);
      const cards=Math.min(left,Math.max(0,capacity));
      if(cards)daily.set(studyDate(day,ctx.collection.timeZone,ctx.collection.dayStart),cards);
      left-=cards;day=nextStudyDayBoundary(day,ctx.collection.timeZone,ctx.collection.dayStart);
    }
  }
  return {id:restart.id,revision:restart.revision,dailyReviewLimit:restart.daily_review_limit,dailyNewLimit:restart.daily_new_limit,
    backlogPerDay:restart.backlog_per_day,paused:!!restart.paused,flattened:!!restart.flattened,
    backlogTotal:restart.backlog_total,backlogRemaining:remaining.length,
    backlogToday:Math.min(totalLeft,Math.max(0,restart.backlog_per_day-baseBacklogUsed)+extraLeft,remaining.filter(m=>m.available_at<=ctx.now).length),
    days:[...daily].sort(([a],[b])=>a.localeCompare(b)).map(([date,cards])=>({date,cards}))};
}
/** Lifecycle and status resolve the same current hierarchy; a multi-plan parent has no single control target. */
function displayedRestart(ctx:StudyContext,selectedId:string):RestartRow|null {
  const selected=ctx.decks.find(d=>d.id===selectedId);
  if(!selected)return null;
  const exact=ctx.restarts.find(r=>r.deck_id===selectedId);
  if(exact)return exact;
  const selectedScope=new Set(scopeOf(ctx.decks,selected));
  const matches=ctx.restarts.filter(r=>{
    const owner=ctx.decks.find(d=>d.id===r.deck_id);
    return owner&&scopeOf(ctx.decks,owner).some(id=>selectedScope.has(id)&&inScope(r.scope,id));
  });
  return matches.length===1?matches[0]:null;
}
export async function optionsResponse(ctx: StudyContext, selectedId: string, detailed=true): Promise<StudyOptionsResponse|null> {
  const selected=ctx.decks.find(d=>d.id===selectedId);
  if(!selected)return null;
  const scope=scopeOf(ctx.decks,selected);
  // Reuse the SQL aggregate already captured by studyContext, before quota caps.
  // Neither a dialog nor a per-card live summary needs another scope scan just to count.
  const available=ctx.totals.filter(t=>scope.includes(t.deck_id)).reduce((n,t)=>({new:n.new+t.new,review:n.review+t.review}),{new:0,review:0});
  const restart=displayedRestart(ctx,selectedId);
  const grants=ctx.extras.filter(e=>{
    const owner=ctx.decks.find(d=>d.id===e.deck_id);
    return owner&&(selected.name===owner.name||selected.name.startsWith(owner.name+'::'));
  });
  return {deckId:selectedId,studyDay:studyDate(ctx.now,ctx.collection.timeZone,ctx.collection.dayStart),
    limits:{new:restart&&!restart.paused?restart.daily_new_limit+restartExtra(ctx,restart,'new'):selected.config.newPerDay,
      review:restart&&!restart.paused?restart.daily_review_limit+restartExtra(ctx,restart):selected.config.reviewPerDay??9999},
    available,
    extra:{new:grants.reduce((n,e)=>n+e.new_extra,0),review:grants.reduce((n,e)=>n+e.review_extra,0)},
    restart:restart?await restartStatus(ctx,restart,detailed):null};
}

const candidateColumns=`SELECT id,note_id,deck_id,ordinal,queue,due,state,schedule,revision,last_event_id,
  json_object('due',json_extract(original,'$.due'),'queue',json_extract(original,'$.queue'),
    'reps',json_extract(original,'$.reps'),'lastReview',json_extract(original,'$.lastReview')) AS original FROM cards`;
export async function preloadOverviewCandidates(ctx:StudyContext):Promise<void> {
  ctx.cards=(await ctx.db.prepare(`${candidateColumns} WHERE queue>=0`).all<StoredCard>()).results;
}

export async function studyCandidates(ctx: StudyContext, selectedId: string, focusIds?: string[]): Promise<{
  row:StoredCard|null; nextDue:number|null; counts:{new:number;review:number;learning:number;total:number};
  learningPending:number; nextLearningDue:number|null; candidateIds:string[]; focusRemainingIds?:string[];
}|null> {
  const selected=ctx.decks.find(d=>d.id===selectedId);
  if(!selected)return null;
  const eligibility=scopeOf(ctx.decks,selected).map(id=>({id}));
  // Only overview explicitly installs an all-collection cache. A scoped/focused read
  // must never populate it, or a later parent/sibling would see incomplete candidates.
  const cards=ctx.cards??(await ctx.db.prepare(`${candidateColumns} WHERE queue>=0
    AND deck_id IN(SELECT value FROM json_each(?))${focusIds?' AND id IN(SELECT value FROM json_each(?))':''}`)
    .bind(JSON.stringify(eligibility.map(e=>e.id)),...(focusIds?[JSON.stringify(focusIds)]:[])).all<StoredCard>()).results;
  const byDeck=new Map(eligibility.map(e=>[e.id,e]));
  const nextBoundary=nextStudyDayBoundary(ctx.boundary,ctx.collection.timeZone,ctx.collection.dayStart);
  const focus=focusIds?new Set(focusIds):null;
  const inToday=(c:StoredCard)=>c.queue===0 || ((c.queue===1||c.queue===2||c.queue===3)&&c.due<=ctx.now) ||
    (intradayLearning(c)&&c.due<nextBoundary);
  const rows={results:cards.filter(c=>byDeck.has(c.deck_id)&&(!focus||(focus.has(c.id)&&inToday(c))))};
  const pending=rows.results.filter(c=>intradayLearning(c)&&c.due<nextBoundary).sort((a,b)=>a.due-b.due||a.id.localeCompare(b.id));
  const eligible=rows.results.filter(c=>{
    if(c.queue===0)return cardAllowance(ctx,selected,c).allowed;
    if(c.due>ctx.now)return false;
    if(c.queue===1||c.queue===3)return true;
    const m=activeMember(ctx,c);
    return c.queue===2&&cardAllowance(ctx,selected,c).allowed&&(!m||m.available_at<=ctx.now);
  });
  ctx.retrievabilities??=new Map();
  for(const deck of ctx.originalDecks) {
    const backlog=rows.results.filter(c=>c.deck_id===deck.id&&activeMember(ctx,c)?.backlog&&!ctx.retrievabilities!.has(c.id));
    const values=retrievabilities(backlog.map(c=>parse<ScheduleState>(c.schedule)),ctx.now,schedulerConfig(deck,ctx.collection));
    backlog.forEach((c,i)=>ctx.retrievabilities!.set(c.id,values[i]));
  }
  const priority=(c:StoredCard)=>c.queue===1||c.queue===3?0:c.queue===0?
    (ctx.restarts.some(r=>!r.paused&&restartContains(ctx,r,c.deck_id))?1:4):activeMember(ctx,c)?.backlog?3:2;
  eligible.sort((a,b)=>{
    const diff=priority(a)-priority(b);
    if(diff)return diff;
    if(priority(a)===3) {
      const r=(ctx.retrievabilities!.get(b.id)??0)-(ctx.retrievabilities!.get(a.id)??0);
      if(r)return r;
    }
    return (a.queue===0?parse<{due:number}>(a.original).due:a.due)-(b.queue===0?parse<{due:number}>(b.original).due:b.due)||a.id.localeCompare(b.id);
  });
  const reservations:Reservations={base:new Map(),restart:new Map(),backlog:new Map(),grants:new Map()};
  const counts={new:0,review:0,learning:pending.filter(c=>c.due>ctx.now).length,total:focus?rows.results.length:selected.counts.total};
  const admitted:StoredCard[]=[];
  for(const c of eligible) {
    if(c.queue===1||c.queue===3){counts.learning++;admitted.push(c);continue;}
    const category=c.queue===0?'new':'review';
    const allowance=cardAllowance(ctx,selected,c,reservations);
    if(!allowance.allowed)continue;
    admitted.push(c);
    counts[category]++;
    if(allowance.grant) {
      const key=grantKey(allowance.grant,category);
      reservations.grants.set(key,(reservations.grants.get(key)??0)+1);
    } else {
      for(const cap of allowance.caps){const key=capKey(cap,category);reservations.base.set(key,(reservations.base.get(key)??0)+1);}
      if(allowance.restart) {
        const id=allowance.restart.id;
        const key=grantKey(id,category);reservations.restart.set(key,(reservations.restart.get(key)??0)+1);
        if(activeMember(ctx,c)?.backlog)reservations.backlog.set(id,(reservations.backlog.get(id)??0)+1);
      }
    }
  }
  const next=rows.results.filter(c=>c.queue!==0).map(c=>Math.max(c.due,activeMember(ctx,c)?.available_at??0)).filter(d=>d>ctx.now);
  const futureLearning=pending.filter(c=>c.due>ctx.now);
  // Learn ahead only after every other eligible card in the selected scope is exhausted.
  const row=admitted[0]??futureLearning.find(c=>c.due<=ctx.now+20*60*1000)??null;
  const candidateIds=[...admitted,...futureLearning].slice(0,10).map(c=>c.id);
  return {row,nextDue:next.length?Math.min(...next):null,counts,learningPending:pending.length,
    nextLearningDue:futureLearning[0]?.due??null,candidateIds,
    ...(focus?{focusRemainingIds:focusIds!.filter(id=>rows.results.some(c=>c.id===id))}:{})};
}

async function createPreview(ctx: StudyContext, selectedId:string, dailyReviewLimit:number, backlogPerDay:number, flatten:boolean, dailyNewLimit=0):Promise<RestartPreview|null> {
  const selected=ctx.decks.find(d=>d.id===selectedId);if(!selected)return null;
  const scope=scopeOf(ctx.decks,selected);
  const rows=await ctx.db.prepare('SELECT * FROM cards WHERE queue=2 AND state=2 AND deck_id IN(SELECT value FROM json_each(?))').bind(JSON.stringify(scope)).all<StoredCard>();
  const assignments:Assignment[]=[];
  const candidates=rows.results.filter(c=>flatten||c.due<=ctx.now).map(c=>({c,s:parse<ScheduleState>(c.schedule)}));
  const backlog=candidates.filter(x=>x.c.due<=ctx.now).sort((a,b)=>a.s.stability-b.s.stability||a.c.due-b.c.due||a.c.id.localeCompare(b.c.id));
  const future=candidates.filter(x=>x.c.due>ctx.now).sort((a,b)=>a.c.due-b.c.due||a.s.stability-b.s.stability);
  const pending:typeof candidates=[];
  let day=ctx.boundary,backlogIndex=0,futureIndex=0;
  const summaries:{date:string;cards:number}[]=[];
  let delayedCards=0,maxDelayDays=0;
  while(backlogIndex<backlog.length||futureIndex<future.length||pending.length) {
    const next=nextStudyDayBoundary(day,ctx.collection.timeZone,ctx.collection.dayStart);
    while(futureIndex<future.length&&future[futureIndex].c.due<next)pending.push(future[futureIndex++]);
    const availableBacklog=backlog.slice(backlogIndex,backlogIndex+backlogPerDay);
    const available=[...pending,...availableBacklog].sort((a,b)=>a.s.stability-b.s.stability||a.c.due-b.c.due||a.c.id.localeCompare(b.c.id));
    const remainingCapacity=day===ctx.boundary?Math.max(0,dailyReviewLimit-baseUsed(ctx,scope,'review')):dailyReviewLimit;
    const admitted=available.slice(0,remainingCapacity);
    let takenBacklog=0;
    for(const item of admitted) {
      const isBacklog=item.c.due<=ctx.now;
      if(isBacklog)takenBacklog++;
      else pending.splice(pending.indexOf(item),1);
      const availableAt=flatten?Math.max(day,isBacklog?ctx.boundary:item.c.due):ctx.boundary;
      assignments.push({cardId:item.c.id,revision:item.c.revision,due:item.c.due,availableAt,backlog:isBacklog?1:0});
      const originalDate=studyDate(Math.max(ctx.boundary,item.c.due),ctx.collection.timeZone,ctx.collection.dayStart);
      const assignedDate=studyDate(availableAt,ctx.collection.timeZone,ctx.collection.dayStart);
      const delay=Math.round((Date.parse(assignedDate)-Date.parse(originalDate))/86400000);
      if(delay>0){delayedCards++;maxDelayDays=Math.max(maxDelayDays,delay);}
    }
    backlogIndex+=takenBacklog;
    if(admitted.length)summaries.push({date:studyDate(day,ctx.collection.timeZone,ctx.collection.dayStart),cards:admitted.length});
    day=next;
    // Skip empty spans without losing the local rollover calendar.
    if(!pending.length&&backlogIndex===backlog.length&&futureIndex<future.length)
      day=Math.max(day,studyDayBoundary(future[futureIndex].c.due,ctx.collection.timeZone,ctx.collection.dayStart));
  }
  const token=crypto.randomUUID();
  const summary:RestartPreview={token,days:summaries,total:assignments.length,delayedCards,maxDelayDays};
  await ctx.db.prepare(`INSERT INTO study_previews(token,deck_id,generation,study_day,daily_review_limit,daily_new_limit,backlog_per_day,flattened,scope,assignments,summary)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(token,selectedId,ctx.generation,ctx.boundary,dailyReviewLimit,dailyNewLimit,backlogPerDay,flatten?1:0,
      JSON.stringify(scope),JSON.stringify(assignments),JSON.stringify(summary)).run();
  return summary;
}

const routes=new Hono<ManagementEnv>();
routes.use('*',async(c,next)=>{if(c.get('actor')!=='session')return c.json({error:'この操作にはログインが必要です。'},403);await next();});
routes.get('/:deck',async c=>{
  const ctx=await studyContext(c.env.DB,Date.now());
  const result=ctx?await optionsResponse(ctx,c.req.param('deck')):null;
  return result?c.json(result):c.json({error:'デッキが見つかりません。'},404);
});
async function receipt(db:D1Database,id:string,operation:string,payload:string) {
  const prior=await db.prepare('SELECT * FROM study_receipts WHERE id=?').bind(id).first<{operation:string;payload:string;result:string}>();
  return prior?{conflict:prior.operation!==operation||prior.payload!==payload,result:parse(prior.result)}:null;
}
routes.post('/:deck/extra',async c=>{
  const b=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
  if(!b||!requestId(b.requestId)||!limit(b.new)||!limit(b.review)||(b.new===0&&b.review===0))return c.json({error:'追加枚数が不正です。'},400);
  const deckId=c.req.param('deck'),payload=JSON.stringify({deckId,new:b.new,review:b.review});
  const prior=await receipt(c.env.DB,b.requestId,'extra',payload);
  if(prior)return prior.conflict?c.json({error:'操作IDが別の操作に使用されています。'},409):c.json(prior.result);
  const ctx=await studyContext(c.env.DB,Date.now());
  if(!ctx||!ctx.decks.some(d=>d.id===deckId))return c.json({error:'デッキが見つかりません。'},404);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO study_receipts(id,operation,payload,result) VALUES(?,'extra',?,'{"ok":true}')`).bind(b.requestId,payload),
    c.env.DB.prepare(`INSERT INTO study_extras(deck_id,study_day,new_extra,review_extra)
      SELECT ?,?,?,? WHERE changes()=1 ON CONFLICT(deck_id,study_day) DO UPDATE SET
      new_extra=new_extra+excluded.new_extra,review_extra=review_extra+excluded.review_extra`).bind(deckId,ctx.boundary,b.new,b.review),
    // A review grant can accelerate genuinely overdue backlog, never an FSRS future review.
    c.env.DB.prepare(`UPDATE study_restart_members SET available_at=? WHERE (restart_id,card_id) IN (
      SELECT m.restart_id,m.card_id FROM study_restart_members m JOIN study_restarts r ON r.id=m.restart_id
      JOIN cards card ON card.id=m.card_id WHERE r.cancelled=0 AND r.paused=0 AND m.backlog=1
      AND m.answered_event_id IS NULL AND card.revision=m.revision AND card.queue=2 AND card.state=2
      AND card.due<=? AND m.available_at>? AND card.deck_id IN(SELECT value FROM json_each(?))
      AND changes()=1 ORDER BY m.available_at,json_extract(card.schedule,'$.stability'),m.card_id LIMIT ?
    )`).bind(ctx.boundary,ctx.now,ctx.now,JSON.stringify(scopeOf(ctx.decks,ctx.decks.find(d=>d.id===deckId)!)),b.review),
  ]);
  const saved=await receipt(c.env.DB,b.requestId,'extra',payload);
  return saved?.conflict?c.json({error:'操作IDが別の操作に使用されています。'},409):c.json(saved!.result);
});
routes.post('/:deck/restart/preview',async c=>{
  const b=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
  if(!b||!positive(b.dailyReviewLimit)||!positive(b.backlogPerDay)||!newLimit(b.dailyNewLimit??0)||typeof b.flatten!=='boolean')return c.json({error:'再開設定が不正です。'},400);
  const ctx=await studyContext(c.env.DB,Date.now());
  const result=ctx?await createPreview(ctx,c.req.param('deck'),b.dailyReviewLimit,b.backlogPerDay,b.flatten,Number(b.dailyNewLimit??0)):null;
  return result?c.json(result):c.json({error:'デッキが見つかりません。'},404);
});
routes.post('/:deck/restart',async c=>{
  const b=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
  if(!b||!requestId(b.requestId)||!positive(b.dailyReviewLimit)||!positive(b.backlogPerDay)||!newLimit(b.dailyNewLimit??0)||typeof b.flatten!=='boolean'||
    (b.flatten&&typeof b.previewToken!=='string'))return c.json({error:'再開設定が不正です。'},400);
  const deckId=c.req.param('deck'),payload=JSON.stringify({deckId,dailyReviewLimit:b.dailyReviewLimit,...(b.dailyNewLimit!==undefined?{dailyNewLimit:b.dailyNewLimit}:{}),backlogPerDay:b.backlogPerDay,flatten:b.flatten,previewToken:b.previewToken??null});
  const prior=await receipt(c.env.DB,b.requestId,'restart',payload);
  if(prior)return prior.conflict?c.json({error:'操作IDが別の操作に使用されています。'},409):c.json(prior.result);
  const ctx=await studyContext(c.env.DB,Date.now());
  if(!ctx)return c.json({error:'デッキが見つかりません。'},404);
  let token=b.previewToken;
  if(!b.flatten)token=(await createPreview(ctx,deckId,b.dailyReviewLimit,b.backlogPerDay,false,Number(b.dailyNewLimit??0)))?.token;
  const plan=typeof token==='string'?await c.env.DB.prepare('SELECT * FROM study_previews WHERE token=?').bind(token).first<PreviewRow>():null;
  if(!plan||plan.deck_id!==deckId||plan.daily_review_limit!==b.dailyReviewLimit||plan.daily_new_limit!==(b.dailyNewLimit??0)||plan.backlog_per_day!==b.backlogPerDay||plan.flattened!==Number(b.flatten)||
    plan.generation!==ctx.generation||plan.study_day!==ctx.boundary)return c.json({error:'プレビュー後にカードが更新されました。再計算してください。'},409);
  const id=crypto.randomUUID(),assignments=parse<Assignment[]>(plan.assignments);
  const initialStatus:RestartStatus={id,revision:0,dailyReviewLimit:b.dailyReviewLimit,dailyNewLimit:Number(b.dailyNewLimit??0),backlogPerDay:b.backlogPerDay,
    paused:false,flattened:b.flatten,backlogTotal:assignments.filter(a=>a.backlog).length,
    backlogRemaining:assignments.filter(a=>a.backlog).length,
    backlogToday:Math.min(b.backlogPerDay,assignments.filter(a=>a.backlog&&a.availableAt<=ctx.now).length),
    days:parse<RestartPreview>(plan.summary).days};
  const saved=await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO study_restarts(id,deck_id,scope,daily_review_limit,daily_new_limit,backlog_per_day,flattened,created_at,backlog_total)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT revision FROM study_generation WHERE id=1)=?
      AND NOT EXISTS(SELECT 1 FROM study_restarts r,json_each(r.scope) a,json_each(?) b WHERE r.cancelled=0 AND a.value=b.value)
      AND NOT EXISTS(SELECT 1 FROM study_receipts WHERE id=?)`).bind(id,deckId,plan.scope,b.dailyReviewLimit,b.dailyNewLimit??0,b.backlogPerDay,Number(b.flatten),ctx.now,
        assignments.filter(a=>a.backlog).length,plan.generation,plan.scope,b.requestId),
    c.env.DB.prepare(`INSERT INTO study_restart_members(restart_id,card_id,revision,original_due,available_at,backlog)
      SELECT ?,json_extract(value,'$.cardId'),json_extract(value,'$.revision'),json_extract(value,'$.due'),json_extract(value,'$.availableAt'),json_extract(value,'$.backlog')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM study_restarts WHERE id=?)`).bind(id,plan.assignments,id),
    c.env.DB.prepare(`INSERT OR IGNORE INTO study_receipts(id,operation,payload,result)
      SELECT ?,'restart',?,? WHERE EXISTS(SELECT 1 FROM study_restarts WHERE id=?)`).bind(b.requestId,payload,JSON.stringify(initialStatus),id),
  ]);
  if(!saved[0].meta.changes) {
    const retry=await receipt(c.env.DB,b.requestId,'restart',payload);
    return retry&&!retry.conflict?c.json(retry.result):c.json({error:'プレビューが古いか、範囲が重なる再開計画があります。'},409);
  }
  return c.json(initialStatus);
});
routes.post('/:deck/restart/state',async c=>{
  const b=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
  if(!b||!requestId(b.requestId)||!requestId(b.restartId)||!Number.isInteger(b.revision)||!['pause','resume','cancel','set-new-limit'].includes(String(b.action))||(b.action==='set-new-limit'&&!newLimit(b.dailyNewLimit)))return c.json({error:'再開操作が不正です。'},400);
  const deckId=c.req.param('deck'),payload=JSON.stringify({deckId,restartId:b.restartId,revision:b.revision,action:b.action,...(b.action==='set-new-limit'?{dailyNewLimit:b.dailyNewLimit}:{})});
  const prior=await receipt(c.env.DB,b.requestId,'state',payload);
  if(prior)return prior.conflict?c.json({error:'操作IDが別の操作に使用されています。'},409):c.json(prior.result);
  const ctx=await studyContext(c.env.DB,Date.now());
  const restart=ctx?displayedRestart(ctx,deckId):null;
  if(!ctx||!restart)return c.json({error:'再開計画が見つかりません。'},404);
  if(restart.id!==b.restartId)return c.json({error:'再開計画が更新されました。読み直してください。'},409);
  const status=b.action==='cancel'?null:{...await restartStatus(ctx,restart),revision:restart.revision+1,paused:b.action==='set-new-limit'?!!restart.paused:b.action==='pause',dailyNewLimit:b.action==='set-new-limit'?Number(b.dailyNewLimit):restart.daily_new_limit};
  const results=await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE study_restarts SET paused=?,cancelled=?,daily_new_limit=?,revision=revision+1 WHERE id=? AND revision=? AND cancelled=0
      AND NOT EXISTS(SELECT 1 FROM study_receipts WHERE id=?)`).bind(b.action==='set-new-limit'?restart.paused:b.action==='pause'?1:0,b.action==='cancel'?1:0,b.action==='set-new-limit'?b.dailyNewLimit:restart.daily_new_limit,restart.id,Number(b.revision),b.requestId),
    c.env.DB.prepare(`INSERT OR IGNORE INTO study_receipts(id,operation,payload,result)
      SELECT ?,'state',?,? WHERE changes()=1`).bind(b.requestId,payload,JSON.stringify(status)),
  ]);
  if(!results[0].meta.changes) {
    const retry=await receipt(c.env.DB,b.requestId,'state',payload);
    return retry&&!retry.conflict?c.json(retry.result):c.json({error:'別の画面で更新されました。読み直してください。'},409);
  }
  return c.json(status);
});
export default routes;
