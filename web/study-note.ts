import './manage.css';
import { escapeHtml, renderCard } from '../src/lib/render';
import type { ManagedNote, ManagedNoteType } from '../src/lib/manage-types';
import type { StudyCard } from '../src/lib/types';
import { frameDocument } from './card-frame';

// HTTP LAN browsers expose getRandomValues even when randomUUID requires HTTPS.
const requestId = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')}`;

export type StudyNoteResult =
  | { kind: 'cancel'; uncertain: boolean }
  | { kind: 'saved'; note: ManagedNote; noteType: ManagedNoteType }
  | { kind: 'suspended' };

/** The study modal owns content writes; learning and its rewards stay with main.ts. */
export function openStudyNote(card: StudyCard, mode: 'edit' | 'suspend'): Promise<StudyNoteResult> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'manage-dialog study-note-dialog';
    dialog.id = 'study-note-dialog';
    dialog.setAttribute('aria-labelledby', 'study-note-title');
    document.body.appendChild(dialog);
    let alive = true;
    let busy = false;
    let dirty = false;
    let uncertain = false;
    const retries = new Map<string, string>();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || busy || uncertain) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    const finish = (result: StudyNoteResult) => {
      alive = false;
      window.removeEventListener('beforeunload', beforeUnload);
      dialog.close(); dialog.remove(); resolve(result);
    };
    const cancel = () => {
      if (busy) return;
      if (dirty && !dialog.querySelector('[data-discard]')) {
        const warning = document.createElement('div');
        warning.className = 'manage-help';
        warning.innerHTML = '<p>保存していない変更を破棄して、学習に戻りますか？</p><div class="manage-actions"><button type="button" class="secondary" data-continue>編集を続ける</button><button type="button" class="secondary" data-discard>破棄して学習に戻る</button></div>';
        dialog.querySelector('form')!.appendChild(warning);
        warning.querySelector('[data-continue]')!.addEventListener('click', () => { warning.remove(); dialog.querySelector<HTMLTextAreaElement>('textarea')?.focus(); });
        warning.querySelector('[data-discard]')!.addEventListener('click', () => finish({ kind: 'cancel', uncertain }));
        warning.querySelector<HTMLButtonElement>('[data-continue]')!.focus();
      } else if (!dirty) finish({ kind: 'cancel', uncertain });
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    function layout(body: string) {
      dialog.innerHTML = `<div class="manage"><div class="manage-section-head"><div><h2 id="study-note-title">${mode === 'edit' ? 'ノートを編集' : 'このノートを出題停止'}</h2><p>${mode === 'edit' ? '保存後は、このカードの学習を続けられます。' : '回答せずに、次のカードへ進みます。'}</p></div><button type="button" class="manage-text-button" data-cancel>学習に戻る</button></div><div class="manage-status" role="status" aria-live="polite" id="study-note-status"></div>${body}</div>`;
      dialog.querySelector('[data-cancel]')!.addEventListener('click', cancel);
    }
    function message(value: string, error = false) {
      const status = dialog.querySelector<HTMLElement>('#study-note-status')!;
      status.className = `manage-status${error ? ' is-error' : ''}`;
      status.setAttribute('role', error ? 'alert' : 'status'); status.textContent = value;
    }
    async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
      const signature = body ? JSON.stringify(body) : '';
      if (body && !retries.has(signature)) retries.set(signature, requestId());
      const response = await fetch(`/api/manage${path}`, { cache: 'no-store', ...(body ? {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, requestId: retries.get(signature) }),
      } : {}) });
      const result = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(response.status === 409
        ? `${result.error || '別の画面で更新されています。'} 入力を控えてから学習に戻り、編集を開き直してください。`
        : result.error || '通信に失敗しました。');
      return result;
    }
    async function load() {
      layout('<p class="manage-loading" role="status">読み込んでいます…</p>');
      try {
        const [{ note }, { noteTypes }] = await Promise.all([
          api<{ note: ManagedNote }>(`/notes/${encodeURIComponent(card.note.id)}`),
          api<{ noteTypes: ManagedNoteType[] }>('/note-types'),
        ]);
        if (!alive) return;
        const type = noteTypes.find(type => type.id === note.noteTypeId);
        if (!type) throw new Error('ノートタイプが見つかりません。');
        layout(mode === 'edit' ? `<form>
          <p class="manage-hint study-note-scope">このノートの変更は、同じノートから作られた${note.cards.length}枚のカードに反映されます。復習予定と回答履歴は保持されます。</p>
          ${note.contentFormat === 'html' ? '<p class="manage-help">取り込んだHTMLを編集しています。HTMLタグもそのまま保存されます。</p>' : ''}
          ${type.fieldDefinitions.map(field => `<label class="manage-field"><span>${escapeHtml(field.name)} <em>${field.required ? '必須' : '任意'}</em></span><textarea name="field:${escapeHtml(field.id)}" rows="3"${field.required ? ' required' : ''}>${escapeHtml(note.fields[field.name] || '')}</textarea></label>`).join('')}
          <label class="manage-field"><span>タグ</span><input name="tags" value="${escapeHtml(note.tags.join(' '))}"><small>スペースまたはカンマで区切ります。</small></label>
          <button type="button" class="secondary" data-preview>プレビューを更新</button><div class="manage-preview" id="study-note-preview"></div>
          <div class="manage-save"><span>保存すると同じノートの全カードに反映されます。</span><button type="submit" class="primary">保存して学習に戻る</button></div></form>`
          : `<form><p class="study-note-scope">このノートから作られた<strong>${note.cards.length}枚すべて</strong>のカードを出題停止します。他のデッキにあるカードも含みます。</p><p class="manage-hint">復習予定と回答履歴は保持されます。「教材管理」から再開できます。回答やドパは加算されません。</p><div class="manage-save"><button type="button" class="secondary" data-stay>キャンセル</button><button type="submit" class="primary">すべて出題停止して次へ</button></div></form>`);
        const form = dialog.querySelector<HTMLFormElement>('form')!;
        const read = () => {
          const data = new FormData(form);
          return { fields: Object.fromEntries(type.fieldDefinitions.map(field => [field.name, String(data.get(`field:${field.id}`) || '')])), tags: String(data.get('tags') || '').split(/[\s,]+/).filter(Boolean) };
        };
        const preview = () => {
          const draft = read();
          const previewCard = { ...card, noteType: type, note: { ...card.note, fields: type.fields.map(name => draft.fields[name] || ''), contentFormat: note.contentFormat } };
          const target = dialog.querySelector<HTMLElement>('#study-note-preview')!;
          target.innerHTML = '<div class="manage-preview-head"><h3>カードプレビュー</h3><span>いまのカードの表と裏</span></div><div class="manage-preview-sides"></div>';
          const front = renderCard(previewCard, 'front');
          const back = renderCard(previewCard, 'back', front.html);
          for (const [label, rendered] of [['表', front], ['裏', back]] as const) {
            const section = document.createElement('section'); section.className = 'manage-preview-side';
            section.innerHTML = `<h4>${label}</h4>`;
            const frame = document.createElement('iframe'); frame.title = `${label}のプレビュー`; frame.setAttribute('sandbox', ''); frame.srcdoc = frameDocument(rendered); section.appendChild(frame);
            target.querySelector('.manage-preview-sides')!.appendChild(section);
          }
        };
        if (mode === 'edit') {
          form.addEventListener('input', () => { dirty = true; });
          dialog.querySelector('[data-preview]')!.addEventListener('click', preview); preview();
        }
        dialog.querySelector('[data-stay]')?.addEventListener('click', cancel);
        form.addEventListener('submit', event => {
          event.preventDefault(); if (busy) return;
          const body = { version: note.version, ...(mode === 'edit' ? read() : { suspended: true }) };
          busy = true; uncertain = true;
          const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input,textarea,button')];
          controls.forEach(control => { control.disabled = true; }); message('保存しています…');
          void api<{ note: ManagedNote }>(`/notes/${encodeURIComponent(note.id)}`, body).then(result => {
            finish(mode === 'edit' ? { kind: 'saved', note: result.note, noteType: type } : { kind: 'suspended' });
          }).catch(error => {
            if (alive) message(`${error instanceof Error ? error.message : '通信に失敗しました。'} 入力は残っています。同じ内容で再度保存すると安全に再試行できます。`, true);
          }).finally(() => { busy = false; controls.forEach(control => { control.disabled = false; }); });
        });
        dialog.querySelector<HTMLElement>(mode === 'edit' ? 'textarea' : '[data-stay]')?.focus();
      } catch (error) {
        if (!alive) return;
        layout('<button type="button" class="secondary" data-retry>再読み込み</button>');
        message(error instanceof Error ? error.message : '通信に失敗しました。', true);
        dialog.querySelector('[data-retry]')!.addEventListener('click', () => void load());
      }
    }
    layout(''); dialog.showModal(); void load();
  });
}
