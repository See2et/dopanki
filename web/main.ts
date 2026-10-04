import './style.css';
import { escapeHtml, normalizedAnswer, renderCard, type RenderedCard } from '../src/lib/render';
import type { DeckSummary, StudyResponse } from '../src/lib/types';
import { frameDocument } from './card-frame';
import { feverTier, formatDopa, grantReward, loadFestival, revokeReward, saveFestival, unitIndex, unitLabel, type FestivalRecord } from './festival';
import { finaleFx, payoffFx, playFanfare, playMedal, playPayoff, playUnit, primeSound, setSoundEnabled, silenceSound, soundEnabled, stopFireworks, sweepFx } from './fx';
import { friendsFor, hamColors, hamster, type Mood } from './mascot';
import { awardMedals, loadMedals, revokeMedals, saveMedals, type MedalId, type MedalRating } from './medals';
import { MEDALS, medalArt, medalCondition, medalName, metalLabel } from './medal-art';

const root = document.querySelector<HTMLDivElement>('#app')!;
let decks: DeckSummary[] = [];
let selected: string | null = sessionStorage.getItem('dopanki_deck');
let current: StudyResponse | null = null;
let front: RenderedCard | null = null;
let revealed = false;
let busy = false;
let saving = false;
let typed = '';
let lastEvent: string | null = sessionStorage.getItem('dopanki_undo');
let pending: { eventId: string; cardId: string; revision: number; rating: number } | null = null;
let imported = false;
let passwordRequired = false;
let warnings: string[] = [];
let errorMessage = '';
let generation = 0;
let deckQuery = '';
// Decorative festival state. It is kept apart from learning records and only changes after the
// review API confirms a save (or the undo API confirms an undo).
let festival = loadFestival();
/** Card whose review is saved while the following card is still loading or failed to load. */
let answeredCard: string | null = null;
let reward: FestivalRecord | null = null;
let bursting = false;
let breakTime = false;
let finale = false;
let revealing = false;
let payoffTimer = 0;
let rollFrame = 0;
let undoNote = '';
let restNote = '';
/** Self-reported outcome of the review on stage: Again means "didn't remember", 2–4 "remembered". */
type Verdict = 'recalled' | 'again';
let verdict: Verdict = 'recalled';
let resultNote: { verdict: Verdict; text: string } | null = null;
// Medal rules and progress live in medals.ts; this file only shows what it reports.
let medals = loadMedals();
let medalNotices: { eventId: string; id: MedalId }[] = [];
let medalQueue: { eventId: string; ids: MedalId[]; timer: number }[] = [];
let medalHideTimer = 0;
const breakEvery = 20;
const collapsedDecks = new Set<string>();
try {
  const saved = JSON.parse(localStorage.getItem('dopanki_collapsed_decks') || '[]');
  if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') collapsedDecks.add(id);
} catch { /* Invalid local preferences do not prevent studying. */ }
const lastDeckKey = 'dopanki_last_deck';
const readLastDeck = () => { try { return localStorage.getItem(lastDeckKey); } catch { return null; } };
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const stopAudio = () => { window.speechSynthesis?.cancel(); document.querySelectorAll('audio').forEach(audio => audio.pause()); };
function clearStage() {
  window.clearTimeout(payoffTimer); payoffTimer = 0; cancelAnimationFrame(rollFrame); stopFireworks();
  reward = null; bursting = false; breakTime = false; finale = false;
}
function stopEffects() { stopAudio(); silenceSound(); clearStage(); }
function announce(message: string) {
  const live = document.querySelector('#festival-live');
  if (live) live.textContent = message;
}

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
const deckPath = (d: DeckSummary) => d.name.replaceAll('::',' / ');
function soundButton() {
  const on = soundEnabled();
  return `<button class="sound-toggle" id="sound-toggle" aria-pressed="${on}" title="効果音と自動読み上げ（読み上げボタンはいつでも使えます）"><span class="sound-icon" aria-hidden="true"></span>音 <b>${on ? 'ON' : 'OFF'}</b></button>`;
}
function shell(content: string, mode: 'home' | 'study') {
  const chip = mode === 'home' && festival.count ? `<span class="bar-dopa" data-dopa-total="${festival.total}" title="ドパは演出用の遊びの点数です"><small>ドパ</small><b>${formatDopa(festival.total)}</b></span>` : '';
  root.innerHTML = `<header class="app-bar"><div class="app-bar-inner"><button class="brand" id="home" aria-label="デッキ一覧へ">${hamster('calm')}<span>Dopanki</span></button><div class="bar-actions">${chip}${soundButton()}<a href="/api/export" class="bar-link" title="教材と学習状態をJSONで保存">バックアップ</a>${passwordRequired ? '<button class="bar-link" id="logout">ログアウト</button>' : ''}</div></div></header><main class="${mode}">${content}</main>`;
  document.querySelector('#home')?.addEventListener('click', () => void leave());
  document.querySelector('#logout')?.addEventListener('click', () => void logout());
  document.querySelector<HTMLButtonElement>('#sound-toggle')?.addEventListener('click', event => {
    const on = !soundEnabled(); setSoundEnabled(on);
    if (on) primeSound(); else stopAudio();
    const button = event.currentTarget as HTMLButtonElement;
    button.setAttribute('aria-pressed',String(on)); button.querySelector('b')!.textContent = on ? 'ON' : 'OFF';
    announce(on ? '音をオンにしました。' : '音をオフにしました。効果音と自動読み上げを止めます。');
  });
}
function statusMarkup() { return errorMessage ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>` : ''; }
async function leave(farewell = false) {
  if (saving || pending) return;
  generation++; busy = false; answeredCard = null; undoNote = ''; resultNote = null;
  stopEffects(); clearMedalNotices();
  if (farewell) {
    restNote = `休憩タイム！ この祭りで${festival.count}枚ぶんのドパを集めました。おつかれさまです。`;
    playFanfare();
  }
  selected = null; current = null; await refresh();
}
async function logout() {
  if (saving || pending) return;
  generation++; busy = false; answeredCard = null; undoNote = ''; resultNote = null; stopEffects(); clearMedalNotices();
  await api('/api/logout', {}); sessionStorage.removeItem('dopanki_undo'); lastEvent = null; login();
}
function startDeck(id: string) {
  selected = id; sessionStorage.setItem('dopanki_deck',id); restNote = '';
  try { localStorage.setItem(lastDeckKey,id); } catch { /* Only the "続きから" shortcut needs it. */ }
  void loadCard();
}

/* ---------- Medals: notification and list ---------- */
/**
 * New medals are announced in a card over ドパハム's stage. It never takes focus or blocks keys,
 * closes itself, and can be closed with × or Esc. Several medals from one review share one card.
 */
function scheduleMedals(eventId: string, ids: MedalId[]) {
  // Each review's medals replace the previous notice (already shown), so the card never grows over the study area.
  const show = (sound: boolean) => {
    medalNotices = ids.map(id => ({ eventId, id }));
    renderMedalToast();
    if (sound) playMedal();
  };
  // Without a burst (reduced motion) the medal appears at once, before the next card silences audio.
  if (!bursting) { show(true); return; }
  const entry = { eventId, ids, timer: 0 };
  // The delayed notice still appears, but only sounds while its burst is still playing: a skip or an
  // undo has already silenced the celebration and must not be undone by this callback.
  entry.timer = window.setTimeout(() => { medalQueue = medalQueue.filter(queued => queued !== entry); show(bursting); },300);
  medalQueue.push(entry);
}
function renderMedalToast() {
  document.querySelector('#medal-toast')?.remove();
  window.clearTimeout(medalHideTimer);
  if (!medalNotices.length) return;
  const ids = medalNotices.map(notice => notice.id);
  const toast = document.createElement('div');
  toast.id = 'medal-toast'; toast.className = `medal-toast${ids.length > 2 ? ' is-many' : ''}`; toast.setAttribute('role','status');
  // Up to two medals show their condition; more are listed by name (the list has every condition).
  toast.innerHTML = `<div class="medal-toast-arts" aria-hidden="true">${ids.slice(0,3).map((id,i) => `<span class="medal-toast-art" style="--i:${i}">${medalArt(id)}</span>`).join('')}</div>
    <div class="medal-toast-text"><p class="medal-toast-title">勲章ゲット!${ids.length > 1 ? ` <span>×${ids.length}</span>` : ''}</p><ul>${ids.map(id => `<li data-medal-id="${id}"><b>${escapeHtml(medalName(id))}</b><span>${escapeHtml(medalCondition(id))}</span></li>`).join('')}</ul></div>
    <button class="medal-toast-close" aria-label="勲章の通知を閉じる">×</button>`;
  const stage = document.querySelector('#ham-stage')?.getBoundingClientRect();
  toast.style.top = `${Math.max(8,Math.round(stage ? stage.top + 6 : 72))}px`;
  toast.querySelector('button')?.addEventListener('click',hideMedalToast);
  document.body.appendChild(toast);
  medalHideTimer = window.setTimeout(hideMedalToast,4200);
}
function hideMedalToast() {
  window.clearTimeout(medalHideTimer);
  medalNotices = [];
  const toast = document.querySelector('#medal-toast');
  if (!toast) return;
  toast.removeAttribute('id'); toast.classList.add('is-leaving');
  window.setTimeout(() => toast.remove(),220);
}
/** A successful undo also withdraws its medals' pending or visible announcement. */
function withdrawMedalNotices(eventId: string) {
  for (const queued of medalQueue) if (queued.eventId === eventId) window.clearTimeout(queued.timer);
  medalQueue = medalQueue.filter(queued => queued.eventId !== eventId);
  const before = medalNotices.length;
  medalNotices = medalNotices.filter(notice => notice.eventId !== eventId);
  if (medalNotices.length !== before) { if (medalNotices.length) renderMedalToast(); else hideMedalToast(); }
}
/** Navigation and logout remove the notice at once (no exit animation lingering on the next screen). */
function clearMedalNotices() {
  for (const queued of medalQueue) window.clearTimeout(queued.timer);
  medalQueue = []; medalNotices = [];
  window.clearTimeout(medalHideTimer);
  document.querySelectorAll('.medal-toast').forEach(toast => toast.remove());
}
function medalStrip(compact = false) {
  const earned = new Set(medals.earnedIds);
  return `<section class="medal-strip${compact ? ' is-compact' : ''}" aria-label="このセッションの勲章"><div class="medal-strip-text"><p class="medal-strip-label">このセッションの勲章</p><p class="medal-strip-count"><b>${earned.size}</b> / ${MEDALS.length}</p></div>
    <div class="medal-strip-row" aria-hidden="true">${MEDALS.map(m => `<span class="mini-medal">${medalArt(m.id,earned.has(m.id))}</span>`).join('')}</div>
    <button class="secondary medal-open" id="open-medals">一覧</button></section>`;
}
function openMedalDialog() {
  document.querySelector('#medal-dialog')?.remove();
  const earned = new Set(medals.earnedIds);
  const dialog = document.createElement('dialog');
  dialog.id = 'medal-dialog'; dialog.className = 'medal-dialog'; dialog.setAttribute('aria-labelledby','medal-dialog-title');
  dialog.innerHTML = `<div class="medal-dialog-head"><div><h2 id="medal-dialog-title">このセッションの勲章</h2><p><b>${earned.size}</b> / ${MEDALS.length} 獲得 · タブを閉じると新しいセッションになります</p></div><button class="dialog-close" aria-label="閉じる">×</button></div>
    <ul class="medal-grid">${MEDALS.map(m => {
      const has = earned.has(m.id);
      return `<li class="medal-item ${has ? 'is-earned' : 'is-locked'}" data-medal="${m.id}" data-earned="${has}">${medalArt(m.id,has)}<div><p class="medal-name">${escapeHtml(m.name)}</p><p class="medal-condition">${escapeHtml(m.condition)}</p><p class="medal-state">${has ? `${metalLabel(m.id)}メダル · 獲得済み` : '未獲得'}</p></div></li>`;
    }).join('')}</ul>
    <p class="medal-note">「もう一度」は思い出せなかった、「難しい・普通・簡単」は思い出せたという自己申告として数えます。勲章とドパは遊びの記録で、学習予定には影響しません。</p>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.dialog-close')?.addEventListener('click',() => dialog.close());
  dialog.addEventListener('click',event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close',() => { dialog.remove(); document.querySelector<HTMLButtonElement>('#open-medals')?.focus(); });
  dialog.showModal();
}

/* ---------- Home: a practical Anki-style deck list ---------- */
const searchable = (s: string) => s.normalize('NFKC').toLowerCase();
function deckRows() {
  const children = new Map<string | null, DeckSummary[]>();
  for (const deck of decks) {
    const siblings = children.get(deck.parentId) || [];
    siblings.push(deck); children.set(deck.parentId,siblings);
  }
  const query = searchable(deckQuery.trim());
  let visible: Set<string> | null = null;
  if (query) {
    visible = new Set();
    const byId = new Map(decks.map(d => [d.id,d]));
    for (const deck of decks) if (searchable(deck.name).includes(query)) {
      for (let at: DeckSummary | undefined = deck; at && !visible.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) visible.add(at.id);
    }
  }
  const row = (deck: DeckSummary): string => {
    const descendants = (children.get(deck.id) || []).filter(d => !visible || visible.has(d.id));
    const collapsed = !visible && collapsedDecks.has(deck.id);
    const toggle = descendants.length && !visible
      ? `<button class="deck-toggle" data-toggle-deck="${escapeHtml(deck.id)}" aria-expanded="${!collapsed}" aria-label="${escapeHtml(deck.label)}の配下を${collapsed ? '展開' : '折りたたむ'}"><span aria-hidden="true">${collapsed ? '▸' : '▾'}</span></button>`
      : '<span class="deck-toggle-space" aria-hidden="true"></span>';
    const due = deck.counts.new + deck.counts.learning + deck.counts.review;
    return `<li class="deck-node"><div class="deck-line ${descendants.length ? 'deck-parent' : ''} ${due ? 'has-due' : ''}">
      <div class="deck-name-container" style="--depth:${deck.depth}">${toggle}
        <button class="deck-name" data-deck="${escapeHtml(deck.id)}" aria-label="${escapeHtml(deck.name)}を学習" title="${escapeHtml(deck.name)}"><span class="deck-label">${escapeHtml(deck.label)}</span><span class="deck-total">${deck.counts.total.toLocaleString()}枚${descendants.length ? ' · 配下を含む' : ''}</span></button>
      </div>
      ${(['new','learning','review'] as const).map((kind,i) => `<span class="tree-count ${kind} ${deck.counts[kind] === 0 ? 'zero-count' : ''}" aria-label="${['新規','学習','復習'][i]} ${deck.counts[kind]}枚">${deck.counts[kind]}</span>`).join('')}
    </div>${descendants.length ? `<ul class="deck-children" ${collapsed ? 'hidden' : ''}>${descendants.map(row).join('')}</ul>` : ''}</li>`;
  };
  const roots = (children.get(null) || []).filter(d => d.counts.total > 0 && (!visible || visible.has(d.id)));
  return roots.length ? roots.map(row).join('') : `<li class="deck-empty">「${escapeHtml(deckQuery.trim())}」に一致するデッキはありません</li>`;
}
function bindDeckRows() {
  document.querySelectorAll<HTMLButtonElement>('[data-deck]').forEach(button => button.addEventListener('click', () => startDeck(button.dataset.deck!)));
  document.querySelectorAll<HTMLButtonElement>('[data-toggle-deck]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.toggleDeck!;
    if (collapsedDecks.has(id)) collapsedDecks.delete(id); else collapsedDecks.add(id);
    try { localStorage.setItem('dopanki_collapsed_decks',JSON.stringify([...collapsedDecks])); } catch { /* Opening decks also works without persistent preferences. */ }
    renderDeckRows();
    [...document.querySelectorAll<HTMLButtonElement>('[data-toggle-deck]')].find(b => b.dataset.toggleDeck === id)?.focus();
  }));
}
function renderDeckRows() {
  const list = document.querySelector('#deck-tree');
  if (!list) return;
  list.innerHTML = deckRows();
  bindDeckRows();
}
function overview() {
  const roots = decks.filter(d => d.parentId === null);
  const sum = (kind: 'new' | 'learning' | 'review') => roots.reduce((n,d) => n + d.counts[kind],0);
  const today = roots.reduce((n,d) => n + d.answeredToday,0);
  const lastId = readLastDeck();
  const last = decks.find(d => d.id === lastId && d.counts.total > 0);
  const lastDue = last ? last.counts.new + last.counts.learning + last.counts.review : 0;
  const date = new Intl.DateTimeFormat('ja-JP',{ month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  shell(`<section class="home-head"><div><p class="home-date">${date}</p><h1>今日の復習</h1></div>
      ${imported ? `<dl class="due-summary" aria-label="今日の件数"><div class="new"><dt>新規</dt><dd>${sum('new')}</dd></div><div class="learning"><dt>学習</dt><dd>${sum('learning')}</dd></div><div class="review"><dt>復習</dt><dd>${sum('review')}</dd></div><div class="done"><dt>回答済み</dt><dd>${today}</dd></div></dl>` : ''}</section>
    ${restNote ? `<p class="rest-note" role="status">${hamster('happy')}<span>${escapeHtml(restNote)}</span></p>` : ''}${statusMarkup()}
    ${imported ? `${last ? `<section class="resume" aria-label="続きから"><div class="resume-text"><p class="resume-label">続きから</p><p class="resume-name">${escapeHtml(deckPath(last))}</p><p class="resume-counts">${countMarkup(last)}</p></div><button class="primary resume-start" data-resume="${escapeHtml(last.id)}">${lastDue ? '学習する' : '開く'}</button></section>` : ''}${medalStrip()}
      <section class="deck-panel"><div class="deck-panel-head"><h2>デッキ</h2><label class="deck-search"><span class="sr-only">デッキを検索</span><input id="deck-search" type="search" autocomplete="off" placeholder="デッキを検索" value="${escapeHtml(deckQuery)}"><kbd aria-hidden="true">/</kbd></label></div>
        <div class="deck-tree-heading" aria-hidden="true"><span>名前</span><span class="new">新規</span><span class="learning">学習</span><span class="review">復習</span></div>
        <ul class="deck-tree" id="deck-tree" aria-label="デッキ一覧">${deckRows()}</ul></section>`
    : `<section class="empty-import"><h2>Ankiの教材を引き継ぐ</h2><p>PCでAnkiパッケージを取り込むと、ここにデッキが表示されます。カード・学習履歴・FSRS設定を一緒に移行できます。</p><code>npm run import:anki -- /path/to/deck.apkg</code><button class="secondary" id="reload">取り込み後に更新</button></section>`}
    ${warnings.length ? `<details class="import-notes"><summary>移行時の確認事項 <span>${warnings.length}</span></summary><ul>${warnings.map(w => `<li>${escapeHtml(w.includes('global FSRS switch') ? '元データにFSRSの有効設定がないため、保存された記憶状態からFSRSを使用していると判断しました。パラメータは保持されています。' : w.includes('omits rollover') ? '元データに日付の切り替わり時刻がないため、午前4時として移行しました。Ankiで別の時刻を設定していた場合は、取り込み時に指定してください。' : w)}</li>`).join('')}</ul></details>` : ''}
    <p class="home-note">学習するとドパハムと「ドパ」が盛り上げます。ドパは演出用の遊びの点数で、どの評価でも同じだけ増え、記憶の強さや正答率は表しません。</p>`,'home');
  bindDeckRows();
  document.querySelector('[data-resume]')?.addEventListener('click', event => startDeck((event.currentTarget as HTMLElement).dataset.resume!));
  document.querySelector('#open-medals')?.addEventListener('click', openMedalDialog);
  document.querySelector<HTMLInputElement>('#deck-search')?.addEventListener('input', event => { deckQuery = (event.target as HTMLInputElement).value; renderDeckRows(); });
  document.querySelector('#reload')?.addEventListener('click', () => void refresh());
}

/* ---------- Study ---------- */
const langPattern = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const speechLang = (r: RenderedCard) => r.speech.map(s => s.lang).find(lang => langPattern.test(lang));
/** Words on Stage: a short, escaped headline taken only from what the back side reveals or speaks. */
function spotlight(back: RenderedCard): { text: string; lang?: string } | null {
  const clean = (s: string) => s.replace(/\s+/g,' ').trim();
  const expected = clean(back.typedAnswer?.expected ?? '');
  const spoken = back.speech.map(s => ({ text: clean(s.text), lang: s.lang })).filter(s => s.text);
  const text = expected || spoken.map(s => s.text).join(' / ');
  if (!text || [...text].length > 48) return null;
  const lang = expected ? spoken.find(s => normalizedAnswer(s.text) === normalizedAnswer(expected))?.lang : spoken.length === 1 ? spoken[0].lang : undefined;
  return { text, lang: lang && langPattern.test(lang) ? lang : undefined };
}
function graphemes(text: string) {
  return typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined,{ granularity: 'grapheme' }).segment(text)].map(s => s.segment) : [...text];
}
const undoDisabled = () => !lastEvent || busy || !!pending;
function syncUndo() { const button = document.querySelector<HTMLButtonElement>('#undo'); if (button) button.disabled = undoDisabled(); }
/** Approximate rendered width in em so huge inflated numbers always fit. */
function numberFit(text: string) {
  return [...text].reduce((width,ch) => width + (/[\d.,]/.test(ch) ? 0.62 : 1.04),0) + 1.6;
}
/** ドパハム's stage above the card. It only ever changes between cards; nothing moves while recalling. */
function stageStrip(mood: Mood, options: { celebrating?: boolean; newFriend?: boolean } = {}) {
  const count = festival.count;
  const friends = friendsFor(count);
  const crew = Array.from({ length: friends },(_,i) => {
    const side = i % 2 ? 'right' : 'left';
    return `<span class="crew-member ${side}${options.newFriend && i === friends - 1 ? ' is-new' : ''}" style="--slot:${Math.floor(i/2)}">${hamster(options.celebrating ? 'cheer' : i % 3 === 2 ? 'happy' : 'calm',hamColors[(i % (hamColors.length - 1)) + 1])}</span>`;
  }).join('');
  const classes = ['ham-stage',`tier-${count ? feverTier(count) : 0}`];
  if (count >= 2) classes.push('has-bunting');
  if (count >= 5) classes.push('has-rays');
  if (count >= 32) classes.push('is-fever');
  if (options.celebrating) classes.push('is-celebrating',`is-${verdict}`);
  // Recalled cards are cheered on; an honest Again is thanked and encouraged, never scolded.
  const cheers = verdict === 'again' ? ['正直でえらい!','また会おうね','次は覚えよう!','申告ありがとう!']
    : count >= 32 ? ['フィーバー!!','止まらない!','インフレだ!','ドパドパ!'] : ['思い出せた!','ナイス!','いいね!','その調子!','ドパドパ!'];
  const bubble = options.celebrating ? `<span class="crew-bubble">${cheers[count % cheers.length]}</span>` : '';
  const streak = medals.rememberedStreak;
  return `<section class="${classes.join(' ')}" id="ham-stage" aria-label="ドパの記録"><div class="stage-sky" aria-hidden="true"></div>${count >= 2 ? '<div class="bunting" aria-hidden="true"></div>' : ''}
    <div class="crew" aria-hidden="true">${crew}<span class="crew-leader">${hamster(mood)}${bubble}</span></div>
    <div class="dopa-counter" data-dopa-total="${festival.total}" title="ドパは演出用の点数です。記憶の評価ではありません。"><small>ドパ</small><b id="dopa-value">${formatDopa(festival.total)}</b></div>
    ${streak >= 2 ? `<span class="streak-pill" data-streak="${streak}" title="「思い出せた」が続いている回数"><small>連続想起</small><b>${streak}</b></span>` : ''}
    ${count >= 32 ? '<span class="fever-tag" aria-hidden="true">FEVER!!</span>' : ''}</section>`;
}
function stageMarkup() {
  const amount = reward ? formatDopa(reward.amount) : '';
  const status = breakTime ? `<p class="break-message">キリのいいところです。ここで休憩しても、続けても大丈夫。</p><div class="break-actions"><button class="primary" id="continue">続ける<kbd>Enter</kbd></button><button class="secondary" id="take-break">ここで休憩する</button></div>`
    : answeredCard && busy ? `<p class="payoff-wait" role="status">${saving ? '取り消しています…' : '次のカードを準備しています…'}</p>`
    : answeredCard ? '<button class="primary" id="retry-next">次のカードを読み込む</button><p class="payoff-wait">回答は保存済みです。もう一度評価する必要はありません。</p>' : '';
  return `<section class="card-panel payoff-panel ${breakTime ? 'is-break' : 'is-settled'}" id="payoff" aria-label="ドパ">
    ${breakTime ? `<div class="break-crew" aria-hidden="true">${[1,2,0,3,4].map(i => hamster('cheer',hamColors[i])).join('')}</div><p class="break-title">${festival.count}枚 達成!</p>` : ''}
    ${reward ? `<p class="payoff-amount" style="--fit:${numberFit(amount).toFixed(2)}"><span class="payoff-plus" aria-hidden="true">+</span><span class="payoff-value" data-dopa-amount="${reward.amount}">${amount}</span><span class="payoff-unit">ドパ</span></p>` : '<p class="payoff-saved">回答を保存しました</p>'}
    <div class="payoff-status">${status}</div></section>`;
}
function study() {
  if (!current) return;
  const card = current.card;
  const deck = decks.find(d => d.id === selected);
  const header = `<div class="study-top"><button class="back-link" id="back">← デッキ一覧</button><div class="study-deck"><span>${escapeHtml(deck ? deckPath(deck) : '')}</span><div class="counts">${deck ? countMarkup({ ...deck, counts: current.counts }) : ''}</div></div><button class="undo-button" id="undo" ${undoDisabled() ? 'disabled' : ''}>取り消す</button></div>${undoNote ? `<p class="undo-note" role="status">${escapeHtml(undoNote)}</p>` : resultNote ? `<p class="result-note is-${resultNote.verdict}" role="status">${escapeHtml(resultNote.text)}</p>` : ''}`;
  if (reward || answeredCard) {
    shell(`${header}${stageStrip(breakTime ? 'cheer' : verdict === 'again' ? 'oops' : 'happy')}${statusMarkup()}${stageMarkup()}`,'study');
    document.querySelector('#continue')?.addEventListener('click', continueStudy);
    document.querySelector('#take-break')?.addEventListener('click', () => { primeSound(); void leave(true); });
    document.querySelector('#retry-next')?.addEventListener('click', retryNext);
  } else if (!card) {
    const celebrate = finale; finale = false;
    shell(`${header}${stageStrip(celebrate ? 'cheer' : 'happy')}${statusMarkup()}<section class="card-panel finale${celebrate ? ' is-celebrating' : ''}" id="finale">
      ${celebrate ? `<div class="finale-pop" aria-hidden="true">${hamster('wow')}</div>` : ''}
      <p class="finale-title">完了!</p><h1>いまの復習は完了です</h1>
      <dl class="finale-stats"><div><dt>今日の回答</dt><dd>${current.answeredToday}<small>回</small></dd></div><div><dt>この祭りのドパ</dt><dd>${formatDopa(festival.total)}</dd></div><div><dt>ドパを集めた回数</dt><dd>${festival.count}<small>回</small></dd></div><div><dt>次の復習</dt><dd class="finale-next">${current.nextDue ? formatTime(current.nextDue) : '次の学習日'}</dd></div></dl>
      ${medalStrip(true)}
      <p class="finale-note">どの評価でも同じだけドパが入ります。ドパは記憶の強さを表しません。</p>
      <div class="finale-actions"><button class="primary" id="check-again">もう一度確認</button><button class="secondary" id="finale-home">デッキ一覧へ</button></div></section>`,'study');
    document.querySelector('#finale-home')?.addEventListener('click', () => void leave());
    document.querySelector('#open-medals')?.addEventListener('click', openMedalDialog);
    if (celebrate) {
      announce(`完了！ この祭りのドパは合計${formatDopa(festival.total)}です。`);
      playFanfare();
      if (!reducedMotion()) finaleFx(3000);
    }
  } else {
    front = renderCard(card,'front');
    const back = renderCard(card,'back',front.html);
    const rendered = revealed ? back : front;
    const inputLang = speechLang(back);
    const spot = revealed ? spotlight(back) : null;
    const matched = revealed && front.typedAnswer && typed ? normalizedAnswer(typed,front.typedAnswer.ignoreAccents) === normalizedAnswer(front.typedAnswer.expected,front.typedAnswer.ignoreAccents) : false;
    shell(`${header}${stageStrip(revealed ? 'happy' : 'calm')}${statusMarkup()}<section class="card-panel review-panel ${revealed ? 'is-answer' : 'is-question'}" id="card-panel">
      <div class="card-meta"><span class="phase-pill">${revealed ? '答え' : '問題'}</span><span class="card-state">${['新規','学習中','復習','再学習'][card.schedule.state]}</span><span class="card-deck">${escapeHtml(card.deck.name.split('::').at(-1) || '')}</span></div>
      ${spot ? `<div class="spotlight${revealing ? ' is-revealing' : ''}" id="spotlight"><span class="spotlight-word"${spot.lang ? ` lang="${escapeHtml(spot.lang)}"` : ''}>${graphemes(spot.text).map((g,i) => `<span class="g" style="--i:${i}">${escapeHtml(g)}</span>`).join('')}</span><span class="on-air" aria-hidden="true">♪ 読み上げ中</span></div>` : ''}
      ${rendered.speech.length || rendered.sounds.length ? '<div id="audio" class="audio-controls"></div>' : ''}
      <div class="card-sheet"><iframe id="card-frame" title="${revealed ? '答え' : '問題'}" sandbox="allow-same-origin"></iframe></div>
      ${!revealed && front.typedAnswer ? `<div class="type-answer"><label for="answer-input">答えを入力 <span>任意</span></label><input id="answer-input"${inputLang ? ` lang="${escapeHtml(inputLang)}"` : ''} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="思い出した答えを入力…" value="${escapeHtml(typed)}"></div>` : ''}
      ${revealed && front.typedAnswer && typed ? `<div class="answer-comparison ${matched ? 'match' : 'different'}"><span>入力した答え</span><strong>${escapeHtml(typed)}</strong><span>${matched ? '一致しています' : '正解と見比べて評価してください'}</span></div>` : ''}
      ${rendered.warnings.length ? `<details class="template-notes"><summary>テンプレートの確認事項</summary><p>${rendered.warnings.map(escapeHtml).join('<br>')}</p></details>` : ''}</section>
      <div class="review-actions" id="actions">${!revealed ? '<button class="primary reveal" id="reveal">答えを表示<kbd>Space</kbd></button>' : `<div class="ratings" role="group" aria-label="評価（どれを選んでもドパは同じです）">${(['もう一度','難しい','普通','簡単'] as const).map((label,i) => `<button class="rating" data-rating="${i+1}" aria-keyshortcuts="${i+1}" ${busy || (pending && pending.rating !== i+1) ? 'disabled' : ''}><span>${label}</span><strong>${interval(card.preview[(i+1) as 1|2|3|4].due)}</strong><small aria-hidden="true">${i+1}</small></button>`).join('')}</div><p class="rating-help">${busy ? '回答を保存しています…' : pending ? '保存を確認できませんでした。同じ評価を押して再送できます。' : '思い出せた度合いを、そのまま選んでください。どれを押してもドパは同じです。'}</p>`}</div>`,'study');
    revealing = false;
    const iframe = document.querySelector<HTMLIFrameElement>('#card-frame')!;
    iframe.addEventListener('load', () => { const height = iframe.contentDocument?.body.scrollHeight ?? 180; iframe.style.height = `${Math.max(150,height+16)}px`; });
    iframe.srcdoc = frameDocument(rendered);
    document.querySelector<HTMLInputElement>('#answer-input')?.addEventListener('input', e => { typed = (e.target as HTMLInputElement).value; });
    document.querySelector('#reveal')?.addEventListener('click', () => {
      typed = document.querySelector<HTMLInputElement>('#answer-input')?.value ?? typed; revealed = true; revealing = true; stopAudio(); study();
      if (soundEnabled()) playAudio(renderCard(card,'back',front!.html));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-rating]').forEach(button => button.addEventListener('click', () => void answer(Number(button.dataset.rating))));
    audioControls(rendered);
  }
  document.querySelector('#back')?.addEventListener('click', () => void leave());
  document.querySelector('#undo')?.addEventListener('click', () => void undo());
  document.querySelector('#check-again')?.addEventListener('click', () => void loadCard());
}
const center = (element: Element | null) => {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
/** Rolls the counter up like a slot machine; the exact total is already in data-dopa-total. */
function rollCounter(from: number, to: number, ms: number) {
  const value = document.querySelector<HTMLElement>('#dopa-value');
  if (!value) return;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1,(now - start) / ms);
    // Interpolate digits, not values, so 万→京 jumps feel like inflation instead of a sudden snap.
    const a = Math.log10(Math.max(1,from)); const b = Math.log10(Math.max(1,to));
    value.textContent = formatDopa(p < 1 ? 10 ** (a + (b - a) * (1 - (1 - p) ** 3)) : to);
    if (p < 1) rollFrame = requestAnimationFrame(step);
  };
  rollFrame = requestAnimationFrame(step);
}
/**
 * The post-rating burst happens on the card that was just rated: the rating row turns into the
 * reward, the card is stamped, coins fly into the counter and ドパハム's crew celebrates.
 */
function startBurst(record: FestivalRecord, unit: string | null, duration: number) {
  const tier = feverTier(festival.count);
  const amount = formatDopa(record.amount);
  const newFriend = friendsFor(festival.count) > friendsFor(record.prevCount);
  const again = verdict === 'again';
  document.querySelector('#ham-stage')?.insertAdjacentHTML('afterend',stageStrip(again ? 'oops' : 'cheer',{ celebrating: true, newFriend }));
  document.querySelector('#ham-stage')?.remove();
  const panel = document.querySelector('#card-panel');
  panel?.classList.add(again ? 'is-shaken' : 'is-stamped');
  // The stamp says what the learner reported; the amount, coins and length stay the same either way.
  const stamp = again ? '<div class="stamp is-again" aria-hidden="true"><b>また</b><span>会おう</span></div>' : '<div class="stamp" aria-hidden="true"><b>◎</b><span>思い出せた</span></div>';
  panel?.insertAdjacentHTML('beforeend',`${stamp}<div class="float-amount" aria-hidden="true">+${amount}</div>`);
  const streak = medals.rememberedStreak;
  const label = again ? '<span class="payoff-verdict">正直に申告 · また出題されます</span>' : `<span class="payoff-verdict">思い出せた!${streak >= 2 ? ` <b>${streak}連続</b>` : ''}</span>`;
  const actions = document.querySelector('#actions');
  if (actions) actions.innerHTML = `<div class="payoff-chip is-bursting is-${verdict}" id="payoff" data-verdict="${verdict}" style="--fit:${numberFit(amount).toFixed(2)}"><div class="payoff-main">${label}<p class="payoff-amount"><span class="payoff-plus" aria-hidden="true">+</span><span class="payoff-value" data-dopa-amount="${record.amount}">${amount}</span><span class="payoff-unit">ドパ</span></p></div><button class="skip-button" id="skip-payoff">次へ<kbd>Space</kbd></button></div>`;
  document.querySelector('#skip-payoff')?.addEventListener('click', settlePayoff);
  panel?.addEventListener('click', settlePayoff);
  rollCounter(record.prevTotal,festival.total,Math.min(900,duration * 0.6));
  payoffFx({ origin: center(panel?.querySelector('.stamp') ?? panel ?? null) ?? { x: innerWidth / 2, y: innerHeight / 2 }, target: center(document.querySelector('.dopa-counter')), tier, duration, unit, big: breakTime, again });
}
/** Called when the burst ends or is skipped; the next card then appears and stays still. */
function settlePayoff() {
  window.clearTimeout(payoffTimer); payoffTimer = 0;
  if (!bursting) return;
  bursting = false; cancelAnimationFrame(rollFrame); stopFireworks();
  const nextCard = !answeredCard && !!current?.card && !breakTime;
  const pause = !answeredCard && breakTime && !!current?.card;
  if (!answeredCard && !pause) quietNextCard();
  study();
  if (nextCard && !reducedMotion()) sweepFx(`${festival.count + 1}枚目`,center(document.querySelector('#ham-stage'))?.y ?? 120);
  if (pause) { playFanfare(); if (!reducedMotion()) finaleFx(2200); }
}
/** Leaving the payoff: celebration sound must not carry over into the next recall. */
function quietNextCard() {
  reward = null; breakTime = false;
  silenceSound();
}
function continueStudy() {
  breakTime = false;
  stopFireworks();
  if (!answeredCard) quietNextCard();
  study();
}
function retryNext() {
  if (busy) return;
  void loadCard(); study();
}
function celebrate(eventId: string, outcome: Verdict) {
  const granted = grantReward(festival,eventId);
  if (!granted) return;
  festival = granted.festival; saveFestival(festival);
  reward = granted.record; verdict = outcome;
  breakTime = festival.count % breakEvery === 0;
  bursting = !reducedMotion();
  const crossed = unitIndex(festival.total) > unitIndex(reward.prevTotal) ? unitLabel(unitIndex(festival.total)) : null;
  const tier = feverTier(festival.count);
  const said = outcome === 'again' ? '正直に申告。また出題されます。' : `思い出せた!${medals.rememberedStreak >= 2 ? ` ${medals.rememberedStreak}連続。` : ''}`;
  announce(`${said} +${formatDopa(reward.amount)}ドパ。合計${formatDopa(festival.total)}ドパ。${crossed ? `${crossed}突破。` : ''}`);
  // Reduced motion skips the burst, so the next card carries a still one-line result instead.
  resultNote = bursting ? null : { verdict: outcome, text: `前の回答: ${said} +${formatDopa(reward.amount)}ドパ` };
  playPayoff(tier,breakTime,outcome === 'again');
  if (crossed) playUnit();
  if (bursting) {
    const duration = 1000 + tier * 120 + (crossed ? 250 : 0) + (breakTime ? 500 : 0);
    startBurst(reward,crossed,duration);
    payoffTimer = window.setTimeout(settlePayoff,duration);
  } else if (breakTime) study();
}
function speak(rendered: RenderedCard) {
  if (!('speechSynthesis' in window)) { errorMessage = 'このブラウザは読み上げに対応していません。'; study(); return; }
  speechSynthesis.cancel();
  const onAir = (on: boolean) => document.querySelector('#spotlight')?.classList.toggle('is-speaking',on);
  for (const speech of rendered.speech) {
    const utterance = new SpeechSynthesisUtterance(speech.text);
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find(v => speech.voices.includes(v.name)) ?? voices.find(v => v.lang.toLowerCase().replaceAll('_','-') === speech.lang.toLowerCase()) ?? voices.find(v => v.lang.split('-')[0] === speech.lang.split('-')[0]) ?? null;
    utterance.lang = speech.lang; utterance.rate = speech.rate;
    utterance.onstart = () => onAir(true);
    utterance.onend = () => onAir(false);
    utterance.onerror = event => { onAir(false); if (!['interrupted','canceled'].includes(event.error)) { const audio = document.querySelector('#audio'); if (audio) audio.insertAdjacentHTML('beforeend','<span class="audio-error" role="status">読み上げできませんでした。端末の音声設定を確認してください。</span>'); } };
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
    if (answeredCard && reward && !response.card) finale = true;
    answeredCard = null;
    // The burst (or a break the user has not answered yet) keeps the stage; the next card waits.
    if (reward && (bursting || (breakTime && response.card))) { syncUndo(); return; }
    // Includes the immediate reduced-motion transition, which never shows the stage at all.
    if (reward) quietNextCard(); else breakTime = false;
    study();
  } catch (e) {
    if (request !== generation) return;
    busy = false; errorMessage = (e as Error).message;
    if (bursting) { syncUndo(); return; }
    if (current) study(); else overview();
  }
}
async function answer(rating: number) {
  if (busy || answeredCard || !revealed || !current?.card || (pending && pending.rating !== rating)) return;
  primeSound();
  const card = current.card;
  pending ??= { eventId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')}`, cardId: card.id, revision: card.revision, rating };
  busy = true; saving = true; errorMessage = ''; undoNote = ''; resultNote = null; study();
  try {
    await api('/api/review',pending);
    const eventId = pending.eventId; const rated = pending.rating as MedalRating;
    lastEvent = eventId; sessionStorage.setItem('dopanki_undo',lastEvent);
    pending = null; saving = false; stopAudio();
    // Only a confirmed save reaches this point, so failures and 409 never earn festival points or
    // medals; medals.ts ignores an event it has already seen (a retried save).
    const awarded = awardMedals(medals,eventId,rated);
    if (awarded.state !== medals) { medals = awarded.state; saveMedals(medals); }
    answeredCard = card.id;
    celebrate(eventId,rated === 1 ? 'again' : 'recalled');
    if (awarded.newIds.length) scheduleMedals(eventId,awarded.newIds);
    await loadCard();
  } catch (e) {
    saving = false;
    if (e instanceof ApiError && e.status === 409) { pending = null; await loadCard(); }
    busy = false; errorMessage = (e as Error).message; study();
  }
}
async function undo() {
  if (!lastEvent || busy || pending) return;
  const eventId = lastEvent;
  // Silenced before the request, so a pending or failed undo is quiet too.
  stopEffects();
  busy = true; saving = true; errorMessage = ''; undoNote = ''; study();
  try {
    await api('/api/undo',{ eventId }); lastEvent = null; sessionStorage.removeItem('dopanki_undo');
    const revoked = revokeReward(festival,eventId);
    if (revoked) { festival = revoked.festival; saveFestival(festival); }
    // Only a confirmed undo reaches this point; a failed undo keeps every medal.
    const unmedalled = revokeMedals(medals,eventId);
    if (unmedalled.state !== medals) { medals = unmedalled.state; saveMedals(medals); }
    withdrawMedalNotices(eventId);
    resultNote = null;
    undoNote = revoked ? `取り消しました。${formatDopa(revoked.record.amount)}ドパも戻しました。` : '取り消しました。';
    announce(undoNote);
    saving = false; answeredCard = null;
    await loadCard();
  }
  catch (e) { saving = false; busy = false; errorMessage = (e as Error).message; study(); }
}
function login(message = '') {
  stopEffects();
  root.innerHTML = `<div class="login-page"><div class="login-card"><div class="login-mascot">${hamster('happy')}</div><h1 class="login-brand">Dopanki</h1><p class="subtle">あなたの教材と、学習の続き。</p><form id="login-form"><label for="password">パスワード</label><input id="password" type="password" autocomplete="current-password" required autofocus><button class="primary" type="submit">ログイン</button><p class="error" role="alert">${escapeHtml(message)}</p></form></div></div>`;
  document.querySelector('#login-form')?.addEventListener('submit', async e => {
    e.preventDefault(); const button = document.querySelector<HTMLButtonElement>('#login-form button')!; button.disabled = true;
    try { await api('/api/login', { password: document.querySelector<HTMLInputElement>('#password')!.value }); await refresh(); }
    catch (error) { login((error as Error).message); }
  });
}
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement;
  const input = target.tagName === 'INPUT';
  // The medal list is a modal dialog: it handles its own keys (Esc closes it).
  if (document.querySelector('#medal-dialog[open]')) return;
  if (e.key === 'Escape' && document.querySelector('#medal-toast')) { hideMedalToast(); return; }
  if (!current && e.key === '/' && !input) {
    const search = document.querySelector<HTMLInputElement>('#deck-search');
    if (search) { e.preventDefault(); search.focus(); }
    return;
  }
  if (current && (reward || answeredCard)) {
    // The payoff only listens for Space/Enter to move on; rating keys are ignored.
    if (!(e.key === 'Enter' || e.code === 'Space') || input || target.closest?.('button,a,summary')) return;
    if (bursting) { e.preventDefault(); settlePayoff(); }
    else if (breakTime) { e.preventDefault(); continueStudy(); }
    else if (answeredCard && !busy) { e.preventDefault(); retryNext(); }
    return;
  }
  if (busy || !current?.card) return;
  if (!revealed && (e.key === 'Enter' || (!input && e.code === 'Space'))) { e.preventDefault(); document.querySelector<HTMLButtonElement>('#reveal')?.click(); }
  else if (revealed && !input && /^[1-4]$/.test(e.key)) { e.preventDefault(); void answer(Number(e.key)); }
});
root.innerHTML = '<div class="loading" role="status">Dopankiを読み込んでいます…</div>';
try { const session = await api<{ authenticated: boolean; passwordRequired: boolean }>('/api/session'); passwordRequired = session.passwordRequired; if (session.authenticated) await refresh(); else login(); }
catch (e) { login((e as Error).message); }
