import { escapeHtml } from '../src/lib/render';
import type { DeckSummary } from '../src/lib/types';
import type { PracticeSession } from '../src/lib/practice-types';

export const practiceRequestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')}`;

export function practiceMarkup(sessions: PracticeSession[], error: string): string {
  return `<section class="practice-panel" aria-labelledby="practice-title"><div class="practice-heading"><div><h2 id="practice-title">カスタム学習</h2><p>テスト範囲を何周でも。復習予定は変わりません。</p></div><button class="secondary" id="create-practice">範囲を作る</button></div>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p><button class="secondary" id="retry-practices">カスタム学習を再読み込み</button>` : ''}
    ${sessions.length ? `<ul class="practice-list">${sessions.map(s => `<li><div><strong>${escapeHtml(s.name)}</strong><span>${s.round}周目 · ${s.position} / ${s.total}枚</span></div><div class="practice-list-actions"><button class="secondary" data-practice="${escapeHtml(s.id)}">${s.position < s.total ? '続きから' : '開く'}</button><button class="practice-delete" data-delete-practice="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)}を削除">削除</button></div></li>`).join('')}</ul>` : !error ? '<p class="practice-empty">デッキを選んで、繰り返し取り組む範囲を保存できます。</p>' : ''}</section>`;
}

export function openPracticeCreator(decks: DeckSummary[], create: (body: {name: string; deckIds: string[]; order: 'deck'|'shuffle'; requestId: string}) => Promise<string>): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'practice-dialog';
    dialog.setAttribute('aria-labelledby', 'practice-create-title');
    dialog.innerHTML = `<form><div class="practice-heading"><h2 id="practice-create-title">学習範囲を作る</h2><button type="button" class="secondary" data-close>閉じる</button></div><label class="practice-field">名前<input name="name" maxlength="100" placeholder="対象デッキを選択してください" autocomplete="off"></label>
      <fieldset><legend>対象デッキ（複数選択できます）</legend><p>親デッキを選ぶと、その配下も含みます。</p><div class="practice-deck-options">${decks.map(d => `<label style="padding-left:${12+d.depth*16}px"><input type="checkbox" name="deck" value="${escapeHtml(d.id)}"><span>${escapeHtml(d.name.replaceAll('::',' / '))}</span></label>`).join('')}</div></fieldset>
      <label class="practice-field">出題順<select name="order"><option value="deck">デッキ順</option><option value="shuffle">シャッフル</option></select></label><p class="practice-help">未学習のカードも対象です。停止中・一時埋め込み中のカードは出題しません。</p><p data-error class="error" role="alert"></p><button type="submit" class="primary">保存して始める</button></form>`;
    document.body.appendChild(dialog);
    let busy = false; let lastSignature = ''; let requestId = '';
    const nameInput = dialog.querySelector<HTMLInputElement>('[name="name"]')!;
    const selectedDeckName = (deckIds: string[]) => decks.find(deck => deckIds.includes(deck.id))?.name ?? '';
    dialog.querySelectorAll<HTMLInputElement>('[name="deck"]').forEach(checkbox => checkbox.addEventListener('change', () => {
      const deckIds = new FormData(dialog.querySelector('form')!).getAll('deck').map(String);
      nameInput.placeholder = selectedDeckName(deckIds) || '対象デッキを選択してください';
    }));
    const close = (id: string | null) => { dialog.close(); dialog.remove(); resolve(id); };
    dialog.querySelector('[data-close]')!.addEventListener('click', () => { if (!busy) close(null); });
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (!busy) close(null); });
    dialog.querySelector('form')!.addEventListener('submit', async e => {
      e.preventDefault(); if (busy) return;
      const form = new FormData(dialog.querySelector('form')!);
      const deckIds = form.getAll('deck').map(String);
      const name = String(form.get('name') ?? '').trim() || selectedDeckName(deckIds);
      const error = dialog.querySelector<HTMLElement>('[data-error]')!;
      if (!name || !deckIds.length) { error.textContent = '対象デッキを指定してください。'; return; }
      const order = form.get('order') as 'deck'|'shuffle'; const signature = JSON.stringify({name,deckIds,order});
      if (lastSignature !== signature) { lastSignature = signature; requestId = practiceRequestId(); }
      busy = true; error.textContent = '';
      dialog.querySelectorAll('input,button,select').forEach(el => el.setAttribute('disabled',''));
      try { close(await create({ name, deckIds, order, requestId })); }
      catch (e) { error.textContent = (e as Error).message; }
      finally { busy = false; dialog.querySelectorAll('input,button,select').forEach(el => el.removeAttribute('disabled')); }
    });
    dialog.showModal(); dialog.querySelector<HTMLInputElement>('[name="name"]')!.focus();
  });
}
