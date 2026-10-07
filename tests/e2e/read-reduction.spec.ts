import { test,expect,type Page } from '@playwright/test';
import { readFileSync,readdirSync } from 'node:fs';
import { TestDb } from '../test-db';
import { fixture } from '../fixture';
import { importStatements } from '../../src/lib/import';
import { app } from '../../src/server/index';

const BASE=process.env.DOPANKI_URL||'http://127.0.0.1:5174';
async function setup(page:Page,options:{count?:number;focus?:boolean;motion?:boolean;holdHome?:boolean;password?:string;lateAuthFailure?:boolean}={}) {
  const db=new TestDb();
  for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.sqlite.exec(readFileSync(`migrations/${f}`,'utf8'));
  const d=fixture();d.reviews=[];d.cards=Array.from({length:options.count??2},(_,i)=>({...d.cards[0],id:String(i+1)}));
  db.sqlite.exec(importStatements(d).join(';')+';');
  const paths:string[]=[];const progressResponses:Record<string,unknown>[]=[];
  let releaseHome=()=>{};
  const homeGate=new Promise<void>(resolve=>{releaseHome=resolve;});
  let progressReads=0;
  const env={DB:db as unknown as D1Database,APP_PASSWORD:options.password,MEDIA:{} as R2Bucket,ASSETS:{} as Fetcher};
  if(options.password) {
    const login=await app.request(`${BASE}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:options.password})},env);
    const token=login.headers.get('Set-Cookie')!.split(';')[0].split('=').slice(1).join('=');
    await page.context().addCookies([{name:'dopanki_session',value:token,url:BASE,httpOnly:true,sameSite:'Strict'}]);
  }
  await page.route(`${BASE}/api/**`,async route=>{
    const r=route.request();const path=new URL(r.url()).pathname;paths.push(path);
    const response=await app.request(r.url(),{method:r.method(),headers:r.headers(),...(r.postData()?{body:r.postData()!}:{})},env);
    let body=await response.text();let status=response.status;
    if(path==='/api/progress')progressResponses.push(JSON.parse(body));
    if(path==='/api/progress'&&++progressReads===1&&options.holdHome) {
      await homeGate;
      if(options.lateAuthFailure){status=401;body=JSON.stringify({error:'expired old session'});}
    }
    await route.fulfill({status,headers:Object.fromEntries(response.headers),body});
  });
  await page.emulateMedia({reducedMotion:options.motion?'no-preference':'reduce'});
  await page.addInitScript(focus=>{localStorage.setItem('dopanki_sound','off');localStorage.setItem('dopanki_focus',focus?'on':'off');},options.focus??false);
  await page.goto(BASE);
  await expect(page.locator('[data-deck="1"]')).toBeVisible();
  const counts=()=>({progress:paths.filter(p=>p==='/api/progress').length,options:paths.filter(p=>p==='/api/study-options/1').length});
  return {db,paths,counts,releaseHome,progressResponses};
}
async function rate(page:Page,rating=3) {await expect(page.locator('#reveal')).toBeVisible();await page.locator('#reveal').click();await page.locator(`[data-rating="${rating}"]`).click();}

test('home and completion alone demand progress; card reloads reuse lightweight status, and dialogs fetch detailed options on demand',async({page})=>{
  const s=await setup(page);
  try {
    await expect(page.locator('.calendar-stats')).toContainText('累計の学習日0日');
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.locator('[data-deck="1"]').click();await expect(page.locator('#reveal')).toBeVisible();
    expect(s.counts()).toEqual({progress:1,options:0});
    await rate(page);await expect(page.locator('#reveal')).toBeVisible();
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.getByRole('button',{name:'学習メニュー'}).click();
    await page.getByRole('menuitem',{name:/今日の学習量・再開ペース/}).click();
    await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('spinbutton',{name:'新規の追加枚数'})).toBeVisible();
    expect(s.counts()).toEqual({progress:1,options:1});
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    await rate(page);await expect(page.locator('#finale')).toBeVisible();
    await expect(page.locator('.tomorrow-result')).toContainText('2枚減りました');
    expect(s.progressResponses.at(-1)).toMatchObject({totalStudyDays:1,todayAnswers:2});
    expect(s.counts()).toEqual({progress:2,options:1});
    await page.getByRole('button',{name:'取り消す',exact:true}).click();await expect(page.locator('#reveal')).toBeVisible();
    expect(s.counts()).toEqual({progress:2,options:1});
    await page.getByRole('button',{name:'← デッキ一覧'}).click();
    await expect(page.locator('.calendar-stats')).toContainText('累計の学習日1日');
    expect(s.counts()).toEqual({progress:3,options:1});
    // A restored selection is invisible to progress, even though refresh() loads overview first.
    await page.reload();await expect(page.locator('#reveal')).toBeVisible();
    expect(s.counts()).toEqual({progress:3,options:1});
  } finally {s.db.sqlite.close();}
});

test('a late home response cannot overwrite completion, and the visible reward stage performs no aggregate reads',async({page})=>{
  const s=await setup(page,{count:1,motion:true,holdHome:true});
  try {
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.locator('[data-deck="1"]').click();await rate(page);
    await expect(page.locator('#skip-payoff')).toBeVisible();
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.locator('#skip-payoff').click();await expect(page.locator('#finale')).toBeVisible();
    await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
    expect(s.counts()).toEqual({progress:2,options:0});
    const oldResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/progress');
    s.releaseHome();await oldResponse;
    await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
    // Revealing/menus/summary rerenders cannot duplicate an already-satisfied visible demand.
    await page.getByRole('button',{name:'学習メニュー'}).click();
    await page.keyboard.press('Escape');
    expect(s.counts()).toEqual({progress:2,options:0});
  } finally {s.releaseHome();s.db.sqlite.close();}
});

test('logout/login resets demand and ignores an obsolete unauthorized progress response',async({page})=>{
  const s=await setup(page,{password:'test-password',holdHome:true,lateAuthFailure:true});
  try {
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.getByRole('button',{name:'ログアウト',exact:true}).click();
    await expect(page.locator('#login-form')).toBeVisible();expect(s.counts().progress).toBe(1);
    await page.locator('#password').fill('test-password');
    await page.getByRole('button',{name:'ログイン',exact:true}).click();
    await expect(page.locator('.calendar-stats')).toContainText('累計の学習日0日');
    expect(s.counts().progress).toBe(2);
    const old=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/progress'&&r.status()===401);
    s.releaseHome();await old;
    await page.locator('[data-deck="1"]').click();await expect(page.locator('#reveal')).toBeVisible();
    await expect(page.locator('#reauthenticate')).toHaveCount(0);expect(s.counts()).toEqual({progress:2,options:0});
  } finally{s.releaseHome();s.db.sqlite.close();}
});

test('focused batches perform neither invisible progress nor options reads; practice fetches fresh progress only at completion',async({page})=>{
  const s=await setup(page,{count:1,focus:true});
  try {
    await expect(page.locator('.calendar-stats')).toContainText('累計の学習日0日');
    await page.locator('[data-deck="1"]').click();await rate(page);
    await expect(page.getByRole('heading',{name:'1枚の組を終えました'})).toBeVisible();
    expect(s.counts()).toEqual({progress:1,options:0});
    await page.getByRole('button',{name:'休憩する',exact:true}).click();
    await expect(page.locator('.calendar-stats')).toContainText('累計の学習日1日');
    expect(s.counts()).toEqual({progress:2,options:0});
    await page.getByRole('button',{name:'範囲を作る'}).click();
    await page.locator('[name="deck"][value="1"]').check();
    await page.getByRole('button',{name:'保存して始める'}).click();
    await expect(page.locator('#reveal')).toBeVisible();expect(s.counts()).toEqual({progress:2,options:0});
    await rate(page);await expect(page.locator('#finale')).toBeVisible();
    await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
    expect(s.progressResponses.at(-1)).toMatchObject({todayPracticeAnswers:1,todayNormalAnswers:1});
    expect(s.counts()).toEqual({progress:3,options:0});
  } finally {s.db.sqlite.close();}
});
