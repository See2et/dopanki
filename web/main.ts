import './style.css';
import { escapeHtml, normalizedAnswer, renderCard, type RenderedCard } from '../src/lib/render';
import type { DeckSummary, StudyResponse } from '../src/lib/types';
import { frameDocument } from './card-frame';

const root = document.querySelector<HTMLDivElement>('#app')!;
let decks: DeckSummary[] = [];
let selected: string | null = sessionStorage.getItem('dopanki_deck');
let current: StudyResponse | null = null;
let front: RenderedCard | null = null;
let revealed = false;
let busy = false;
let typed = '';
let lastEvent: string | null = sessionStorage.getItem('dopanki_undo');
let pending: { eventId: string; cardId: string; revision: number; rating: number } | null = null;
let imported = false;
let passwordRequired = false;
let warnings: string[] = [];
let errorMessage = '';
let generation = 0;
const collapsedDecks = new Set<string>();
try {
  const saved = JSON.parse(localStorage.getItem('dopanki_collapsed_decks') || '[]');
  if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') collapsedDecks.add(id);
} catch { /* Invalid local preferences do not prevent studying. */ }
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
const stopAudio = () => window.speechSynthesis?.cancel();

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error || '通信に失敗しました。',response.status);
  return data;
}
function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp);
}
function interval(due: number) {
  const minutes = Math.max(1,Math.round((due-Date.now())/60000));
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 1440) return `${Math.round(minutes/60)}時間`;
  const days = Math.round(minutes/1440);
  return days < 365 ? `${days}日` : `${(days/365).toFixed(1)}年`;
}
function countMarkup(d: DeckSummary) {
  return `<span class="count new">新規 <b>${d.counts.new}</b></span><span class="count learning">学習 <b>${d.counts.learning}</b></span><span class="count review">復習 <b>${d.counts.review}</b></span>`;
}
function shell(content: string) {
  root.innerHTML = `<header class="app-header"><button class="brand" id="home" aria-label="デッキ一覧へ">Dopanki<span>FSRS STUDY</span></button><div class="header-actions"><a href="/api/export" class="quiet-link" title="教材と学習状態をJSONで保存">バックアップ</a>${passwordRequired ? '<button class="icon-button" id="logout">ログアウト</button>' : ''}</div></header><main>${content}</main><footer class="app-footer">少しずつ、覚えていく。<span>FSRS · Online</span></footer>`;
  document.querySelector('#home')?.addEventListener('click', async () => { if (busy || pending) return; selected = null; current = null; stopAudio(); await refresh(); });
  document.querySelector('#logout')?.addEventListener('click', async () => { if (busy || pending) return; await api('/api/logout', {}); sessionStorage.removeItem('dopanki_undo'); lastEvent = null; login(); });
}
function statusMarkup() { return errorMessage ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>` : ''; }
function deckTree() {
  const children = new Map<string | null, DeckSummary[]>();
  for (const deck of decks) {
    const siblings = children.get(deck.parentId) || [];
    siblings.push(deck); children.set(deck.parentId,siblings);
  }
  const row = (deck: DeckSummary): string => {
    const descendants = children.get(deck.id) || [];
    const collapsed = collapsedDecks.has(deck.id);
    return `<li class="deck-node"><div class="deck-line ${descendants.length ? 'deck-parent' : ''}">
      <div class="deck-name-container" style="--depth:${deck.depth}">
        ${descendants.length ? `<button class="deck-toggle" data-toggle-deck="${escapeHtml(deck.id)}" aria-expanded="${!collapsed}" aria-label="${escapeHtml(deck.label)}の配下を${collapsed ? '展開' : '折りたたむ'}">${collapsed ? '+' : '−'}</button>` : '<span class="deck-toggle-space" aria-hidden="true"></span>'}
        <button class="deck-name" data-deck="${escapeHtml(deck.id)}" aria-label="${escapeHtml(deck.name)}を学習" title="${escapeHtml(deck.name)}"><span class="deck-label">${escapeHtml(deck.label)}</span><span class="deck-total">${deck.counts.total.toLocaleString()}枚${descendants.length ? ' · 配下を含む' : ''}</span></button>
      </div>
      ${(['new','learning','review'] as const).map((kind,i) => `<span class="tree-count ${kind} ${deck.counts[kind] === 0 ? 'zero-count' : ''}" aria-label="${['新規','学習','復習'][i]} ${deck.counts[kind]}枚">${deck.counts[kind]}</span>`).join('')}
    </div>${descendants.length ? `<ul class="deck-children" ${collapsed ? 'hidden' : ''}>${descendants.map(row).join('')}</ul>` : ''}</li>`;
  };
  return `<div class="deck-tree-panel"><div class="deck-tree-heading" aria-hidden="true"><span>デッキ</span><span class="new">新規</span><span class="learning">学習</span><span class="review">復習</span></div><ul class="deck-tree" aria-label="デッキ一覧">${(children.get(null) || []).filter(d => d.counts.total > 0).map(row).join('')}</ul></div>`;
}
function overview() {
  shell(`<section class="page-heading"><div><p class="eyebrow">YOUR COLLECTION</p><h1>今日の復習</h1><p class="subtle">覚えたことを、少しずつ確かなものに。</p></div><div class="today-badge"><strong>${decks.filter(d => d.parentId === null).reduce((n,d) => n+d.answeredToday,0)}</strong><span>今日の回答</span></div></section>${statusMarkup()}
    ${imported ? deckTree() : `<section class="empty"><h2>Ankiの教材を引き継ぐ</h2><p>PCでAnkiパッケージを取り込むと、ここにデッキが表示されます。</p><p class="subtle">カード・学習履歴・FSRS設定を一緒に移行できます。</p><code>npm run import:anki -- /path/to/deck.apkg</code><button class="secondary" id="reload">取り込み後に更新</button></section>`}
    ${warnings.length ? `<details class="import-notes"><summary>移行時の確認事項 <span>${warnings.length}</span></summary><ul>${warnings.map(w => `<li>${escapeHtml(w.includes('global FSRS switch') ? '元データにFSRSの有効設定がないため、保存された記憶状態からFSRSを使用していると判断しました。パラメータは保持されています。' : w.includes('omits rollover') ? '元データに日付の切り替わり時刻がないため、午前4時として移行しました。Ankiで別の時刻を設定していた場合は、取り込み時に指定してください。' : w)}</li>`).join('')}</ul></details>` : ''}`);
  document.querySelectorAll<HTMLButtonElement>('[data-deck]').forEach(button => button.addEventListener('click', () => { selected = button.dataset.deck!; sessionStorage.setItem('dopanki_deck',selected); void loadCard(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-toggle-deck]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.toggleDeck!;
    if (collapsedDecks.has(id)) collapsedDecks.delete(id); else collapsedDecks.add(id);
    try { localStorage.setItem('dopanki_collapsed_decks',JSON.stringify([...collapsedDecks])); } catch { /* Opening decks also works without persistent preferences. */ }
    overview();
    [...document.querySelectorAll<HTMLButtonElement>('[data-toggle-deck]')].find(b => b.dataset.toggleDeck === id)?.focus();
  }));
  document.querySelector('#reload')?.addEventListener('click', () => void refresh());
}
function study() {
  if (!current) return;
  const card = current.card;
  const deck = decks.find(d => d.id === selected);
  const header = `<div class="study-heading"><button class="back-link" id="back">← デッキ一覧</button><div class="study-deck"><span>${escapeHtml(deck?.name.replaceAll('::',' / ') || '')}</span><div class="counts">${deck ? countMarkup({ ...deck, counts: current.counts }) : ''}</div></div><button class="undo-button" id="undo" ${!lastEvent || busy || pending ? 'disabled' : ''}>取り消す</button></div>`;
  if (!card) {
    shell(`${header}${statusMarkup()}<section class="empty finished"><span class="finished-mark" aria-hidden="true">✓</span><p class="eyebrow">SESSION COMPLETE</p><h1>いまの復習は完了です</h1><p>今日ここまでに <strong>${current.answeredToday}回</strong> 回答しました。</p>${current.nextDue ? `<p class="subtle">次の復習予定：${formatTime(current.nextDue)}</p>` : '<p class="subtle">また次の学習日に続けましょう。</p>'}<button class="primary" id="check-again">もう一度確認</button></section>`);
  } else {
    front = renderCard(card,'front');
    const rendered = revealed ? renderCard(card,'back',front.html) : front;
    shell(`${header}${statusMarkup()}<section class="review-panel"><div class="card-meta"><span>${revealed ? 'ANSWER' : 'QUESTION'}</span><span>${['新規','学習中','復習','再学習'][card.schedule.state]}</span></div><iframe id="card-frame" title="${revealed ? '答え' : '問題'}" sandbox="allow-same-origin"></iframe>
      ${!revealed && front.typedAnswer ? `<div class="type-answer"><label for="answer-input">答えを入力 <span>任意</span></label><input id="answer-input" lang="ko" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="思い出した答えを入力…" value="${escapeHtml(typed)}"></div>` : ''}
      ${revealed && front.typedAnswer && typed ? `<div class="answer-comparison ${normalizedAnswer(typed,front.typedAnswer.ignoreAccents) === normalizedAnswer(front.typedAnswer.expected,front.typedAnswer.ignoreAccents) ? 'match' : 'different'}"><span>入力した答え</span><strong>${escapeHtml(typed)}</strong><span>${normalizedAnswer(typed,front.typedAnswer.ignoreAccents) === normalizedAnswer(front.typedAnswer.expected,front.typedAnswer.ignoreAccents) ? '一致しています' : '正解と見比べて評価してください'}</span></div>` : ''}
      ${rendered.speech.length || rendered.sounds.length ? '<div id="audio" class="audio-controls"></div>' : ''}
      ${rendered.warnings.length ? `<details class="template-notes"><summary>テンプレートの確認事項</summary><p>${rendered.warnings.map(escapeHtml).join('<br>')}</p></details>` : ''}</section>
      <div class="review-actions">${!revealed ? '<button class="primary reveal" id="reveal">答えを表示<span>Space / Enter</span></button>' : `<div class="ratings">${(['もう一度','難しい','普通','簡単'] as const).map((label,i) => `<button class="rating rating-${i+1}" data-rating="${i+1}" ${busy || (pending && pending.rating !== i+1) ? 'disabled' : ''}><span>${label}</span><strong>${interval(card.preview[(i+1) as 1|2|3|4].due)}</strong><small>${i+1}</small></button>`).join('')}</div><p class="rating-help">${busy ? '回答を保存しています…' : pending ? '保存を確認できませんでした。同じ評価を押して再送できます。' : '思い出せた度合いを選んでください。'}</p>`}</div>`);
    const iframe = document.querySelector<HTMLIFrameElement>('#card-frame')!;
    iframe.addEventListener('load', () => { const height = iframe.contentDocument?.body.scrollHeight ?? 180; iframe.style.height = `${Math.max(150,height+16)}px`; });
    iframe.srcdoc = frameDocument(rendered);
    document.querySelector<HTMLInputElement>('#answer-input')?.addEventListener('input', e => { typed = (e.target as HTMLInputElement).value; });
    document.querySelector('#reveal')?.addEventListener('click', () => { typed = document.querySelector<HTMLInputElement>('#answer-input')?.value ?? typed; revealed = true; stopAudio(); study(); playAudio(renderCard(card,'back',front!.html)); });
    document.querySelectorAll<HTMLButtonElement>('[data-rating]').forEach(button => button.addEventListener('click', () => void answer(Number(button.dataset.rating))));
    audioControls(rendered);
  }
  document.querySelector('#back')?.addEventListener('click', async () => { if (busy || pending) return; selected = null; current = null; stopAudio(); await refresh(); });
  document.querySelector('#undo')?.addEventListener('click', () => void undo());
  document.querySelector('#check-again')?.addEventListener('click', () => void loadCard());
}
function speak(rendered: RenderedCard) {
  if (!('speechSynthesis' in window)) { errorMessage = 'このブラウザは読み上げに対応していません。'; study(); return; }
  speechSynthesis.cancel();
  for (const speech of rendered.speech) {
    const utterance = new SpeechSynthesisUtterance(speech.text);
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find(v => speech.voices.includes(v.name)) ?? voices.find(v => v.lang.toLowerCase().replaceAll('_','-') === speech.lang.toLowerCase()) ?? voices.find(v => v.lang.split('-')[0] === speech.lang.split('-')[0]) ?? null;
    utterance.lang = speech.lang; utterance.rate = speech.rate;
    utterance.onerror = event => { if (!['interrupted','canceled'].includes(event.error)) { const audio = document.querySelector('#audio'); if (audio) audio.insertAdjacentHTML('beforeend','<span class="audio-error" role="status">読み上げできませんでした。端末の音声設定を確認してください。</span>'); } };
    speechSynthesis.speak(utterance);
  }
}
function playAudio(rendered: RenderedCard) {
  if (rendered.speech.length) speak(rendered);
  else document.querySelector<HTMLAudioElement>('#audio audio')?.play().catch(() => {});
}
function audioControls(rendered: RenderedCard) {
  const container = document.querySelector<HTMLDivElement>('#audio'); if (!container) return;
  if (rendered.speech.length) {
    container.innerHTML = '<button class="audio-button" id="speak">▶ 読み上げる</button><span>端末の音声を使用</span>';
    document.querySelector('#speak')?.addEventListener('click', () => speak(rendered));
  }
  for (const sound of rendered.sounds) {
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `/media/${encodeURIComponent(sound)}`; container.appendChild(audio);
  }
}
async function refresh() {
  try {
    const data = await api<{ imported: boolean; decks: DeckSummary[]; warnings: string[] }>('/api/overview');
    decks = data.decks; imported = data.imported; warnings = data.warnings;
    if (selected && decks.some(d => d.id === selected)) await loadCard(); else { selected = null; overview(); }
  } catch (e) { errorMessage = (e as Error).message; overview(); }
}
async function loadCard() {
  if (!selected) return;
  const request = ++generation;
  busy = true; errorMessage = '';
  try {
    const response = await api<StudyResponse>(`/api/study/${encodeURIComponent(selected)}`);
    if (request !== generation) return;
    current = response; revealed = false; typed = ''; pending = null; busy = false;
    study();
  } catch (e) { busy = false; errorMessage = (e as Error).message; if (current) study(); else overview(); }
}
async function answer(rating: number) {
  if (busy || !revealed || !current?.card || (pending && pending.rating !== rating)) return;
  const card = current.card;
  pending ??= { eventId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')}`, cardId: card.id, revision: card.revision, rating };
  busy = true; errorMessage = ''; study();
  try {
    await api('/api/review',pending);
    lastEvent = pending.eventId; sessionStorage.setItem('dopanki_undo',lastEvent);
    pending = null; stopAudio(); await loadCard();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) { pending = null; await loadCard(); }
    busy = false; errorMessage = (e as Error).message; study();
  }
}
async function undo() {
  if (!lastEvent || busy || pending) return;
  busy = true; errorMessage = ''; study();
  try { await api('/api/undo',{ eventId: lastEvent }); lastEvent = null; sessionStorage.removeItem('dopanki_undo'); await loadCard(); }
  catch (e) { busy = false; errorMessage = (e as Error).message; study(); }
}
function login(message = '') {
  root.innerHTML = `<div class="login-page"><div class="login-brand">Dopanki</div><p class="subtle">あなたの教材と、学習の続き。</p><form id="login-form"><label for="password">パスワード</label><input id="password" type="password" autocomplete="current-password" required autofocus><button class="primary" type="submit">ログイン</button><p class="error" role="alert">${escapeHtml(message)}</p></form></div>`;
  document.querySelector('#login-form')?.addEventListener('submit', async e => {
    e.preventDefault(); const button = document.querySelector<HTMLButtonElement>('#login-form button')!; button.disabled = true;
    try { await api('/api/login', { password: document.querySelector<HTMLInputElement>('#password')!.value }); await refresh(); }
    catch (error) { login((error as Error).message); }
  });
}
document.addEventListener('keydown', e => {
  if (busy || !current?.card || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const input = (e.target as HTMLElement).tagName === 'INPUT';
  if (!revealed && (e.key === 'Enter' || (!input && e.code === 'Space'))) { e.preventDefault(); document.querySelector<HTMLButtonElement>('#reveal')?.click(); }
  else if (revealed && !input && /^[1-4]$/.test(e.key)) { e.preventDefault(); void answer(Number(e.key)); }
});
root.innerHTML = '<div class="loading" role="status">Dopankiを読み込んでいます…</div>';
try { const session = await api<{ authenticated: boolean; passwordRequired: boolean }>('/api/session'); passwordRequired = session.passwordRequired; if (session.authenticated) await refresh(); else login(); }
catch (e) { login((e as Error).message); }
