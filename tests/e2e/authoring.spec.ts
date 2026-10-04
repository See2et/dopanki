import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const config={newPerDay:20,reviewPerDay:200,desiredRetention:.9,parameters:[],learningSteps:[1,10],relearningSteps:[10],maximumInterval:36500,fsrsEnabled:true};
const deck={id:'deck-1',name:'ことばの種',configId:'config-1',config,version:1};
const noteType={id:'type-1',name:'ことばと意味',kind:'normal',fields:['JP','裏'],fieldDefinitions:[{id:'field-0',name:'JP',required:true},{id:'field-1',name:'裏',required:false}],templates:[{id:'template-0',name:'カード1',front:'{{JP}}',back:'{{FrontSide}}<hr>{{裏}}'}],css:'.card { font-size:22px; }',version:1};
const note={id:'note-1',noteTypeId:'type-1',fields:{JP:'serendipity',裏:'思いがけない発見'},tags:['英語'],version:1,contentFormat:'plain',cards:[{id:'card-1',deckId:'deck-1',templateId:'template-0',suspended:false}]};
async function mock(page:Page,mutation?:(path:string,method:string,body:any)=>Promise<{status?:number;body:unknown}|undefined>,listedNotes=[note]){
  await page.route('**/api/**',async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;const method=request.method();
    let result:any;
    if(method!=='GET'&&mutation)result=await mutation(path,method,request.postDataJSON());
    if(result){await route.fulfill({status:result.status||200,json:result.body});return;}
    const defaults:Record<string,unknown>={
      '/api/session':{authenticated:true,passwordRequired:false},
      '/api/overview':{imported:true,warnings:[],decks:[{...deck,parentId:null,depth:0,label:deck.name,counts:{new:1,learning:0,review:0,total:1},ownCounts:{new:1,learning:0,review:0,total:1},answeredToday:0,ownAnsweredToday:0}]},
      '/api/manage/decks':{decks:[deck]},'/api/manage/note-types':{noteTypes:[noteType]},
      '/api/manage/notes':{notes:listedNotes,total:listedNotes.length},'/api/manage/notes/note-1':{note},
      '/api/manage/notes/note-1/history':{history:[{id:'history-1',createdAt:'2026-10-04T10:00:00Z',actor:'web',before:null,after:{fields:['serendipity','思いがけない発見']}}]},
      '/api/manage/tokens':{tokens:[{id:'token-1',name:'学習ツール',scopes:['content:read'],createdAt:'2026-10-04T10:00:00Z',revoked:false}]},
    };
    await route.fulfill({json:defaults[path]||{ok:true}});
  });
  await page.goto('/');await page.getByRole('button',{name:'教材管理',exact:true}).click();await expect(page.getByRole('heading',{name:/ノート一覧/})).toBeVisible();
}

test('authoring list, safe previews and unsaved edit protection work on desktop and mobile',async({page})=>{
  await page.setViewportSize({width:1280,height:1000});await mock(page);
  await mkdir('.local/screenshots',{recursive:true});await page.screenshot({path:'.local/screenshots/authoring-notes-desktop.png'});
  await page.getByRole('button',{name:/serendipity/}).click();await expect(page.getByRole('heading',{name:'ノートを編集'})).toBeVisible();await page.locator('#note-preview').scrollIntoViewIfNeeded();await expect(page.frameLocator('iframe[title="表のプレビュー"]').locator('body')).toContainText('serendipity');await page.screenshot({path:'.local/screenshots/authoring-preview-desktop.png'});
  await page.getByRole('textbox',{name:/JP 必須/}).fill('<script>window.parent.hacked=true</script> & hello');
  await page.getByRole('button',{name:'プレビューを更新'}).click();
  await expect(page.frameLocator('iframe[title="表のプレビュー"]').locator('body')).toContainText('<script>window.parent.hacked=true</script> & hello');
  expect(await page.evaluate(()=>Boolean((window as any).hacked))).toBe(false);
  await page.getByRole('button',{name:'編集履歴',exact:true}).click();await expect(page.locator('.manage-history')).toContainText('編集履歴');
  await page.getByRole('button',{name:'デッキ',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'編集を続ける'}).click();await expect(page.getByRole('textbox',{name:/JP 必須/})).toHaveValue(/<script>/);
  await page.getByRole('textbox',{name:/JP 必須/}).fill('serendipity');await page.getByRole('button',{name:'プレビューを更新'}).click();await page.setViewportSize({width:390,height:844});await page.locator('#note-preview').scrollIntoViewIfNeeded();await expect(page.frameLocator('iframe[title="表のプレビュー"]').locator('body')).toContainText('serendipity');await page.screenshot({path:'.local/screenshots/authoring-preview-mobile.png'});expect(await page.evaluate(()=>document.body.scrollWidth)).toBe(390);await page.screenshot({path:'.local/screenshots/authoring-note-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'ノートタイプ',exact:true}).click();await page.getByRole('button',{name:'破棄して移動'}).click();await page.getByRole('button',{name:/ことばと意味.*フィールド/}).click();
  await page.setViewportSize({width:1280,height:1100});await page.locator('#type-preview').scrollIntoViewIfNeeded();await page.screenshot({path:'.local/screenshots/authoring-type-desktop.png',fullPage:true});
});

test('a failed note save retains draft and request ID',async({page})=>{
  const bodies:any[]=[];
  await mock(page,async(path,method,body)=>{if(path==='/api/manage/notes/note-1'&&method==='PATCH'){bodies.push(body);return bodies.length===1?{status:503,body:{error:'一時的な通信エラー'}}:{body:{note:{...note,...body,version:2}}};}});
  await page.getByRole('button',{name:/serendipity/}).click();await page.getByRole('textbox',{name:/裏 任意/}).fill('偶然のすてきな出会い');await page.getByRole('textbox',{name:/^タグ/}).fill('英語 単語');
  await page.getByRole('combobox',{name:'学習状態'}).selectOption('true');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('alert')).toContainText('入力は残っています');
  await expect(page.getByRole('textbox',{name:/裏 任意/})).toHaveValue('偶然のすてきな出会い');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:/ノート一覧/})).toBeVisible();
  expect(bodies).toHaveLength(2);expect(bodies[0].requestId).toBe(bodies[1].requestId);expect(bodies[1]).toMatchObject({version:1,fields:{JP:'serendipity',裏:'偶然のすてきな出会い'},tags:['英語','単語'],suspended:true});
});

test('type edits preserve identities and use the renderer for typed answer and TTS',async({page})=>{
  let body:any;await mock(page,async(path,method,data)=>{if(path==='/api/manage/note-types/type-1'&&method==='PATCH'){body=data;return {body:{noteType:{...noteType,...data,version:2}}};}});
  await page.getByRole('button',{name:'ノートタイプ',exact:true}).click();await page.getByRole('button',{name:/ことばと意味.*フィールド/}).click();
  await page.getByRole('textbox',{name:'表面のHTML'}).fill('{{JP}} {{type:裏}} {{tts ja_JP:裏}}');await page.getByRole('button',{name:'＋ フィールドを追加'}).click();await page.getByRole('button',{name:'＋ カードを追加'}).click();
  await page.getByText('サンプルで表示を確認',{exact:true}).click();await page.getByRole('button',{name:'プレビューを更新'}).click();await expect(page.getByRole('textbox',{name:'表の解答入力プレビュー'})).toBeVisible();await expect(page.getByRole('button',{name:'読み上げを試す'})).toBeVisible();
  await page.getByRole('button',{name:'フィールド 3 を上へ'}).click();await page.getByRole('button',{name:'カード 2 を上へ'}).click();await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'ノートタイプ',exact:true})).toBeVisible();expect(body.version).toBe(1);expect(body.fieldDefinitions[0].id).toBe('field-0');expect(body.templates[1].id).toBe('template-0');expect(body.fieldDefinitions[1].id).toMatch(/^[0-9a-f-]{36}$/);expect(body.templates[0].id).toMatch(/^[0-9a-f-]{36}$/);
});

test('deck configuration and token issuance/revocation are reviewable and explicit',async({page})=>{
  const mutations:any[]=[];await mock(page,async(path,method,body)=>{mutations.push({path,method,body});if(path==='/api/manage/tokens')return {body:{token:'dopanki_test_secret',info:{id:'token-2'}}};return {body:{deck:{...deck,...body},ok:true}};});
  await page.getByRole('button',{name:'デッキ',exact:true}).click();await page.getByRole('button',{name:/ことばの種.*新規/}).click();await page.getByRole('textbox',{name:'デッキ名'}).fill('ことばの森');await page.getByRole('spinbutton',{name:'新規カードの1日上限'}).fill('12');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'デッキ',exact:true})).toBeVisible();
  expect(mutations[0]).toMatchObject({method:'PATCH',path:'/api/manage/decks/deck-1',body:{version:1,name:'ことばの森',parentId:null,config:{newPerDay:12,reviewPerDay:200}}});
  await page.getByRole('button',{name:'APIトークン',exact:true}).click();await page.getByRole('button',{name:'＋ トークンを発行'}).click();await page.getByRole('textbox',{name:/^名前/}).fill('自分のツール');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('textbox',{name:'発行したトークン'})).toHaveValue('dopanki_test_secret');
  await page.getByRole('button',{name:'一覧へ戻る'}).click();await expect(page.getByRole('dialog')).toContainText('トークンを保存しましたか');await page.getByRole('button',{name:'保存したので移動'}).click();await page.getByRole('button',{name:'失効する',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('トークンを失効しますか');await page.getByRole('dialog').getByRole('button',{name:'失効する',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>mutations.length).toBe(3);expect(mutations[2].path).toBe('/api/manage/tokens/token-1/revoke');
});

test('a version conflict preserves the edited note for recovery',async({page})=>{
  await mock(page,async()=>({status:409,body:{error:'編集バージョンが古いです。'}}));
  await page.getByRole('button',{name:/serendipity/}).click();await page.getByRole('textbox',{name:/JP 必須/}).fill('新しい原稿');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('alert')).toContainText('編集バージョンが古い');await expect(page.getByRole('textbox',{name:/JP 必須/})).toHaveValue('新しい原稿');await expect(page.getByRole('button',{name:'保存する',exact:true})).toBeEnabled();
});

test('a lost token response retries the same issuance and explains one-time disclosure',async({page})=>{
  await mock(page);let attempts=0;const requestIds:string[]=[];
  await page.route('**/api/manage/tokens',async route=>{
    if(route.request().method()==='GET'){await route.fallback();return;}
    attempts++;requestIds.push(route.request().postDataJSON().requestId);
    if(attempts===1)await route.abort('connectionfailed');else await route.fulfill({json:{token:null,info:{id:'token-2'}}});
  });
  await page.getByRole('button',{name:'APIトークン',exact:true}).click();await page.getByRole('button',{name:'＋ トークンを発行'}).click();await page.getByRole('textbox',{name:/^名前/}).fill('再試行の鍵');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'トークンは発行済みです'})).toBeVisible();await expect(page.locator('#manage-content')).toContainText('失効し、新しいトークンを発行');expect(requestIds[0]).toBe(requestIds[1]);
});

test('note excerpts preserve native literals and decode imported HTML as text',async({page})=>{
  await page.setViewportSize({width:1280,height:1000});
  await mock(page,undefined,[
    {...note,id:'native-literal',fields:{JP:'<div>',裏:'x < y > z &amp;'},tags:['ネイティブ']},
    {...note,id:'imported-html',contentFormat:'html',fields:{JP:'<b>tea &amp; cake</b>',裏:'<i>one &lt; two</i><br>next'},tags:['取り込み']},
  ]);
  const native=page.locator('[data-note="native-literal"]');const imported=page.locator('[data-note="imported-html"]');
  await expect(native.locator('strong')).toHaveText('<div>');await expect(native.locator('.manage-note-copy > span')).toHaveText('x < y > z &amp;');
  await expect(imported.locator('strong')).toHaveText('tea & cake');await expect(imported.locator('.manage-note-copy > span')).toHaveText('one < two next');
  await expect(native.locator('div,em,script')).toHaveCount(0);await expect(imported.locator('.manage-note-copy b,.manage-note-copy i')).toHaveCount(0);
  await mkdir('.local/screenshots',{recursive:true});await page.screenshot({path:'.local/screenshots/authoring-excerpts-desktop.png'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.body.scrollWidth)).toBe(390);await page.screenshot({path:'.local/screenshots/authoring-excerpts-mobile.png',fullPage:true});
});

test('live isolated backend: create, edit, history and suspension round trip',async({page,request})=>{
  test.skip(process.env.DOPANKI_AUTHORING_LIVE!=='1','Requires an explicitly isolated authoring runtime.');
  const suffix=`UI-${Date.now()}`;const deckName=`学びの庭 ${suffix}`;const typeName=`ことばの型 ${suffix}`;const question=`<div> serendipity ${suffix}`;
  await page.goto('/');await page.getByRole('button',{name:'教材管理',exact:true}).click();
  if(!(await (await request.get('/api/overview')).json()).imported)await page.getByRole('button',{name:'教材づくりを始める'}).click();
  await page.getByRole('button',{name:'デッキ',exact:true}).click();await page.getByRole('button',{name:'＋ デッキを作成'}).click();await page.getByRole('textbox',{name:'デッキ名'}).fill(deckName);await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'デッキ',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'ノートタイプ',exact:true}).click();await page.getByRole('button',{name:'＋ タイプを作成'}).click();await page.getByRole('textbox',{name:'タイプ名'}).fill(typeName);await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'ノートタイプ',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'ノート',exact:true}).click();await page.getByRole('button',{name:'＋ ノートを作成'}).click();await page.getByRole('combobox',{name:'ノートタイプ',exact:true}).selectOption({label:typeName});await page.getByRole('combobox',{name:'デッキ',exact:true}).selectOption({label:deckName});await page.getByRole('textbox',{name:/表 必須/}).fill(question);await page.getByRole('textbox',{name:/裏 必須/}).fill('思いがけない発見');await page.getByRole('textbox',{name:/^タグ/}).fill('英語 UI確認');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:/ノート一覧/})).toBeVisible();
  await page.getByRole('searchbox',{name:'内容・タグで検索'}).fill(question);await page.getByRole('button',{name:'検索',exact:true}).click();await expect(page.locator('.manage-note-row')).toHaveCount(1);
  await page.getByRole('button',{name:new RegExp(question)}).click();await expect(page.getByRole('textbox',{name:/表 必須/})).toHaveValue(question);await page.getByRole('button',{name:'編集履歴',exact:true}).click();await expect(page.locator('.manage-history')).toContainText('編集履歴');await page.locator('.manage-history summary').first().click();await expect(page.locator('.manage-history')).toContainText('新規作成（変更前なし）');
  await page.getByRole('textbox',{name:/裏 必須/}).fill('偶然のすてきな出会い');await page.getByRole('combobox',{name:'学習状態'}).selectOption('true');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:/ノート一覧/})).toBeVisible();
  const {notes}=await (await request.get(`/api/manage/notes?q=${encodeURIComponent(question)}`)).json();expect(notes).toHaveLength(1);expect(notes[0].fields).toEqual({表:question,裏:'偶然のすてきな出会い'});expect(notes[0].cards.every((c:any)=>c.suspended)).toBe(true);
  await page.getByRole('button',{name:new RegExp(question)}).click();await page.getByRole('combobox',{name:'学習状態'}).selectOption('false');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:/ノート一覧/})).toBeVisible();const resumed=await (await request.get(`/api/manage/notes/${notes[0].id}`)).json();expect(resumed.note.cards.every((c:any)=>!c.suspended)).toBe(true);
  await page.getByRole('button',{name:'学習に戻る'}).click();await expect(page.getByRole('heading',{name:'今日の復習'})).toBeVisible();await expect(page.getByRole('button',{name:`${deckName}を学習`,exact:true})).toBeVisible();
});
