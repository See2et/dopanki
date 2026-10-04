import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixture';
import { initialSchedule } from '../../src/lib/import';
import type { DeckSummary } from '../../src/lib/types';

const BASE = process.env.DOPANKI_URL || 'http://127.0.0.1:5173';
async function setup(page: Page, multipleDecks = false) {
  const f = fixture(); const schedule = initialSchedule(f.cards[0], f.decks[0]);
  const counts = {new: 0, learning: 0, review: 0, total: 2};
  const decks: DeckSummary[] = [{...f.decks[0],parentId:null,depth:0,label:'韓国語',counts,ownCounts:counts,answeredToday:0,ownAnsweredToday:0}];
  if (multipleDecks) decks.push({...decks[0],id:'2',name:'韓国語::第3課',parentId:'1',depth:1,label:'第3課'});
  const cards = ['1','2'].map(id => ({id,revision:0,ordinal:0,schedule,deck:f.decks[0],note:f.notes[0],noteType:f.noteTypes[0],preview:{1:schedule,2:schedule,3:schedule,4:schedule}}));
  type Member = {card: typeof cards[number]; rating: number; eventId: string};
  type Session = {name: string; round: number; revision: number; members: Member[]; lastEventId: string|null};
  const sessions = new Map<string,Session>();
  let droppedReview = false; let droppedRound = false;
  const normalWrites: string[] = []; const reviews: string[] = []; const rounds: string[] = []; const undos: string[] = []; const deletions: string[] = [];
  let droppedDeletion = false;
  const practice = (id:string,s:Session) => ({id,name:s.name,round:s.round,revision:s.revision,position:s.members.filter(m=>m.rating).length,total:s.members.length,againCount:s.members.filter(m=>m.rating===1).length,lastEventId:s.lastEventId});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method()==='POST' ? route.request().postDataJSON() : null;
    const respond = (data: unknown, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if (path==='/api/session') return respond({authenticated:true,passwordRequired:false});
    if (path==='/api/overview') return respond({imported:true,decks,warnings:[]});
    if (path==='/api/progress') return respond(null);
    if (path==='/api/practice') {
      if (!body) return respond({sessions:[...sessions].map(([id,s])=>({...practice(id,s),order:'shuffle',deckIds:['1']}))});
      const id = `practice-session-${sessions.size+1}`;
      const s:Session={name:body.name,round:1,revision:0,members:cards.map(card=>({card,rating:0,eventId:''})),lastEventId:null};
      sessions.set(id,s);return respond({session:{...practice(id,s),order:body.order,deckIds:body.deckIds}});
    }
    if (path.endsWith('/delete')) {
      deletions.push(body.requestId);
      sessions.delete(path.split('/')[3]);
      if (!droppedDeletion) { droppedDeletion=true; return route.abort('failed'); }
      return respond({ok:true});
    }
    const match=path.match(/^\/api\/practice\/([^/]+)(?:\/(review|undo|round))?$/);
    if (match) {
      const id=match[1];const s=sessions.get(id);
      if (!s) return respond({error:'練習が見つかりません。'},404);
      if (!match[2]) return respond({card:s.members.find(m=>!m.rating)?.card??null,counts,answeredToday:0,nextDue:null,practice:practice(id,s)});
      if (match[2]==='review') {
        reviews.push(body.eventId);
        if (!droppedReview) {droppedReview=true;return route.abort('failed');}
        const member=s.members.find(m=>m.card.id===body.cardId)!;
        member.rating=body.rating;member.eventId=body.eventId;s.lastEventId=body.eventId;s.revision++;
        return respond({ok:true});
      }
      if (match[2]==='undo') {
        undos.push(body.eventId);
        const member=s.members.find(m=>m.eventId===body.eventId)!;
        member.rating=0;member.eventId='';s.lastEventId=null;s.revision++;
        return respond({ok:true});
      }
      rounds.push(body.requestId);
      if (!droppedRound) {droppedRound=true;return route.abort('failed');}
      s.members=(body.mode==='all'?cards:s.members.filter(m=>m.rating===1).map(m=>m.card)).map(card=>({card,rating:0,eventId:''}));
      s.round++;s.revision++;s.lastEventId=null;return respond({ok:true});
    }
    if (path==='/api/review'||path==='/api/undo') normalWrites.push(path);
    return respond({error:'APIが見つかりません'},404);
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(() => localStorage.setItem('dopanki_sound','off'));
  await page.goto(BASE);
  return {normalWrites,reviews,rounds,undos,deletions,removeScope:(id:string)=>sessions.delete(id)};
}
async function rate(page:Page,rating:number) {await page.locator('#reveal').click();await page.locator(`[data-rating="${rating}"]`).click();}
for (const width of [390,1280]) {
  test(`saved practice creation, retry, resume, undo and rounds at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const mock=await setup(page,width === 390);
    const sessionName = width === 390 ? '韓国語' : '次の韓国語テスト';
    await mkdir('.local/verification/practice',{recursive:true});
    await page.getByRole('button',{name:'範囲を作る'}).click();
    const name = page.locator('[name="name"]');
    if (width === 390) {
      await page.locator('[name="deck"][value="2"]').check();
      await expect(name).toHaveAttribute('placeholder','韓国語::第3課');
      await name.fill('自分の名前');
      await page.locator('[name="deck"][value="1"]').check();
      await expect(name).toHaveAttribute('placeholder','韓国語');
      await expect(name).toHaveValue('自分の名前');
      await page.locator('[name="deck"][value="1"]').uncheck();
      await expect(name).toHaveAttribute('placeholder','韓国語::第3課');
      await page.locator('[name="deck"][value="1"]').check();
      await name.fill('   ');
    } else {
      await name.fill(sessionName);
      await page.locator('[name="deck"][value="1"]').check();
    }
    await page.locator('[name="order"]').selectOption('shuffle');
    await page.screenshot({path:`.local/verification/practice/create-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'保存して始める'}).click();
    await expect(page.locator('.practice-mode')).toContainText('1周目 · 0 / 2枚');
    await page.screenshot({path:`.local/verification/practice/study-${width}.png`,fullPage:true});
    await rate(page,1);await expect(page.locator('.rating-help')).toContainText('再送');
    await expect(page.locator('.rating strong')).toHaveText(['','','','']);
    await page.locator('[data-rating="1"]').click();
    expect(mock.reviews[0]).toBe(mock.reviews[1]);
    await expect(page.locator('.practice-mode')).toContainText('1 / 2枚');
    await page.reload();await expect(page.locator('.practice-mode')).toContainText('1 / 2枚');
    await page.getByRole('button',{name:'取り消す',exact:true}).click();
    await expect(page.locator('.practice-mode')).toContainText('0 / 2枚');
    await expect(page.locator('#undo')).toBeDisabled();
    await rate(page,1);await expect(page.locator('.practice-mode')).toContainText('1 / 2枚');
    await page.getByRole('button',{name:'← デッキ一覧'}).click();
    await expect(page.locator('.practice-list')).toContainText(sessionName);
    await page.screenshot({path:`.local/verification/practice/home-${width}.png`,fullPage:true});
    await page.locator('[data-practice]').click();await rate(page,3);
    await expect(page.getByRole('heading',{name:'1周目の練習が完了しました'})).toBeVisible();
    await page.screenshot({path:`.local/verification/practice/complete-${width}.png`,fullPage:true});
    await page.locator('[data-round="again"]').click();await expect(page.locator('.error')).toContainText('同じ周回ボタン');
    await expect(page.locator('#undo')).toBeDisabled();
    await expect(page.locator('[data-round="again"]')).toBeEnabled();
    await page.screenshot({path:`.local/verification/practice/retry-${width}.png`,fullPage:true});
    await page.locator('[data-round="again"]').click();expect(mock.rounds[0]).toBe(mock.rounds[1]);
    await expect(page.locator('.practice-mode')).toContainText('2周目 · 0 / 1枚');
    await rate(page,3);await expect(page.locator('[data-round="again"]')).toBeDisabled();
    await page.locator('[data-round="all"]').click();await expect(page.locator('.practice-mode')).toContainText('3周目 · 0 / 2枚');
    expect(mock.normalWrites).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}


test('reopening an older practice cannot undo rewards belonging to a later answer',async({page})=>{
  const mock=await setup(page);
  async function create(name:string){
    await page.getByRole('button',{name:'範囲を作る'}).click();
    await page.locator('[name="name"]').fill(name);await page.locator('[name="deck"]').check();
    await page.getByRole('button',{name:'保存して始める'}).click();await page.locator('#reveal').waitFor();
  }
  await create('範囲A');await rate(page,3);await expect(page.locator('.rating-help')).toContainText('再送');
  await page.locator('[data-rating="3"]').click();await expect(page.locator('.practice-mode')).toContainText('1 / 2枚');
  await page.locator('#back').click();await create('範囲B');await rate(page,3);await expect(page.locator('.practice-mode')).toContainText('1 / 2枚');
  await page.locator('#back').click();
  const before=await page.evaluate(()=>({festival:sessionStorage.getItem('dopanki_festival'),medals:sessionStorage.getItem('dopanki_medals_session_v1')}));
  await page.locator('[data-practice="practice-session-1"]').click();
  await expect(page.locator('#undo')).toBeDisabled();
  await page.reload();await expect(page.locator('#undo')).toBeDisabled();
  expect(mock.undos).toEqual([]);
  expect(await page.evaluate(()=>({festival:sessionStorage.getItem('dopanki_festival'),medals:sessionStorage.getItem('dopanki_medals_session_v1')}))).toEqual(before);
  await page.locator('#back').click();await page.locator('[data-practice="practice-session-2"]').click();
  await expect(page.locator('#undo')).toBeEnabled();await page.locator('#undo').click();
  await expect(page.locator('.practice-mode')).toContainText('0 / 2枚');
  await expect(page.locator('#undo')).toBeDisabled();
  const after=await page.evaluate(()=>({festival:JSON.parse(sessionStorage.getItem('dopanki_festival')!),medals:JSON.parse(sessionStorage.getItem('dopanki_medals_session_v1')!)}));
  expect(after.festival.count).toBe(1);expect(after.festival.total).toBe(100);expect(after.medals.reviewCount).toBe(1);
});


test('an unavailable saved-scope response stays recoverable without disrupting home',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await setup(page);
  await page.route('**/api/practice',route=>route.fulfill({status:200,contentType:'application/json',body:'null'}));
  await page.reload();
  await expect(page.locator('#practice-home .error')).toContainText('読み込めませんでした');
  await expect(page.getByRole('heading',{name:'今日の復習'})).toBeVisible();
  await expect(page.locator('#create-practice')).toBeEnabled();
  await page.unroute('**/api/practice');
  await page.locator('#retry-practices').click();
  await expect(page.locator('#practice-home .error')).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('delete cancellation preserves the scope and a lost response retries the same deletion',async({page})=>{
  const mock=await setup(page);
  await page.locator('#create-practice').click();await page.locator('[name="deck"]').check();
  await page.getByRole('button',{name:'保存して始める'}).click();await page.locator('#reveal').waitFor();
  await page.locator('#back').click();
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-delete-practice]').click();
  expect(mock.deletions).toEqual([]);await expect(page.locator('[data-practice]')).toBeVisible();
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('練習履歴は残ります');await dialog.accept();});
  await page.locator('[data-delete-practice]').click();await expect(page.locator('#practice-home .error')).toContainText('再送');
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-delete-practice]').click();
  await expect(page.locator('[data-practice]')).toHaveCount(0);expect(mock.deletions[0]).toBe(mock.deletions[1]);
  await page.reload();await expect(page.locator('[data-practice]')).toHaveCount(0);
});


test('a scope deleted in another tab returns a stale study screen to home',async({page})=>{
  const mock=await setup(page);
  await page.locator('#create-practice').click();await page.locator('[name="deck"]').check();
  await page.getByRole('button',{name:'保存して始める'}).click();await page.locator('#reveal').waitFor();
  mock.removeScope('practice-session-1');
  await rate(page,3);
  await expect(page.getByRole('heading',{name:'今日の復習'})).toBeVisible();
  await expect(page.locator('main > .error')).toContainText('削除されたか');
  await expect(page.locator('[data-practice]')).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('dopanki_practice'))).toBeNull();
});
