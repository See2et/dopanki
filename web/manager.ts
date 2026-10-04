import './manage.css';
import { escapeHtml as esc, plainText, renderCard, type RenderedCard } from '../src/lib/render';
import type { StudyCard } from '../src/lib/types';
import type { ApiScope, ManagedDeck, ManagedNote, ManagedNoteType, NoteTypeInput, TokenInfo } from '../src/lib/manage-types';
import { frameDocument } from './card-frame';
import { hamster } from './mascot';

type Tab = 'notes' | 'types' | 'decks' | 'tokens';
const titles: Record<Tab,string> = { notes:'ノート', types:'ノートタイプ', decks:'デッキ', tokens:'APIトークン' };
const uuid = () => crypto.randomUUID();
const option = (value:string,text:string,selected=false) => `<option value="${esc(value)}"${selected?' selected':''}>${esc(text)}</option>`;
const field = (label:string,control:string,hint='') => `<label class="manage-field"><span>${label}</span>${control}${hint?`<small>${hint}</small>`:''}</label>`;
const text = (name:string,value='',required=false) => `<input name="${esc(name)}" value="${esc(value)}"${required?' required':''}>`;
const area = (name:string,value='',rows=4) => `<textarea name="${esc(name)}" rows="${rows}">${esc(value)}</textarea>`;

export function openManager(root:HTMLElement, options:{ imported:boolean; back:()=>Promise<void> }): void {
  let tab:Tab='notes'; let decks:ManagedDeck[]=[]; let types:ManagedNoteType[]=[]; let tokens:TokenInfo[]=[];
  let dirty=false; let secretShown=false; let busy=false; let alive=true; let requestGeneration=0; let offset=0;
  let query=''; let deckFilter=''; let typeFilter='';
  const retryIds=new Map<string,string>();
  const beforeUnload=(event:BeforeUnloadEvent) => { if(dirty || secretShown || busy){event.preventDefault();event.returnValue='';} };
  window.addEventListener('beforeunload',beforeUnload);
  root.innerHTML=`<header class="app-bar"><div class="app-bar-inner"><button class="brand" id="manage-home">${hamster('calm')}<span>Dopanki</span></button><button class="bar-link" id="manage-back">学習に戻る</button></div></header><main class="manage"><div class="manage-heading"><div><p class="manage-eyebrow">自分のことばで、覚えよう</p><h1>教材管理</h1><p>ノートをつくって、毎日の学習へ。</p></div><div class="manage-mascot" aria-hidden="true">${hamster('calm')}</div></div><nav class="manage-tabs" aria-label="教材管理">${(Object.keys(titles) as Tab[]).map(key=>`<button data-tab="${key}" aria-pressed="${key===tab}">${titles[key]}</button>`).join('')}</nav><div id="manage-status" aria-live="polite"></div><div id="manage-content"></div></main>`;
  const content=root.querySelector<HTMLElement>('#manage-content')!;
  const status=root.querySelector<HTMLElement>('#manage-status')!;
  const message=(value:string,error=false) => {status.className=error?'manage-status is-error':'manage-status';status.textContent=value;status.setAttribute('role',error?'alert':'status');};
  const on=(selector:string,fn:(event:Event)=>void) => root.querySelector(selector)?.addEventListener('click',fn);
  const cleanup=()=>{alive=false;requestGeneration++;window.removeEventListener('beforeunload',beforeUnload);window.speechSynthesis?.cancel();};
  async function confirmDiscard():Promise<boolean>{
    if(busy)return false;
    if(!dirty&&!secretShown)return true;
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='manage-dialog';
      dialog.innerHTML=secretShown?'<h2>トークンを保存しましたか？</h2><p>この画面を離れると、鍵の全文は再表示できません。</p><div class="manage-actions"><button class="secondary" data-stay>画面に戻る</button><button class="primary" data-discard>保存したので移動</button></div>':'<h2>変更を破棄しますか？</h2><p>保存していない入力があります。</p><div class="manage-actions"><button class="secondary" data-stay>編集を続ける</button><button class="primary" data-discard>破棄して移動</button></div>';
      document.body.appendChild(dialog);let discarded=false;
      dialog.querySelector('[data-stay]')!.addEventListener('click',()=>dialog.close());
      dialog.querySelector('[data-discard]')!.addEventListener('click',()=>{discarded=true;dialog.close();});
      dialog.addEventListener('close',()=>{dialog.remove();if(discarded){dirty=false;secretShown=false;}resolve(discarded);},{once:true});dialog.showModal();
    });
  }
  const back=async()=>{if(await confirmDiscard()){cleanup();await options.back();}};
  on('#manage-home',()=>void back());on('#manage-back',()=>void back());
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.addEventListener('click',()=>void (async()=>{
    if(!(await confirmDiscard()))return;
    tab=button.dataset.tab as Tab;offset=0;message('');
    root.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String((b as HTMLElement).dataset.tab===tab)));await showTab();
  })());
  async function api<T>(path:string,method='GET',body?:Record<string,unknown>):Promise<T>{
    let payload=body;let signature='';
    if(body){signature=JSON.stringify([method,path,body]);let id=retryIds.get(signature);if(!id){id=uuid();retryIds.set(signature,id);}payload={...body,requestId:id};}
    const response=await fetch(`/api/manage${path}`,{method,cache:'no-store',...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
    const result=await response.json() as T & {error?:string};
    if(!response.ok)throw new Error(response.status===409?`${result.error||'別の画面で更新されています。'} 入力を控えてから、一覧を開き直してください。`:result.error||'保存できませんでした。');
    if(signature)retryIds.delete(signature);return result;
  }
  const deckOptions=(id='',empty=false)=>`${empty?option('','すべてのデッキ',!id):''}${decks.map(d=>option(d.id,d.name.replaceAll('::',' / '),d.id===id)).join('')}`;
  const typeOptions=(id='',empty=false)=>`${empty?option('','すべてのタイプ',!id):''}${types.map(t=>option(t.id,t.name,t.id===id)).join('')}`;
  async function reloadCatalog(){const [d,t]=await Promise.all([api<{decks:ManagedDeck[]}>('/decks'),api<{noteTypes:ManagedNoteType[]}>('/note-types')]);decks=d.decks;types=t.noteTypes;}
  async function runSave(button:HTMLButtonElement,work:()=>Promise<void>){
    if(busy)return;busy=true;button.disabled=true;message('保存しています…');
    // Freeze inputs while the request is pending, so a response cannot discard later edits.
    const controls=[...content.querySelectorAll<HTMLElement & {disabled:boolean}>('input,select,textarea,button')];
    const states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
    try{await work();if(alive)message('保存しました。');}
    catch(error){if(alive)message(`${error instanceof Error?error.message:'通信に失敗しました。'} 入力は残っています。同じ内容で再度保存すると安全に再試行できます。`,true);}
    finally{busy=false;controls.forEach((c,i)=>c.disabled=states[i]);button.disabled=false;}
  }
  function bindForm(form:HTMLFormElement,save:(data:FormData)=>Promise<void>){
    dirty=false;form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});
    form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);void runSave(form.querySelector<HTMLButtonElement>('[type=submit]')!,()=>save(data));});
    on('[data-cancel]',()=>void (async()=>{if(await confirmDiscard()){await showTab();}})());
  }
  async function showTab(){
    const generation=++requestGeneration;content.innerHTML='<p class="manage-loading" role="status">読み込んでいます…</p>';
    try{await reloadCatalog();if(!alive||generation!==requestGeneration)return;if(tab==='notes')await showNotes();else if(tab==='types')showTypes();else if(tab==='decks')showDecks();else await showTokens();}
    catch(error){if(alive&&generation===requestGeneration){message((error as Error).message,true);content.innerHTML='<button class="secondary" id="manage-reload">再読み込み</button>';on('#manage-reload',()=>void showTab());}}
  }
  function editorHead(title:string,subtitle:string){return `<div class="manage-section-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="manage-text-button" type="button" data-cancel>一覧へ戻る</button></div>`;}
  function saveBar(){return '<div class="manage-save"><span>保存すると学習用の教材に反映されます。</span><button class="primary" type="submit">保存する</button></div>';}
  async function showNotes(){
    const generation=++requestGeneration;
    const result=await api<{notes:ManagedNote[];total:number}>(`/notes?${new URLSearchParams({q:query,deckId:deckFilter,noteTypeId:typeFilter,offset:String(offset),limit:'30'})}`);
    if(!alive||generation!==requestGeneration)return;
    content.innerHTML=`<section class="manage-panel"><div class="manage-section-head"><div><h2>ノート一覧 <span class="manage-count">${result.total}</span></h2><p>内容を探して、少しずつ育てましょう。</p></div><button class="primary" id="new-note"${!types.some(t=>t.kind==='normal')||!decks.length?' disabled':''}>＋ ノートを作成</button></div><form id="note-search" class="manage-filters">${field('内容・タグで検索',`<input name="q" type="search" placeholder="キーワードを入力" value="${esc(query)}">`)}${field('デッキ',`<select name="deckId">${deckOptions(deckFilter,true)}</select>`)}${field('ノートタイプ',`<select name="noteTypeId">${typeOptions(typeFilter,true)}</select>`)}<button class="secondary">検索</button></form>${!decks.length||!types.length?'<p class="manage-empty">まず「デッキ」と「ノートタイプ」を作成すると、ノートを追加できます。</p>':''}<div class="manage-note-list">${result.notes.map(n=>{
      const t=types.find(t=>t.id===n.noteTypeId);const values=(t?t.fieldDefinitions.map(f=>n.fields[f.name]||''):Object.values(n.fields)).map(value=>n.contentFormat==='html'?plainText(value):value);
      return `<button class="manage-note-row" data-note="${esc(n.id)}"><span class="manage-note-copy"><strong>${esc(values[0]?.slice(0,140)||'（空のノート）')}</strong><span>${esc(values[1]?.slice(0,100)||'')}</span><small>${esc(t?.name||'不明なタイプ')} · ${esc(decks.find(d=>d.id===n.cards[0]?.deckId)?.name.replaceAll('::',' / ')||'未割り当て')}</small></span><span class="manage-note-meta">${n.tags.slice(0,3).map(tag=>`<span class="manage-tag">${esc(tag)}</span>`).join('')}${n.cards.some(c=>c.suspended)?'<span class="manage-tag is-paused">休止中</span>':''}<span aria-hidden="true">›</span></span></button>`;
    }).join('')||'<p class="manage-empty">ノートが見つかりませんでした。</p>'}</div><div class="manage-pagination"><button class="manage-text-button" id="notes-prev"${offset===0?' disabled':''}>前へ</button><span>${result.total?`${offset+1}–${offset+result.notes.length} / ${result.total}`:'0 件'}</span><button class="manage-text-button" id="notes-next"${offset+30>=result.total?' disabled':''}>次へ</button></div></section>`;
    on('#new-note',()=>editNote());
    content.querySelector('#note-search')!.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.target as HTMLFormElement);query=String(data.get('q'));deckFilter=String(data.get('deckId'));typeFilter=String(data.get('noteTypeId'));offset=0;void showNotes().catch(e=>message(e.message,true));});
    on('#notes-prev',()=>{offset=Math.max(0,offset-30);void showNotes().catch(e=>message(e.message,true));});on('#notes-next',()=>{offset+=30;void showNotes().catch(e=>message(e.message,true));});
    for(const button of content.querySelectorAll<HTMLElement>('[data-note]'))button.addEventListener('click',()=>void (async()=>{try{const generation=requestGeneration;const {note}=await api<{note:ManagedNote}>(`/notes/${encodeURIComponent(button.dataset.note!)}`);if(alive&&generation===requestGeneration)editNote(note);}catch(e){message((e as Error).message,true);}})());
  }
  function previewCard(type:ManagedNoteType,values:Record<string,string>,deckId:string,ordinal:number):StudyCard{
    const deck=decks.find(d=>d.id===deckId)||decks[0];
    const fields=type.fieldDefinitions.map(f=>values[f.id]||'');
    return {ordinal,note:{id:'preview',guid:'preview',noteTypeId:type.id,fields,tags:[],contentFormat:'plain'},noteType:{...type,fields:type.fieldDefinitions.map(f=>f.name)},deck:deck||{id:'preview',name:'プレビュー',configId:'',config:{}},id:'preview'} as unknown as StudyCard;
  }
  function mountPreview(target:HTMLElement,card:StudyCard){
    window.speechSynthesis?.cancel();target.innerHTML='<div class="manage-preview-head"><h3>カードプレビュー</h3><span>学習時の表示</span></div><div class="manage-preview-sides"></div>';
    const front=renderCard(card,'front');const back=renderCard(card,'back',front.html);
    for(const [label,rendered] of [['表',front],['裏',back]] as [string,RenderedCard][]){
      const section=document.createElement('section');section.className='manage-preview-side';const heading=document.createElement('h4');heading.textContent=label;section.appendChild(heading);
      const frame=document.createElement('iframe');frame.title=`${label}のプレビュー`;frame.setAttribute('sandbox','');frame.srcdoc=frameDocument(rendered);section.appendChild(frame);
      if(rendered.typedAnswer){const input=document.createElement('input');input.placeholder='ここに答えを入力';input.setAttribute('aria-label',`${label}の解答入力プレビュー`);section.appendChild(input);}
      if(rendered.speech.length){const speech=document.createElement('button');speech.type='button';speech.className='manage-text-button';speech.textContent='読み上げを試す';speech.addEventListener('click',()=>{window.speechSynthesis?.cancel();for(const s of rendered.speech){const utterance=new SpeechSynthesisUtterance(s.text);utterance.lang=s.lang;utterance.rate=s.rate;window.speechSynthesis?.speak(utterance);}});section.appendChild(speech);}
      if(rendered.warnings.length){const p=document.createElement('p');p.className='manage-hint';p.textContent=rendered.warnings.join(' ');section.appendChild(p);}target.querySelector('.manage-preview-sides')!.appendChild(section);
    }
  }
  function editNote(note?:ManagedNote){
    const normalTypes=types.filter(t=>t.kind==='normal');let type=types.find(t=>t.id===note?.noteTypeId)||normalTypes[0];if(!type)return;
    let draft=Object.fromEntries(type.fieldDefinitions.map(f=>[f.id,note?.fields[f.name]||'']));const drafts=new Map<string,Record<string,string>>();
    content.innerHTML=`<section class="manage-panel">${editorHead(note?'ノートを編集':'新しいノート','フィールドに内容を入力すると、カードができあがります。')}<form id="note-form"><div class="manage-form-grid">${field('ノートタイプ',`<select name="noteTypeId"${note?' disabled':''}>${(note?types:normalTypes).map(t=>option(t.id,t.name,t.id===type.id)).join('')}</select>`)}${field('デッキ',`<select name="deckId" required>${deckOptions(note?.cards[0]?.deckId)}</select>`)}</div>${note&&new Set(note.cards.map(c=>c.deckId)).size>1?'<p class="manage-hint">カードは複数のデッキにあります。デッキを変更すると、すべてのカードを移動します。</p>':''}<div id="note-fields"></div>${field('タグ',text('tags',note?.tags.join(' ')||''),'スペースまたはカンマで区切ります。')}<div class="manage-actions"><button type="button" class="secondary" id="note-preview-button">プレビューを更新</button>${note?'<button type="button" class="manage-text-button" id="note-history">編集履歴</button>':''}</div>${note?field('学習状態',`<select name="suspended">${option('keep','現在の状態を維持',true)}${option('false','すべてのカードを再開')}${option('true','すべてのカードを休止')}</select>`):''}${field('プレビューするカード',`<select id="note-preview-template">${type.templates.map((t,i)=>option(String(i),t.name)).join('')}</select>`)}<div id="note-preview" class="manage-preview"></div>${saveBar()}</form><div id="note-history-content"></div></section>`;
    const form=content.querySelector<HTMLFormElement>('#note-form')!;
    const fieldsRoot=content.querySelector<HTMLElement>('#note-fields')!;
    const readFields=()=>{const data=new FormData(form);return Object.fromEntries(type.fieldDefinitions.map(f=>[f.id,String(data.get(`field:${f.id}`)||'')]));};
    const drawFields=()=>{fieldsRoot.innerHTML=type.fieldDefinitions.map(f=>field(`${esc(f.name)} ${f.required?'<em>必須</em>':'<small>任意</small>'}`,`<textarea name="field:${esc(f.id)}" rows="3"${f.required?' required':''}>${esc(draft[f.id]||'')}</textarea>`)).join('');};
    drawFields();
    const preview=()=>{const card=previewCard(type,readFields(),String(new FormData(form).get('deckId')),Number((content.querySelector('#note-preview-template') as unknown as HTMLSelectElement).value)||0);if(note?.contentFormat==='html')card.note.contentFormat='html';mountPreview(content.querySelector('#note-preview')!,card);};
    // Imported HTML stays HTML; new authored notes use plain text.
    if(note?.contentFormat==='html')fieldsRoot.insertAdjacentHTML('afterbegin','<p class="manage-hint">取り込んだHTMLを編集しています。HTMLタグもそのまま保存されます。</p>');
    form.querySelector('[name=noteTypeId]')?.addEventListener('change',()=>{drafts.set(type.id,readFields());type=types.find(t=>t.id===(form.querySelector('[name=noteTypeId]') as unknown as HTMLSelectElement).value)!;draft=drafts.get(type.id)||{};drawFields();content.querySelector('#note-preview-template')!.innerHTML=type.templates.map((t,i)=>option(String(i),t.name)).join('');preview();});
    on('#note-preview-button',preview);preview();
    on('#note-history',()=>void (async()=>{try{const {history}=await api<{history:{id:string;before:{fields:string[]|Record<string,string>}|null;after:{fields:string[]|Record<string,string>};actor:string;createdAt:string}[]}>(`/notes/${encodeURIComponent(note!.id)}/history`);content.querySelector('#note-history-content')!.innerHTML=`<section class="manage-history"><h3>編集履歴</h3>${history.map(h=>`<details><summary>${esc(new Date(h.createdAt).toLocaleString('ja-JP'))} · ${esc(h.actor)}</summary><h4>変更前</h4><pre>${esc(h.before?JSON.stringify(h.before.fields,null,2):'新規作成（変更前なし）')}</pre><h4>変更後</h4><pre>${esc(JSON.stringify(h.after.fields,null,2))}</pre></details>`).join('')||'<p>まだ編集履歴はありません。</p>'}</section>`;}catch(e){message((e as Error).message,true);}})());
    bindForm(form,async data=>{
      const fields=Object.fromEntries(type.fieldDefinitions.map(f=>[f.name,String(data.get(`field:${f.id}`)||'')]));const tags=String(data.get('tags')||'').split(/[\s,]+/).filter(Boolean);const deckId=String(data.get('deckId'));
      const body=note?{version:note.version,fields,tags,...(deckId!==note.cards[0]?.deckId?{deckId}:{}),...(data.get('suspended')!=='keep'?{suspended:data.get('suspended')==='true'}:{})}:{noteTypeId:type.id,deckId,fields,tags};
      await api(note?`/notes/${encodeURIComponent(note.id)}`:'/notes',note?'PATCH':'POST',body);dirty=false;await showNotes();
    });
  }
  function showTypes(){
    content.innerHTML=`<section class="manage-panel"><div class="manage-section-head"><div><h2>ノートタイプ</h2><p>フィールドと、表・裏の見せ方を決めます。</p></div><button class="primary" id="new-type">＋ タイプを作成</button></div><div class="manage-object-list">${types.map(t=>`<button class="manage-object-row" data-type="${esc(t.id)}"><span><strong>${esc(t.name)}</strong><small>${t.fieldDefinitions.length} フィールド · ${t.templates.length} カード${t.kind==='cloze'?' · 穴埋め式（閲覧のみ）':''}</small></span><span aria-hidden="true">›</span></button>`).join('')||'<p class="manage-empty">最初のノートタイプを作成しましょう。</p>'}</div></section>`;
    on('#new-type',()=>editType());for(const b of content.querySelectorAll<HTMLElement>('[data-type]'))b.addEventListener('click',()=>editType(types.find(t=>t.id===b.dataset.type)));
  }
  function editType(existing?:ManagedNoteType){
    const input:NoteTypeInput=existing?structuredClone(existing):{name:'',fieldDefinitions:[{id:uuid(),name:'表',required:true},{id:uuid(),name:'裏',required:true}],templates:[{id:uuid(),name:'カード1',front:'{{表}}',back:'{{FrontSide}}<hr>{{裏}}'}],css:'.card { font-size: 22px; }'};
    const readonly=existing?.kind==='cloze';
    content.innerHTML=`<section class="manage-panel">${editorHead(existing?'ノートタイプを編集':'新しいノートタイプ','ひとつのノートから、複数のカードを作ることもできます。')}${readonly?'<p class="manage-hint">穴埋め式は現在、閲覧のみです。</p>':''}<form id="type-form">${field('タイプ名',text('name',input.name,true))}<div class="manage-subheading"><h3>フィールド</h3><button type="button" class="manage-text-button" id="add-field">＋ フィールドを追加</button></div><p class="manage-hint">フィールド名を変更すると、未編集のテンプレートの参照も更新します。テンプレートも編集する場合は、新しい名前を使ってください。</p><div id="type-fields"></div><div class="manage-subheading"><h3>カードテンプレート</h3><button type="button" class="manage-text-button" id="add-template">＋ カードを追加</button></div><details class="manage-help"><summary>テンプレートの書き方</summary><p><code>{{フィールド名}}</code> で内容を表示します。裏面の <code>{{FrontSide}}</code> は表面を表示します。</p><p><code>{{type:フィールド名}}</code> で解答入力、<code>{{tts ja_JP:フィールド名}}</code> で読み上げを設定できます。</p><p><code>{{#フィールド名}}…{{/フィールド名}}</code> は内容があるときだけ表示します。</p></details><div id="type-templates"></div>${field('共通CSS',area('css',input.css,5))}<details class="manage-help"><summary>サンプルで表示を確認</summary><div id="sample-fields"></div>${field('表示するカード',`<select id="preview-template"></select>`)}<button type="button" class="secondary" id="type-preview-button">プレビューを更新</button></details><div id="type-preview" class="manage-preview"></div>${readonly?'':saveBar()}</form></section>`;
    const form=content.querySelector<HTMLFormElement>('#type-form')!;
    const capture=(snapshot?:FormData)=>{const data=snapshot||new FormData(form);input.name=String(data.get('name')||'');input.css=String(data.get('css')||'');input.fieldDefinitions.forEach(f=>{f.name=String(data.get(`name:${f.id}`)||'');f.required=data.get(`required:${f.id}`)==='on';});input.templates.forEach(t=>{t.name=String(data.get(`template-name:${t.id}`)||'');t.front=String(data.get(`front:${t.id}`)||'');t.back=String(data.get(`back:${t.id}`)||'');});};
    const samples=new Map<string,string>();
    const draw=()=>{
      const data=new FormData(form);input.fieldDefinitions.forEach(f=>{const value=data.get(`sample:${f.id}`);if(value!==null)samples.set(f.id,String(value));});
      content.querySelector('#type-fields')!.innerHTML=input.fieldDefinitions.map((f,i)=>`<div class="manage-definition">${field(`フィールド ${i+1}`,text(`name:${f.id}`,f.name,true))}<label class="manage-check"><input name="required:${esc(f.id)}" type="checkbox"${f.required?' checked':''}>必須</label><button type="button" class="manage-text-button" data-move-field="${i}" aria-label="フィールド ${i+1} を上へ"${i===0?' disabled':''}>↑</button></div>`).join('');
      content.querySelector('#type-templates')!.innerHTML=input.templates.map((t,i)=>`<section class="manage-template"><div class="manage-subheading"><h4>カード ${i+1}</h4><button type="button" class="manage-text-button" data-move-template="${i}" aria-label="カード ${i+1} を上へ"${i===0?' disabled':''}>↑</button></div>${field('カード名',text(`template-name:${t.id}`,t.name,true))}<div class="manage-form-grid">${field('表面のHTML',area(`front:${t.id}`,t.front,6))}${field('裏面のHTML',area(`back:${t.id}`,t.back,6))}</div></section>`).join('');
      content.querySelector('#sample-fields')!.innerHTML=input.fieldDefinitions.map(f=>field(esc(f.name),text(`sample:${f.id}`,samples.get(f.id)||`${f.name}のサンプル`))).join('');
      content.querySelector('#preview-template')!.innerHTML=input.templates.map((t,i)=>option(String(i),t.name)).join('');
      for(const b of content.querySelectorAll<HTMLElement>('[data-move-field]'))b.addEventListener('click',()=>{capture();const i=Number(b.dataset.moveField);[input.fieldDefinitions[i-1],input.fieldDefinitions[i]]=[input.fieldDefinitions[i],input.fieldDefinitions[i-1]];dirty=true;draw();});
      for(const b of content.querySelectorAll<HTMLElement>('[data-move-template]'))b.addEventListener('click',()=>{capture();const i=Number(b.dataset.moveTemplate);[input.templates[i-1],input.templates[i]]=[input.templates[i],input.templates[i-1]];dirty=true;draw();});
    };
    draw();on('#add-field',()=>{capture();input.fieldDefinitions.push({id:uuid(),name:`フィールド${input.fieldDefinitions.length+1}`,required:false});draw();dirty=true;});
    on('#add-template',()=>{capture();input.templates.push({id:uuid(),name:`カード${input.templates.length+1}`,front:`{{${input.fieldDefinitions[0].name}}}`,back:`{{FrontSide}}<hr>{{${input.fieldDefinitions[1]?.name||input.fieldDefinitions[0].name}}}`});draw();dirty=true;});
    const preview=()=>{capture();const data=new FormData(form);const type={...input,id:existing?.id||'preview',version:existing?.version||1,kind:existing?.kind||'normal',fields:input.fieldDefinitions.map(f=>f.name)} as ManagedNoteType;const values=Object.fromEntries(input.fieldDefinitions.map(f=>[f.id,String(data.get(`sample:${f.id}`)||'')]));mountPreview(content.querySelector('#type-preview')!,previewCard(type,values,decks[0]?.id||'',Number((content.querySelector('#preview-template') as unknown as HTMLSelectElement).value)||0));};
    on('#type-preview-button',preview);preview();
    bindForm(form,async data=>{capture(data);await api(existing?`/note-types/${encodeURIComponent(existing.id)}`:'/note-types',existing?'PATCH':'POST',{...input,...(existing?{version:existing.version}:{})});dirty=false;await reloadCatalog();showTypes();});
    if(readonly){form.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLTextAreaElement>('input,textarea,#add-field,#add-template,[data-move-field],[data-move-template]').forEach(c=>c.disabled=true);}
  }
  function showDecks(){
    content.innerHTML=`<section class="manage-panel"><div class="manage-section-head"><div><h2>デッキ</h2><p>教材をまとめて、1日の学習量を調整します。</p></div><button class="primary" id="new-deck">＋ デッキを作成</button></div><div class="manage-object-list">${decks.map(d=>`<button class="manage-object-row" data-managed-deck="${esc(d.id)}"><span><strong>${esc(d.name.replaceAll('::',' / '))}</strong><small>1日あたり 新規 ${d.config.newPerDay} · 復習 ${d.config.reviewPerDay??'上限なし'}</small></span><span aria-hidden="true">›</span></button>`).join('')||'<p class="manage-empty">毎日学ぶテーマに、名前をつけましょう。</p>'}</div></section>`;
    on('#new-deck',()=>editDeck());for(const b of content.querySelectorAll<HTMLElement>('[data-managed-deck]'))b.addEventListener('click',()=>editDeck(decks.find(d=>d.id===b.dataset.managedDeck)));
  }
  function editDeck(deck?:ManagedDeck){
    const parentName=deck?.name.split('::').slice(0,-1).join('::');const parent=decks.find(d=>d.name===parentName)?.id||(parentName?'__keep__':'');
    const candidates=decks.filter(d=>d.id!==deck?.id&&(!deck||!d.name.startsWith(deck.name+'::')));
    content.innerHTML=`<section class="manage-panel">${editorHead(deck?'デッキを編集':'新しいデッキ','親デッキを選ぶと、教材を階層で整理できます。')}<form id="deck-form">${field('デッキ名',text('name',deck?.name.split('::').at(-1)||'',true))}${field('親デッキ',`<select name="parentId">${option('','なし（最上位）',!parent)}${parent==='__keep__'?option('__keep__',`${parentName?.replaceAll('::',' / ')}（現在の階層を維持）`,true):''}${candidates.map(d=>option(d.id,d.name.replaceAll('::',' / '),d.id===parent)).join('')}</select>`)}<div class="manage-form-grid">${field('新規カードの1日上限',`<input name="newPerDay" type="number" min="0" max="100000" required value="${deck?.config.newPerDay??20}">`)}${field('復習カードの1日上限',`<input name="reviewPerDay" type="number" min="0" max="100000" placeholder="上限なし" value="${deck?deck.config.reviewPerDay??'':200}">`)}</div><p class="manage-hint">親の変更・名前の変更は、子デッキにも反映されます。</p>${saveBar()}</form></section>`;
    const form=content.querySelector<HTMLFormElement>('#deck-form')!;bindForm(form,async data=>{await api(deck?`/decks/${encodeURIComponent(deck.id)}`:'/decks',deck?'PATCH':'POST',{name:String(data.get('name')),...(data.get('parentId')==='__keep__'?{}:{parentId:data.get('parentId')||null}),config:{newPerDay:Number(data.get('newPerDay')),reviewPerDay:String(data.get('reviewPerDay')).trim()?Number(data.get('reviewPerDay')):null},...(deck?{version:deck.version}:{})});dirty=false;await reloadCatalog();showDecks();});
  }
  async function showTokens(){
    const generation=++requestGeneration;const data=await api<{tokens:TokenInfo[]}>('/tokens');if(!alive||generation!==requestGeneration)return;tokens=data.tokens;
    content.innerHTML=`<section class="manage-panel"><div class="manage-section-head"><div><h2>APIトークン</h2><p>外部ツールから教材にアクセスするための鍵です。</p></div><button class="primary" id="new-token">＋ トークンを発行</button></div><p class="manage-hint">必要な権限だけを選んで発行できます。使い終わった鍵は失効してください。</p><div class="manage-object-list">${tokens.map(t=>`<div class="manage-object-row"><span><strong>${esc(t.name)}</strong><small>${t.scopes.map(scopeLabel).join(' · ')} · ${esc(new Date(t.createdAt).toLocaleDateString('ja-JP'))}</small></span>${t.revoked?'<span class="manage-tag">失効済み</span>':`<button class="manage-text-button" data-revoke="${esc(t.id)}">失効する</button>`}</div>`).join('')||'<p class="manage-empty">発行済みのトークンはありません。</p>'}</div></section>`;
    on('#new-token',editToken);for(const b of content.querySelectorAll<HTMLButtonElement>('[data-revoke]'))b.addEventListener('click',()=>{
      const dialog=document.createElement('dialog');dialog.className='manage-dialog';dialog.innerHTML=`<h2>トークンを失効しますか？</h2><p>${esc(tokens.find(t=>t.id===b.dataset.revoke)?.name||'')} を使ったアクセスはできなくなります。</p><div class="manage-actions"><button class="secondary" data-close>キャンセル</button><button class="primary" data-confirm>失効する</button></div>`;document.body.appendChild(dialog);dialog.querySelector('[data-close]')!.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.querySelector<HTMLButtonElement>('[data-confirm]')!.addEventListener('click',()=>{dialog.close();void runSave(b,async()=>{await api(`/tokens/${encodeURIComponent(b.dataset.revoke!)}/revoke`,'POST',{});await showTokens();});});dialog.showModal();
    });
  }
  function scopeLabel(scope:ApiScope){return {'content:read':'教材の読み取り','content:write':'ノート・デッキの編集','types:write':'ノートタイプの編集'}[scope];}
  function editToken(){
    content.innerHTML=`<section class="manage-panel">${editorHead('トークンを発行','発行した鍵の全文は、この画面で1回だけ表示されます。')}<form id="token-form">${field('名前',text('name','',true),'例：自分の学習ツール')}<fieldset class="manage-scopes"><legend>権限</legend>${(['content:read','content:write','types:write'] as ApiScope[]).map(scope=>`<label class="manage-check"><input name="scopes" type="checkbox" value="${scope}"${scope==='content:read'?' checked':''}>${scopeLabel(scope)}</label>`).join('')}</fieldset>${saveBar()}</form></section>`;
    bindForm(content.querySelector('#token-form')!,async data=>{const result=await api<{token:string|null;info:TokenInfo}>('/tokens','POST',{name:String(data.get('name')),scopes:data.getAll('scopes')});dirty=false;
      if(!result.token){content.innerHTML='<section class="manage-panel"><h2>トークンは発行済みです</h2><p class="manage-hint">最初の通信の応答を受け取れなかったため、鍵の全文は再表示できません。発行済みトークンを失効し、新しいトークンを発行してください。</p><button class="secondary" data-cancel>トークン一覧へ</button></section>';on('[data-cancel]',()=>void showTokens());return;}
      const secret=result.token;secretShown=true;content.innerHTML=`<section class="manage-panel">${editorHead('トークンを発行しました','この画面を離れると、鍵の全文は再表示できません。')}<div class="manage-secret"><p>安全な場所にコピーして保存してください。</p>${field('発行したトークン',`<textarea readonly rows="3" id="token-secret">${esc(result.token)}</textarea>`)}<button class="secondary" id="copy-token">コピーする</button></div></section>`;
      on('[data-cancel]',()=>void (async()=>{if(await confirmDiscard())await showTokens();})());on('#copy-token',()=>void navigator.clipboard.writeText(secret).then(()=>message('コピーしました。'),()=>message('コピーできませんでした。鍵を選択してコピーしてください。',true)));
    });
  }
  if(options.imported)void showTab();else{
    content.innerHTML=`<section class="manage-panel manage-setup"><div class="manage-section-head"><div><h2>最初の教材をつくろう</h2><p>学習日が切り替わる時刻を設定して、はじめましょう。</p></div></div><form id="setup-form">${field('タイムゾーン',text('timeZone',Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Tokyo',true))}${field('学習日の開始時刻',`<select name="dayStart">${Array.from({length:24},(_,i)=>option(String(i),`${i}:00`,i===4)).join('')}</select>`)}<button class="primary" type="submit">教材づくりを始める</button></form></section>`;
    bindForm(content.querySelector('#setup-form')!,async data=>{await api('/setup','POST',{timeZone:String(data.get('timeZone')),dayStart:Number(data.get('dayStart'))});dirty=false;await showTab();});
  }
}
