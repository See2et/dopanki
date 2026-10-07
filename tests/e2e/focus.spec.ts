import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { TestDb } from '../test-db';
import { fixture } from '../fixture';
import { importStatements } from '../../src/lib/import';
import { app } from '../../src/server/index';

// The real server and an isolated in-memory SQLite DB serve API calls; Vite serves the UI.
const BASE = process.env.DOPANKI_URL || 'http://127.0.0.1:5174';
const SHOTS = '.local/verification/focus';
async function setup(page: Page, options: { count?: number; step?: number } = {}) {
  const db = new TestDb();
  for (const migration of ['0001_initial','0003_authoring','0004_custom_practice','0005_practice_deletion','0006_study_options','0007_restart_new_limit']) db.sqlite.exec(readFileSync(`migrations/${migration}.sql`,'utf8'));
  const d = fixture();
  d.cards = Array.from({length:options.count ?? 13},(_,i)=>({...d.cards[0],id:String(i+1)}));
  if (options.step) d.decks[0].config.relearningSteps = [options.step];
  db.sqlite.exec(importStatements(d).join(';')+';');
  const answered: string[] = [];
  await page.route(`${BASE}/api/**`,async route => {
    const r = route.request();
    const response = await app.request(r.url(),{method:r.method(),headers:r.headers(),...(r.postData()?{body:r.postData()!}:{})},{DB:db as unknown as D1Database,MEDIA:{} as R2Bucket,ASSETS:{} as Fetcher});
    if (new URL(r.url()).pathname === '/api/review' && response.ok) answered.push(r.postDataJSON().cardId);
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>localStorage.setItem('dopanki_sound','off'));
  await page.goto(BASE);
  await page.locator('[data-deck="1"]').click();
  await expect(page.locator('#reveal')).toBeVisible();
  return {db,answered};
}
async function answer(page: Page, rating: number) {
  await page.locator('#reveal').click();
  await page.locator(`[data-rating="${rating}"]`).click();
  await expect(page.locator('[data-rating]')).toHaveCount(0);
  await expect(page.locator('#payoff')).toHaveCount(0);
}
test('ten-card batch repeats failures, reports results, survives reload/undo and ends with a short batch',async({page})=>{
  await mkdir(SHOTS,{recursive:true});
  const {db,answered} = await setup(page);
  try {
    await answer(page,1);
    for (let i=0;i<9;i++) await answer(page,3);
    expect(new Set(answered).size).toBe(10);
    await expect(page.locator('.focus-progress strong')).toHaveText('9 / 10枚');
    await expect(page.getByRole('heading',{name:'10枚の組を終えました'})).toHaveCount(0);
    await answer(page,3);
    expect(answered.at(-1)).toBe(answered[0]);
    await expect(page.getByRole('heading',{name:'10枚の組を終えました'})).toBeVisible();
    await expect(page.locator('.focus-result-stats dd')).toHaveText(['10枚','9枚','1枚']);
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({path:`${SHOTS}/desktop-result.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
    await page.screenshot({path:`${SHOTS}/mobile-result.png`,fullPage:true});
    await page.reload();
    await expect(page.getByRole('heading',{name:'10枚の組を終えました'})).toBeVisible();
    await page.getByRole('button',{name:'取り消す',exact:true}).click();
    await expect(page.locator('.focus-progress strong')).toHaveText('9 / 10枚');
    await answer(page,3);
    await page.getByRole('button',{name:'次の10枚へ'}).click();
    await expect(page.locator('.focus-progress strong')).toHaveText('0 / 3枚');
    await page.screenshot({path:`${SHOTS}/mobile-question.png`,fullPage:true});
    for(let i=0;i<3;i++) await answer(page,3);
    await expect(page.getByRole('heading',{name:'3枚の組を終えました'})).toBeVisible();
    await page.getByRole('button',{name:'次の10枚へ'}).click();
    await expect(page.getByText('いま取り組める次の組はありません。')).toBeVisible();
    // The mode switch moved from the always-visible band into the ⋯ menu.
    await page.getByRole('button',{name:'学習メニュー'}).click();
    await expect(page.getByRole('menuitemradio',{name:/10枚ずつ集中/})).toHaveAttribute('aria-checked','true');
    await page.getByRole('menuitemradio',{name:/連続モード/}).click();
    await expect(page.locator('.progress-mode')).toHaveText('連続モード');
    expect(await page.evaluate(()=>localStorage.getItem('dopanki_focus'))).toBe('off');
  } finally { db.sqlite.close(); }
});

test('long learning step shows waiting, refreshes automatically, and keeps the failed card in its batch',async({page})=>{
  await mkdir(SHOTS,{recursive:true});
  await page.clock.install();
  const {db} = await setup(page,{count:1,step:21});
  try {
    await answer(page,1);
    await expect(page.getByRole('heading',{name:'覚え直しの時間を待っています'})).toBeVisible();
    await expect(page.getByText('完了!',{exact:true})).toHaveCount(0);
    await expect(page.locator('.focus-progress strong')).toHaveText('0 / 1枚');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:`${SHOTS}/mobile-waiting.png`,fullPage:true});
    // Bring the persisted step inside learn-ahead, then let the screen's actual timer reload it.
    const due = Date.now()+10*60_000;
    const row = db.sqlite.prepare('SELECT schedule FROM cards WHERE id=1').get()!;
    const schedule = {...JSON.parse(String(row.schedule)),due};
    db.sqlite.prepare('UPDATE cards SET due=?,schedule=? WHERE id=1').run(due,JSON.stringify(schedule));
    await page.clock.fastForward(31_000);
    await expect(page.locator('#reveal')).toBeVisible();
    await answer(page,3);
    await expect(page.getByRole('heading',{name:'1枚の組を終えました'})).toBeVisible();
    await expect(page.locator('.focus-result-stats dd')).toHaveText(['1枚','0枚','1枚']);
  } finally { db.sqlite.close(); }
});
