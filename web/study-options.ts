import { escapeHtml } from '../src/lib/render';
import { practiceRequestId } from './practice';
import { ApiError } from './http';
import type { StudyOptionsResponse, RestartPreview } from '../src/lib/study-options-types';

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Kind = 'new' | 'review';
type Mutation = { path: string; body: Record<string, unknown>; kind: Kind | 'restart' | 'state' };
const unresolved = new Map<string, Mutation>();
const count = (n: number) => n.toLocaleString('ja-JP');
const day = (date: string) => { const [,month,dateOfMonth] = date.split('-'); return `${Number(month)}月${Number(dateOfMonth)}日`; };
export const studyOptionsPath = (id: string) => `/api/study-options/${encodeURIComponent(id)}`;

export function restartStatusMarkup(options: StudyOptionsResponse | null): string {
  const r = options?.restart;
  if (!r) return '';
  const done = r.backlogTotal - r.backlogRemaining;
  return `<section class="restart-status" aria-label="再開モードの状況"><div><strong>再開モード${r.paused ? ' · 一時停止中' : ' · 継続中'}</strong><p>たまった復習 ${count(done)} / ${count(r.backlogTotal)}枚完了 · 残り${count(r.backlogRemaining)}枚</p><p>1日の復習目標 ${count(options!.limits.review)}枚 · たまった分は最大${count(r.backlogPerDay + options!.extra.review)}枚${r.paused ? '' : ` · 新規は1日${count(r.dailyNewLimit)}枚`}</p></div><button class="secondary" data-study-options>ペースを確認</button></section>`;
}
export function completionOptionsMarkup(options: StudyOptionsResponse | null): string {
  if (!options) return '<p class="study-options-help">今日の目標と残りのカードを確認できます。</p><button class="secondary" data-study-options>今日の学習を調整</button>';
  return `${options.restart && !options.restart.paused && options.restart.backlogRemaining > 0 ? `<p class="study-options-help">たまった復習は残り${count(options.restart.backlogRemaining)}枚です。残りは再開モードの日程に沿って出題します。</p>` : ''}<section class="completion-options" aria-label="今日の学習を追加"><p>今日の目標：新規${count(options.limits.new)}枚 · 復習${count(options.limits.review)}枚</p><p>まだ学習できるカード：新規${count(options.available.new)}枚 · 期限を迎えた復習${count(options.available.review)}枚</p><div class="study-options-actions"><button class="secondary" data-extra="new">新規を追加</button><button class="secondary" data-extra="review">復習を追加</button><button class="secondary" data-study-options>再開ペースを調整</button></div></section>`;
}
export function completionTitle(options: StudyOptionsResponse | null, answeredToday: number): string {
  if (!options) return 'いまの復習は完了です';
  if (options.restart && !options.restart.paused && options.restart.backlogRemaining > 0) return answeredToday > 0 ? '今日の予定は完了です' : '今日の予定を確認しましょう';
  return options.available.new + options.available.review > 0 ? (answeredToday > 0 ? '今日の目標を達成しました' : '今日の出題上限に達しています') : 'いま復習できるカードはありません';
}

/** A failed save retains its request identity, including when the dialog is reopened. */
export function openStudyOptions(deckId: string, name: string, api: Api, changed: (startStudy?: boolean) => Promise<void>, initialKind?: Kind): void {
  if (document.querySelector('.study-options-dialog')) return;
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'study-options-dialog'; dialog.setAttribute('aria-labelledby','study-options-title');
  dialog.innerHTML = `<div class="study-options-heading"><div><p class="study-options-deck">${escapeHtml(name.replaceAll('::',' / '))}</p><h2 id="study-options-title">今日の学習を調整</h2></div><button type="button" class="secondary" data-close>閉じる</button></div><div data-content><p role="status">学習状況を確認しています…</p></div><p class="error" role="alert" data-error></p>`;
  document.body.appendChild(dialog);
  let options: StudyOptionsResponse | null = null; let preview: RestartPreview | null = null;
  let busy = false; let draft = {dailyReviewLimit: '100',dailyNewLimit: '5',backlogPerDay: '20',flatten: false};
  let newLimitDraft: string | null = null;
  const extraDraft = {new: '', review: ''};
  const previous = unresolved.get(deckId);
  if(previous?.body.action === 'set-new-limit') newLimitDraft = String(previous.body.dailyNewLimit);
  if (previous?.kind === 'restart') draft = {dailyNewLimit:String(previous.body.dailyNewLimit??0),dailyReviewLimit:String(previous.body.dailyReviewLimit),backlogPerDay:String(previous.body.backlogPerDay),flatten:Boolean(previous.body.flatten)};
  const error = dialog.querySelector<HTMLElement>('[data-error]')!;
  const content = dialog.querySelector<HTMLElement>('[data-content]')!;
  const close = () => { if (busy) return; dialog.close(); dialog.remove(); if (opener?.isConnected) opener.focus(); };
  dialog.querySelector('[data-close]')!.addEventListener('click',close);
  dialog.addEventListener('cancel',event => {event.preventDefault();close();});
  const setBusy = (value: boolean) => { busy = value; dialog.setAttribute('aria-busy',String(value)); dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => el.disabled = value); if (!value) { content.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-disabled]').forEach(el => el.disabled = true); lockUnresolved(); } };
  const lockUnresolved = () => {
    const mutation = unresolved.get(deckId);
    if (mutation) content.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = !el.matches('[data-retry-save],[data-retry-load]'); });
  };
  const save = async (mutation: Mutation) => {
    unresolved.set(deckId,mutation); setBusy(true); error.textContent = ''; let committed = false;
    try {
      await api(mutation.path,mutation.body); committed = true; unresolved.delete(deckId); preview = null; newLimitDraft = null;
      options = await api<StudyOptionsResponse>(studyOptionsPath(deckId)); render();
      await changed(mutation.kind === 'new' || mutation.kind === 'review');
      if (mutation.kind === 'new' || mutation.kind === 'review') {busy = false; close(); return;}
      error.textContent = ''; const status = content.querySelector<HTMLElement>('[data-saved]'); if (status) status.textContent = '保存しました。';
    } catch (e) {
      if (committed) { content.innerHTML = '<p>保存しました。最新の学習状況を読み込めませんでした。</p><button class="secondary" data-retry-load>もう一度読み込む</button>'; content.querySelector('[data-retry-load]')!.addEventListener('click',() => void load()); return; }
      const status = e instanceof ApiError ? e.status : 0;
      // Unusable responses do not prove rejection, even when HTTP says 200 or 409.
      // Retain the original identity until success or an authoritative API rejection.
      if (e instanceof ApiError && e.jsonResponse && status >= 400 && status < 500 && !e.reauthenticate) {
        unresolved.delete(deckId);
        if (status === 409) { preview = null; try { options = await api<StudyOptionsResponse>(studyOptionsPath(deckId)); } catch { /* Keep current inputs when refreshing fails. */ } }
        render(); error.textContent = status === 409 ? mutation.kind === 'restart' ? '学習状況が変わりました。入力内容を確認し、配分をもう一度確認してください。' : '学習状況が変わりました。最新の状況を確認して、もう一度操作してください。' : (e as Error).message;
      } else { render(); error.textContent = '保存を確認できませんでした。入力内容は保持しています。「同じ内容で再送」を押してください。'; }
    } finally { setBusy(false); if (error.textContent) error.scrollIntoView({block:'nearest'}); }
  };
  const readDraft = () => {
    draft = {dailyNewLimit: content.querySelector<HTMLInputElement>('[name="dailyNewLimit"]')?.value ?? draft.dailyNewLimit,dailyReviewLimit: (content.querySelector<HTMLInputElement>('[name="dailyReviewLimit"]')?.value ?? draft.dailyReviewLimit),backlogPerDay: (content.querySelector<HTMLInputElement>('[name="backlogPerDay"]')?.value ?? draft.backlogPerDay),flatten: content.querySelector<HTMLInputElement>('[name="flatten"]')?.checked ?? draft.flatten};
  };
  const render = () => {
    if (!options) return;
    const r = options.restart; const pending = unresolved.get(deckId);
    const extras = (['new','review'] as const).map(kind => {
      const label = kind === 'new' ? '新規' : '復習'; const disabled = options!.available[kind] === 0;
      const pendingValue = pending?.kind === kind ? String(pending.body[kind]) : extraDraft[kind];
      return `<form class="extra-form" data-kind="${kind}"><div><h3>${label}を今日だけ追加</h3><p>今日の目標 ${count(options!.limits[kind])}枚 · 追加済み ${count(options!.extra[kind])}枚</p><p>${kind === 'review' ? '期限を迎えた復習' : 'いま学習できる新規'} ${count(options!.available[kind])}枚</p></div><label>${label}の追加枚数<input name="amount" aria-label="${label}の追加枚数" type="number" min="1" max="10000" step="1" value="${escapeHtml(pendingValue)}" placeholder="10" required${disabled ? ' data-disabled disabled' : ''}></label><button class="secondary" type="submit"${disabled ? ' data-disabled disabled' : ''}>${label}を追加して学習</button></form>`;
    }).join('');
    content.innerHTML = `<p class="study-options-help">追加した枚数は今日だけ有効です。翌日はいつもの上限に戻ります。</p>${extras}<section class="restart-editor" aria-labelledby="restart-heading"><h3 id="restart-heading">たまった復習から再開</h3>${r ? `${restartStatusMarkup(options)}<progress max="${r.backlogTotal || 1}" value="${r.backlogTotal-r.backlogRemaining}" aria-label="たまった復習の完了枚数"></progress><p class="study-options-help">${r.paused ? '一時停止中は、いつもの学習上限に戻ります。' : `今日のたまった分の残り ${count(r.backlogToday)}枚。${r.dailyNewLimit ? `新規は1日${count(r.dailyNewLimit)}枚まで先に進めます。` : '新規の自動出題を休止しています。今日だけの追加は利用できます。'}`}</p><form data-new-limit-form><label class="practice-field">再開中の1日の新規枚数<input name="restartNewLimit" type="number" min="0" max="10000" step="1" value="${escapeHtml(newLimitDraft ?? String(r.dailyNewLimit))}" required></label><p class="study-options-help">0枚で新規を休止します。復習の配分はそのままに変更できます。</p><button class="secondary" type="submit">新規のペースを保存</button></form><div class="study-options-actions"><button class="secondary" data-state="${r.paused ? 'resume' : 'pause'}">${r.paused ? '再開モードを再開' : '再開モードを一時停止'}</button><button class="secondary" data-cancel>再開モードを終了</button></div><div data-cancel-confirm hidden><p>再開モードを終了して、いつもの学習上限に戻します。未回答のカードは通常の出題に戻ります。これまでの回答と、その回答で決まった復習予定は残ります。</p><button class="secondary" data-state="cancel">終了する</button><button class="secondary" data-keep>続ける</button></div>` : `<p class="study-options-help">1日に取り組む量を決めて、たまった復習を少しずつ進めます。新規も少しずつ進められます。期限が来た学習・再学習の後、設定した新規を先に出題します。</p><form data-restart-form><div class="restart-fields"><label class="practice-field">1日の新規枚数<input name="dailyNewLimit" type="number" min="0" max="10000" step="1" value="${escapeHtml(draft.dailyNewLimit)}" required></label><label class="practice-field">1日の復習目標<input name="dailyReviewLimit" type="number" min="1" max="10000" step="1" value="${escapeHtml(draft.dailyReviewLimit)}" required></label><label class="practice-field">たまった分の1日最大枚数<input name="backlogPerDay" type="number" min="1" max="10000" step="1" value="${escapeHtml(draft.backlogPerDay)}" required></label></div><p class="study-options-help">新規は0枚で休止できます。日別配分は現在の復習カードだけの計画です。新規から生じる今後の復習は含みません。</p><label class="flatten-choice"><input type="checkbox" name="flatten"${draft.flatten ? ' checked' : ''}><span>出題日を日ごとの配分に合わせる</span></label><p class="study-options-help">任意です。チェックすると、たまった復習や今後の復習に取り組む日を後ろにずらして配分します。先送りによって思い出しにくくなる可能性があります。</p><button type="submit" class="secondary">配分を確認</button></form><div data-preview>${preview ? `<h4>開始後の配分</h4><p>対象 ${count(preview.total)}枚 · 先送り ${count(preview.delayedCards)}枚 · 最大 ${count(preview.maxDelayDays)}日</p><div class="allocation-table"><table><caption>復習の配分</caption><thead><tr><th scope="col">日付</th><th scope="col">枚数</th></tr></thead><tbody>${preview.days.map(d => `<tr><th scope="row">${escapeHtml(day(d.date))}</th><td>${count(d.cards)}枚</td></tr>`).join('')}</tbody></table></div><button class="primary" data-apply>この配分で再開モードを開始</button>` : ''}</div>`}</section>${pending ? '<p class="study-options-help">前の保存結果を確認してください。確認できるまで入力内容を保持します。</p><button class="primary" data-retry-save>同じ内容で再送</button>' : ''}<p role="status" data-saved></p>`;
    content.querySelectorAll<HTMLFormElement>('.extra-form').forEach(form => { form.querySelector('input')!.addEventListener('input', event => {extraDraft[form.dataset.kind as Kind] = (event.target as HTMLInputElement).value;}); form.addEventListener('submit',event => {
      event.preventDefault(); if (busy) return; const kind = form.dataset.kind as Kind; const amount = Number(new FormData(form).get('amount'));
      void save({path:`${studyOptionsPath(deckId)}/extra`,body:{requestId:practiceRequestId(),new:kind === 'new' ? amount : 0,review:kind === 'review' ? amount : 0},kind});
    }); });
    content.querySelector('[data-restart-form]')?.addEventListener('submit',async event => {
      event.preventDefault(); if (busy) return; readDraft(); preview = null; setBusy(true); error.textContent = '';
      try { preview = await api<RestartPreview>(`${studyOptionsPath(deckId)}/restart/preview`,{dailyReviewLimit:Number(draft.dailyReviewLimit),dailyNewLimit:Number(draft.dailyNewLimit),backlogPerDay:Number(draft.backlogPerDay),flatten:draft.flatten}); render(); content.querySelector('[data-preview]')!.scrollIntoView({block:'nearest'}); }
      catch (e) { error.textContent = (e as Error).message; } finally { setBusy(false); if (error.textContent) error.scrollIntoView({block:'nearest'}); }
    });
    content.querySelectorAll('[data-restart-form] input').forEach(input => input.addEventListener('input',() => {readDraft();preview = null; content.querySelector('[data-preview]')!.innerHTML = '';}));
    content.querySelector('[data-apply]')?.addEventListener('click',() => { if (!preview || busy) return; void save({path:`${studyOptionsPath(deckId)}/restart`,body:{requestId:practiceRequestId(),dailyReviewLimit:Number(draft.dailyReviewLimit),dailyNewLimit:Number(draft.dailyNewLimit),backlogPerDay:Number(draft.backlogPerDay),flatten:draft.flatten,previewToken:preview.token},kind:'restart'}); });
    const newLimitForm = content.querySelector<HTMLFormElement>('[data-new-limit-form]');
    newLimitForm?.querySelector('input')?.addEventListener('input',event => {newLimitDraft=(event.target as HTMLInputElement).value;});
    newLimitForm?.addEventListener('submit',event => {
      event.preventDefault(); if(!r || busy) return;
      const dailyNewLimit=Number(new FormData(newLimitForm).get('restartNewLimit'));
      void save({path:`${studyOptionsPath(deckId)}/restart/state`,body:{requestId:practiceRequestId(),restartId:r.id,revision:r.revision,action:'set-new-limit',dailyNewLimit},kind:'state'});
    });
    content.querySelectorAll<HTMLButtonElement>('[data-state]').forEach(button => button.addEventListener('click',() => { if (!r || busy) return; void save({path:`${studyOptionsPath(deckId)}/restart/state`,body:{requestId:practiceRequestId(),restartId:r.id,revision:r.revision,action:button.dataset.state},kind:'state'}); }));
    content.querySelector('[data-cancel]')?.addEventListener('click',() => {content.querySelector<HTMLElement>('[data-cancel-confirm]')!.hidden = false;});
    content.querySelector('[data-keep]')?.addEventListener('click',() => {content.querySelector<HTMLElement>('[data-cancel-confirm]')!.hidden = true;});
    content.querySelector('[data-retry-save]')?.addEventListener('click',() => {const mutation = unresolved.get(deckId);if (mutation && !busy) void save(mutation);});
    // The status in this dialog is informational; opening another copy is unnecessary.
    content.querySelector('[data-study-options]')?.remove(); lockUnresolved();
  };
  const load = async () => {
    setBusy(true); error.textContent = '';
    try {
      options = await api<StudyOptionsResponse>(studyOptionsPath(deckId));
      if (previous?.kind !== 'restart') {draft.dailyReviewLimit = String(options.limits.review || 100); draft.backlogPerDay = String(Math.min(20, options.limits.review || 100));} render();
      const target = initialKind ? content.querySelector<HTMLInputElement>(`.extra-form[data-kind="${initialKind}"] input`) : null;
      if (target && !target.disabled) target.focus();
    } catch { content.innerHTML = '<p>学習状況を読み込めませんでした。</p><button class="secondary" data-retry-load>もう一度読み込む</button>'; content.querySelector('[data-retry-load]')!.addEventListener('click',() => void load()); }
    finally { setBusy(false); }
  };
  dialog.showModal(); void load();
}
