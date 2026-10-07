import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixture';
import { initialSchedule } from '../../src/lib/import';
import type { StudyOptionsResponse, RestartStatus } from '../../src/lib/study-options-types';

const BASE = process.env.DOPANKI_URL || 'http://127.0.0.1:5173';
async function setup(page: Page, extraFailure?: 'html-success' | 'html-conflict' | 'json-conflict') {
  const f = fixture(); const schedule = initialSchedule(f.cards[0], f.decks[0]);
  const counts = {new:0,learning:0,review:0,total:10};
  const deck = {...f.decks[0],parentId:null,depth:0,label:'韓国語',counts,ownCounts:counts,answeredToday:2,ownAnsweredToday:2};
  const card = {id:'1',revision:0,ordinal:0,schedule,deck:f.decks[0],note:f.notes[0],noteType:f.noteTypes[0],preview:{1:schedule,2:schedule,3:schedule,4:schedule}};
  let currentCard: typeof card | null = null; let answeredToday = 2;
  const options: StudyOptionsResponse = {deckId:'1',studyDay:'2026-10-04',limits:{new:2,review:5},available:{new:2,review:8},extra:{new:0,review:0},restart:null};
  const extras: Record<string,unknown>[] = []; const reviews: Record<string,unknown>[] = []; const states: Record<string,unknown>[] = []; const starts: Record<string,unknown>[] = [];
  let lostExtra = true; let lostReview = true; let lostState = true; let stalePreview = true;
  const committedExtras = new Set<string>();
  let token = 'preview-1'; let previewCount = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    const respond = (data: unknown, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if (path === '/api/session') return respond({authenticated:true,passwordRequired:false});
    if (path === '/api/overview') return respond({imported:true,decks:[deck],warnings:[]});
    if (path === '/api/progress') return respond(null);
    if (path === '/api/practice') return respond({sessions:[]});
    if (path === '/api/study/1') return respond({card:currentCard,counts,answeredToday,nextDue:null});
    if (path === '/api/study-options/1') return respond(options);
    if (path.endsWith('/extra')) {
      extras.push(body);
      if (!committedExtras.has(body.requestId)) {options.extra.new += body.new; options.extra.review += body.review; options.limits.new += body.new; options.limits.review += body.review; committedExtras.add(body.requestId); currentCard=card;}
      if (lostExtra) {
        lostExtra=false;
        if (extraFailure === 'html-success') return route.fulfill({status:200,contentType:'text/html',body:'<html>Response unavailable</html>'});
        if (extraFailure === 'html-conflict') return route.fulfill({status:409,contentType:'text/html',body:'<html>Gateway conflict</html>'});
        if (extraFailure === 'json-conflict') return respond({message:'Gateway conflict'},409);
        return route.abort('failed');
      }
      return respond({ok:true});
    }
    if (path === '/api/review') {reviews.push(body);if (lostReview) {lostReview=false;return route.abort('failed');}currentCard=null;answeredToday++;return respond({ok:true});}
    if (path.endsWith('/restart/preview')) {previewCount++;token=`preview-${previewCount}`;return respond({token,total:10,delayedCards:body.flatten?7:0,maxDelayDays:body.flatten?3:0,days:[{date:'2026-10-04',cards:2},{date:'2026-10-05',cards:3},{date:'2026-10-06',cards:3},{date:'2026-10-07',cards:2}]});}
    if (path.endsWith('/restart')) {
      starts.push(body);
      if (stalePreview) {stalePreview=false;return respond({error:'配分をもう一度確認してください。'},409);}
      if (body.previewToken !== token) return respond({error:'古い配分です。'},409);
      options.restart = {id:'plan',revision:0,dailyReviewLimit:body.dailyReviewLimit,dailyNewLimit:body.dailyNewLimit??0,backlogPerDay:body.backlogPerDay,paused:false,flattened:body.flatten,backlogTotal:8,backlogRemaining:6,backlogToday:2,days:[{date:'2026-10-04',cards:2},{date:'2026-10-05',cards:3}]} satisfies RestartStatus;
      options.available={new:2,review:6};options.limits={new:body.dailyNewLimit??0,review:body.dailyReviewLimit};return respond({ok:true});
    }
    if (path.endsWith('/restart/state')) {
      states.push(body);
      if (body.restartId !== options.restart?.id) return respond({error:'再開モードが更新されました。'},409);
      if (lostState) {lostState=false;return route.abort('failed');}
      if (body.action === 'cancel') options.restart=null;
      else { if(body.action==='set-new-limit') {options.restart!.dailyNewLimit=body.dailyNewLimit;options.limits.new=body.dailyNewLimit;} else options.restart!.paused = body.action === 'pause';options.restart!.revision++;options.available.new=2; }
      return respond({ok:true});
    }
    return respond({error:'APIが見つかりません。'},404);
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(() => localStorage.setItem('dopanki_sound','off'));
  await page.goto(BASE);
  return {extras,reviews,states,starts,options,setAnswered:(n:number)=>{answeredToday=n;},setCard:(value:boolean)=>{currentCard=value?card:null;}};
}
for (const failure of ['html-success','html-conflict','json-conflict'] as const) {
  test(`committed extras with an unusable ${failure} response retain their identity after reopening`,async({page})=>{
    const mock=await setup(page,failure);
    await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
    await page.getByRole('spinbutton',{name:'新規の追加枚数'}).fill('3');
    await page.getByRole('button',{name:'新規を追加して学習'}).click();
    await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toHaveValue('3');
    await expect(page.getByRole('button',{name:'新規を追加して学習'})).toBeDisabled();
    expect(mock.options.extra.new).toBe(3);
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toHaveValue('3');
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeDisabled();
    await expect(page.getByRole('button',{name:'同じ内容で再送'})).toBeEnabled();
    expect(mock.extras).toHaveLength(1);
    await page.getByRole('button',{name:'同じ内容で再送'}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#reveal')).toBeVisible();
    expect(mock.extras).toHaveLength(2);
    expect(mock.extras[1]).toEqual(mock.extras[0]);
    expect(mock.extras[0]).toMatchObject({requestId:expect.any(String),new:3,review:0});
    expect(mock.options.extra.new).toBe(3);
    expect(mock.options.limits.new).toBe(5);
  });
}

test('an unresolved committed save can reload a failed reopened dialog without replaying the write',async({page})=>{
  const mock=await setup(page,'html-success');
  await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
  await page.getByRole('spinbutton',{name:'新規の追加枚数'}).fill('3');
  await page.getByRole('button',{name:'新規を追加して学習'}).click();
  await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.route('**/api/study-options/1',route=>route.abort('failed'));
  await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
  await expect(page.getByRole('dialog')).toContainText('学習状況を読み込めませんでした');
  const reload=page.getByRole('button',{name:'もう一度読み込む'});
  await expect(reload).toBeEnabled();
  expect(mock.extras).toHaveLength(1);
  await page.unroute('**/api/study-options/1');
  await reload.click();
  await expect(page.getByRole('button',{name:'同じ内容で再送'})).toBeEnabled();
  await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toHaveValue('3');
  for (const control of await page.locator('[data-content] input, [data-content] button:not([data-retry-save])').all()) await expect(control).toBeDisabled();
  expect(mock.extras).toHaveLength(1);
  await page.getByRole('button',{name:'同じ内容で再送'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#reveal')).toBeVisible();
  expect(mock.extras).toHaveLength(2);
  expect(mock.extras[1]).toEqual(mock.extras[0]);
  expect(mock.extras[0]).toMatchObject({requestId:expect.any(String),new:3,review:0});
  expect(mock.options.extra.new).toBe(3);
});

async function shot(page: Page, name: string) { await mkdir('.local/verification/study-options',{recursive:true});await page.screenshot({path:`.local/verification/study-options/${name}.png`,fullPage:true}); }
for (const width of [390,1280]) {
  test(`daily extras and review retries preserve requests and deck scope at ${width}px`,async({page}) => {
    await page.setViewportSize({width,height:900}); const mock = await setup(page);
    await page.locator('[data-deck="1"]').click();
    await expect(page.getByRole('heading',{name:'今日の目標を達成しました'})).toBeVisible();
    await expect(page.locator('.completion-options')).toContainText('期限を迎えた復習8枚');
    await shot(page,`complete-${width}`);
    await page.getByRole('button',{name:'新規を追加',exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('spinbutton',{name:'新規の追加枚数'}).fill('3');
    await page.getByRole('button',{name:'新規を追加して学習'}).click();
    await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toHaveValue('3');
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'新規を追加',exact:true}).click();
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toHaveValue('3');
    await page.getByRole('button',{name:'同じ内容で再送'}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('#reveal')).toBeVisible();
    expect(mock.extras[0]).toEqual(mock.extras[1]);expect(mock.extras[0].review).toBe(0);expect(mock.options.extra.new).toBe(3);
    await page.locator('#reveal').click();await page.locator('[data-rating="3"]').click();
    await expect(page.locator('.rating-help')).toContainText('再送');await page.locator('[data-rating="3"]').click();
    await expect(page.getByRole('heading',{name:'今日の目標を達成しました'})).toBeVisible();
    expect(mock.reviews[0]).toEqual(mock.reviews[1]);expect(mock.reviews[0].deckId).toBe('1');
    await page.getByRole('button',{name:'復習を追加',exact:true}).click();await page.getByRole('spinbutton',{name:'復習の追加枚数'}).fill('2');
    await page.getByRole('button',{name:'復習を追加して学習'}).click();await expect(page.locator('#reveal')).toBeVisible();
    expect(mock.extras[2].new).toBe(0);expect(mock.extras[2].review).toBe(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
  test(`restart preview, stale confirmation and lifecycle at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const mock=await setup(page);
    await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
    await page.getByRole('spinbutton',{name:'1日の復習目標'}).fill('6');
    await page.getByRole('spinbutton',{name:'たまった分の1日最大枚数'}).fill('3');
    await expect(page.getByRole('checkbox',{name:'出題日を日ごとの配分に合わせる'})).not.toBeChecked();
    await page.getByRole('checkbox',{name:'出題日を日ごとの配分に合わせる'}).check();
    await page.getByRole('button',{name:'配分を確認',exact:true}).click();
    await expect(page.locator('[data-preview]')).toContainText('最大 3日');
    await expect(page.locator('table')).toContainText('10月7日');await shot(page,`preview-${width}`);
    await page.getByRole('button',{name:'この配分で再開モードを開始'}).click();
    await expect(page.getByRole('alert')).toContainText('学習状況が変わりました');
    await expect(page.getByRole('spinbutton',{name:'1日の復習目標'})).toHaveValue('6');
    await expect(page.getByRole('checkbox')).toBeChecked();await expect(page.locator('[data-apply]')).toHaveCount(0);
    await page.getByRole('button',{name:'配分を確認',exact:true}).click();await page.getByRole('button',{name:'この配分で再開モードを開始'}).click();
    await expect(page.locator('.restart-status')).toContainText('再開モード · 継続中');
    expect(mock.starts[0].previewToken).not.toEqual(mock.starts[1].previewToken);expect(mock.starts[1].dailyNewLimit).toBe(5);
    await expect(page.getByRole('spinbutton',{name:'再開中の1日の新規枚数'})).toHaveValue('5');
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeEnabled();
    await expect(page.getByRole('button',{name:'新規を追加して学習'})).toBeEnabled();await shot(page,`active-${width}`);
    await page.getByRole('button',{name:'再開モードを一時停止'}).click();await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
    await page.getByRole('button',{name:'同じ内容で再送'}).click();
    await expect(page.locator('.restart-status')).toContainText('一時停止中');expect(mock.states[0]).toEqual(mock.states[1]);expect(mock.states[0].restartId).toBe('plan');
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeEnabled();
    await page.getByRole('button',{name:'再開モードを再開'}).click();await expect(page.locator('.restart-status')).toContainText('継続中');
    await page.getByRole('spinbutton',{name:'復習の追加枚数'}).fill('2');
    await page.getByRole('button',{name:'復習を追加して学習'}).click();
    await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
    await page.getByRole('button',{name:'同じ内容で再送'}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('#reveal')).toBeVisible();
    expect(mock.extras[0].new).toBe(0);expect(mock.extras[0].review).toBe(2);expect(mock.extras[0]).toEqual(mock.extras[1]);
    await page.getByRole('button',{name:'ペースを確認'}).click();
    await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeEnabled();
    await page.getByRole('button',{name:'閉じる',exact:true}).click();mock.setCard(false);await page.reload();
    await expect(page.getByRole('heading',{name:'今日の予定は完了です'})).toBeVisible();await expect(page.locator('#finale')).toContainText('残り6枚');await shot(page,`restart-complete-${width}`);
    await page.getByRole('button',{name:'ペースを確認'}).click();
    await page.getByRole('button',{name:'再開モードを終了',exact:true}).click();await page.getByRole('button',{name:'続ける',exact:true}).click();
    expect(mock.options.restart).not.toBeNull();
    await page.getByRole('button',{name:'再開モードを終了',exact:true}).click();await expect(page.locator('[data-cancel-confirm]')).toContainText('未回答のカードは通常の出題に戻ります');
    await page.getByRole('button',{name:'終了する',exact:true}).click();await expect(page.getByRole('button',{name:'配分を確認',exact:true})).toBeVisible();
    expect(mock.options.restart).toBeNull();expect(mock.states.map(state=>state.restartId)).toEqual(['plan','plan','plan','plan']);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

for (const width of [390,1280]) {
  test(`new pace can change without replacing Flatten and retries preserve the edit at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const mock=await setup(page);
    await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
    await expect(page.getByRole('spinbutton',{name:'1日の新規枚数'})).toHaveValue('5');
    await page.getByRole('checkbox').check();
    await page.getByRole('button',{name:'配分を確認',exact:true}).click();
    await page.getByRole('button',{name:'この配分で再開モードを開始'}).click();
    await expect(page.getByRole('alert')).toContainText('学習状況が変わりました');
    await page.getByRole('button',{name:'配分を確認',exact:true}).click();
    await page.getByRole('button',{name:'この配分で再開モードを開始'}).click();
    const days=structuredClone(mock.options.restart!.days);
    await page.getByRole('spinbutton',{name:'再開中の1日の新規枚数'}).fill('2');
    await page.getByRole('button',{name:'新規のペースを保存'}).click();
    await expect(page.getByRole('alert')).toContainText('保存を確認できませんでした');
    await expect(page.getByRole('spinbutton',{name:'再開中の1日の新規枚数'})).toHaveValue('2');
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'韓国語の学習量を調整'}).click();
    await expect(page.getByRole('spinbutton',{name:'再開中の1日の新規枚数'})).toHaveValue('2');
    await page.getByRole('button',{name:'同じ内容で再送'}).click();
    await expect(page.locator('.restart-status')).toContainText('新規は1日2枚');
    expect(mock.states[0]).toEqual(mock.states[1]);
    expect(mock.states[1]).toMatchObject({restartId:'plan',revision:0,action:'set-new-limit',dailyNewLimit:2});
    expect(mock.options.restart!.days).toEqual(days);expect(mock.starts).toHaveLength(2);
    await page.getByRole('spinbutton',{name:'再開中の1日の新規枚数'}).fill('0');
    await page.getByRole('button',{name:'新規のペースを保存'}).click();
    await expect(page.getByRole('dialog')).toContainText('新規の自動出題を休止しています');
    await expect(page.getByRole('button',{name:'新規を追加して学習'})).toBeEnabled();
    await shot(page,`new-pace-${width}`);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
test('empty and fresh decks do not falsely claim goal achievement; load failure is recoverable',async({page})=>{
  const mock=await setup(page);mock.options.available={new:0,review:0};mock.setAnswered(0);
  await page.locator('[data-deck="1"]').click();await expect(page.getByRole('heading',{name:'いま復習できるカードはありません'})).toBeVisible();
  await page.route('**/api/study-options/1',route=>route.abort('failed'));
  await page.getByRole('button',{name:'新規を追加',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('読み込めませんでした');
  await page.unroute('**/api/study-options/1');await page.getByRole('button',{name:'もう一度読み込む'}).click();await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeVisible();
  await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeDisabled();await expect(page.getByRole('spinbutton',{name:'復習の追加枚数'})).toBeDisabled();
});
