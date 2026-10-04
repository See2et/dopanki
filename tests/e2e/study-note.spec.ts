import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const config = { newPerDay: 20, desiredRetention: .9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, fsrsEnabled: true };
const deck = { id: 'deck', name: 'ことばの種', configId: 'config', config };
const type = { id: 'type', name: 'ことばと意味', kind: 'normal', fields: ['表', '裏'], fieldDefinitions: [{ id: 'front', name: '表', required: true }, { id: 'back', name: '裏', required: false }], templates: [{ id: 'template', name: 'カード1', front: '{{表}}{{type:裏}}', back: '{{FrontSide}}<hr>{{裏}}' }], css: '.card { font-size: 24px; }', version: 1 };
const schedule = { state: 0, due: 0, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, lastReview: null, learningSteps: 0 };
class Mock {
  note = { id: 'note', noteTypeId: 'type', fields: { 表: 'serendipity', 裏: '思いがけない発見' }, tags: ['英語'], version: 1, contentFormat: 'plain', cards: [{ id: 'card', deckId: 'deck', templateId: 'template', suspended: false }, { id: 'sibling', deckId: 'other', templateId: 'template', suspended: false }] };
  writes: any[] = [];
  reviews: any[] = [];
  fail: 'save' | 'conflict' | 'load' | 'study' | 'lost' | null = null;
  empty = false;
  saved = new Map<string, unknown>();
  async attach(page: Page) {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = (data: unknown, status = 200) => route.fulfill({ json: data, status });
      if (path === '/api/session') return json({ authenticated: true, passwordRequired: false });
      if (path === '/api/overview') return json({ imported: true, warnings: [], decks: [{ ...deck, parentId: null, depth: 0, label: deck.name, counts: { new: 2, learning: 0, review: 0, total: 2 }, answeredToday: 0 }] });
      if (path === '/api/manage/note-types') return json({ noteTypes: [type] });
      if (path === '/api/manage/notes/note') {
        if (route.request().method() === 'GET') {
          if (this.fail === 'load') { this.fail = null; return json({ error: '読み込み失敗' }, 500); }
          return json({ note: this.note });
        }
        const body = route.request().postDataJSON(); this.writes.push(body);
        if (this.saved.has(body.requestId)) return json(this.saved.get(body.requestId));
        if (this.fail === 'save' || this.fail === 'conflict') { const conflict = this.fail === 'conflict'; this.fail = null; return json({ error: conflict ? '編集バージョンが古いです。' : '通信エラー' }, conflict ? 409 : 503); }
        this.note = { ...this.note, fields: body.fields || this.note.fields, tags: body.tags || this.note.tags, version: this.note.version + 1, cards: this.note.cards.map(card => ({ ...card, suspended: body.suspended ?? card.suspended })) };
        const result = { note: this.note }; this.saved.set(body.requestId, result);
        if (this.fail === 'lost') { this.fail = null; return route.abort('failed'); }
        return json(result);
      }
      if (path === '/api/study/deck') {
        if (this.fail === 'study') { this.fail = null; return json({ error: '次のカードの取得失敗' }, 500); }
        const suspended = this.note.cards[0].suspended;
        return json({ card: this.empty && suspended ? null : {
          id: suspended ? 'next' : 'card', revision: 7, ordinal: 0, schedule,
          note: { id: suspended ? 'next-note' : 'note', guid: 'guid', noteTypeId: 'type', fields: suspended ? ['次のことば', '次の意味'] : type.fields.map(name => this.note.fields[name as keyof typeof this.note.fields]), tags: this.note.tags, contentFormat: this.note.contentFormat },
          noteType: type, deck, preview: { 1: { ...schedule, due: Date.now() + 60000 }, 2: { ...schedule, due: Date.now() + 360000 }, 3: { ...schedule, due: Date.now() + 86400000 }, 4: { ...schedule, due: Date.now() + 345600000 } },
        }, counts: { new: suspended ? 1 : 2, learning: 0, review: 0, total: 2 }, answeredToday: 0, nextDue: null });
      }
      if (path === '/api/review') { this.reviews.push(route.request().postDataJSON()); return json({ error: '検証用の停止' }, 503); }
      return json({ ok: true });
    });
    await page.goto('/'); await page.locator('[data-deck="deck"]').click(); await expect(page.locator('#reveal')).toBeVisible();
  }
}
const editor = (page: Page) => page.getByRole('dialog', { name: 'ノートを編集' });

test('edit keeps current card, typed answer, learning revision and undo while safely previewing plain text', async ({ page }) => {
  const mock = new Mock(); await page.addInitScript(() => sessionStorage.setItem('dopanki_undo','prior-event')); await mock.attach(page);
  await page.locator('#answer-input').fill('発見'); await page.locator('#reveal').click();
  await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await editor(page).getByRole('textbox', { name: '裏 任意' }).fill('偶然の出会い <script>window.parent.hacked=true</script>');
  await editor(page).getByRole('textbox', { name: /^タグ/ }).fill('英語, 単語');
  await page.getByRole('button', { name: 'プレビューを更新' }).click();
  await expect(page.frameLocator('iframe[title="裏のプレビュー"]').locator('body')).toContainText('<script>');
  expect(await page.evaluate(() => Boolean((window as any).hacked))).toBe(false);
  await page.getByRole('button', { name: '保存して学習に戻る' }).click();
  await expect(editor(page)).toHaveCount(0); await expect(page.frameLocator('#card-frame').locator('body')).toContainText('偶然の出会い');
  await expect(page.locator('.answer-comparison')).toContainText('発見'); await expect(page.locator('#undo')).toBeEnabled();
  expect(mock.writes[0]).toMatchObject({ version: 1, fields: { 表: 'serendipity', 裏: '偶然の出会い <script>window.parent.hacked=true</script>' }, tags: ['英語','単語'] });
  expect(mock.writes[0]).not.toHaveProperty('suspended'); await page.locator('[data-rating="3"]').click();
  await expect.poll(() => mock.reviews.length).toBe(1); expect(mock.reviews[0]).toMatchObject({ cardId: 'card', revision: 7 });
});

test('modal keys, dirty cancel and required fields cannot accidentally reveal or rate', async ({ page }) => {
  const mock = new Mock(); await mock.attach(page); await page.locator('#answer-input').fill('入力した答え');
  await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  const field = editor(page).getByRole('textbox', { name: '表 必須' }); await field.fill('');
  await field.press('Enter'); await field.press('Space'); await field.press('3');
  await expect(page.locator('#reveal')).toBeVisible(); expect(mock.reviews).toEqual([]); expect(mock.writes).toEqual([]);
  await field.fill(''); await page.getByRole('button', { name: '保存して学習に戻る' }).click(); expect(mock.writes).toEqual([]);
  await page.keyboard.press('Escape'); await expect(page.getByText('保存していない変更を破棄して、学習に戻りますか？')).toBeVisible();
  await page.getByRole('button', { name: '編集を続ける' }).click(); await expect(field).toHaveValue('');
  await page.getByRole('button', { name: '学習に戻る', exact: true }).click(); await page.getByRole('button', { name: '破棄して学習に戻る' }).click();
  await expect(page.locator('#answer-input')).toHaveValue('入力した答え'); expect(mock.writes).toEqual([]);
  await page.locator('#reveal').click(); await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await editor(page).getByRole('textbox', { name: '裏 任意' }).press('3'); await editor(page).getByRole('textbox', { name: '裏 任意' }).press('Space');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '破棄して学習に戻る' }).click();
  await expect(page.locator('[data-rating="3"]')).toBeVisible(); expect(mock.reviews).toEqual([]);
});

test('lost save response retains draft and safely retries the same request', async ({ page }) => {
  const mock = new Mock(); await mock.attach(page); mock.note.contentFormat = 'html'; mock.note.fields.表 = '<b>serendipity</b>';
  await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await expect(editor(page)).toContainText('HTMLタグもそのまま保存'); await editor(page).getByRole('textbox', { name: '裏 任意' }).fill('<i>出会い</i>');
  mock.fail = 'lost'; await page.getByRole('button', { name: '保存して学習に戻る' }).click();
  await expect(editor(page).getByRole('alert')).toContainText('入力は残っています');
  await expect(editor(page).getByRole('textbox', { name: '裏 任意' })).toHaveValue('<i>出会い</i>');
  await page.getByRole('button', { name: '保存して学習に戻る' }).click(); await expect(editor(page)).toHaveCount(0);
  expect(mock.writes).toHaveLength(2); expect(mock.writes[0]).toEqual(mock.writes[1]); expect(mock.note.version).toBe(2);
  await expect(page.frameLocator('#card-frame').locator('b')).toHaveText('serendipity'); await page.locator('#reveal').click(); await expect(page.frameLocator('#card-frame').locator('i')).toHaveText('出会い');
});

test('HTTP LAN without randomUUID supports edit retry and suspension with valid stable IDs', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.crypto, 'randomUUID', { value: undefined }));
  const mock = new Mock(); await mock.attach(page);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await editor(page).getByRole('textbox', { name: '裏 任意' }).fill('LANから保存');
  mock.fail = 'lost'; await page.getByRole('button', { name: '保存して学習に戻る' }).click();
  await expect(editor(page).getByRole('alert')).toContainText('入力は残っています');
  await page.getByRole('button', { name: '保存して学習に戻る' }).click();
  await expect(editor(page)).toHaveCount(0);
  expect(mock.writes).toHaveLength(2); expect(mock.writes[0]).toEqual(mock.writes[1]);
  expect(mock.writes[0].requestId).toMatch(/^[a-zA-Z0-9_-]{16,100}$/);
  await page.getByRole('button', { name: '出題停止', exact: true }).click();
  await page.getByRole('button', { name: 'すべて出題停止して次へ' }).click();
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('次のことば');
  expect(mock.writes).toHaveLength(3); expect(mock.writes[2]).toMatchObject({ version: 2, suspended: true });
  expect(mock.writes[2].requestId).toMatch(/^[a-zA-Z0-9_-]{16,100}$/);
  expect(mock.writes[2].requestId).not.toBe(mock.writes[0].requestId);
});

test('load failure and edit conflict allow recovery without discarding draft', async ({ page }) => {
  const mock = new Mock(); await mock.attach(page); mock.fail = 'load'; await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('読み込み失敗'); await page.getByRole('button', { name: '再読み込み' }).click();
  await editor(page).getByRole('textbox', { name: '裏 任意' }).fill('控えたい原稿'); mock.fail = 'conflict';
  await page.getByRole('button', { name: '保存して学習に戻る' }).click(); await expect(editor(page).getByRole('alert')).toContainText('入力を控えて');
  await expect(editor(page).getByRole('textbox', { name: '裏 任意' })).toHaveValue('控えたい原稿');
  await page.getByRole('button', { name: '学習に戻る', exact: true }).click(); await page.getByRole('button', { name: '破棄して学習に戻る' }).click(); await expect(page.locator('#reveal')).toBeVisible();
  expect(mock.reviews).toEqual([]);
});

test('suspension confirms all siblings, preserves rewards and undo, and safely retries queue failure', async ({ page }) => {
  const mock = new Mock(); await page.addInitScript(() => sessionStorage.setItem('dopanki_undo','prior-event')); await mock.attach(page);
  await page.getByRole('button', { name: '出題停止', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('2枚すべて'); await expect(page.getByRole('dialog')).toContainText('他のデッキ');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click(); expect(mock.writes).toEqual([]); await expect(page.locator('#reveal')).toBeVisible();
  await page.getByRole('button', { name: '出題停止', exact: true }).click(); mock.fail = 'save'; await page.getByRole('button', { name: 'すべて出題停止して次へ' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('通信エラー'); mock.fail = 'study';
  await page.getByRole('button', { name: 'すべて出題停止して次へ' }).click();
  await expect(page.getByRole('button', { name: '次のカードを読み込む' })).toBeVisible(); await expect(page.locator('#reveal')).toHaveCount(0);
  await page.keyboard.press('3'); expect(mock.reviews).toEqual([]); await page.getByRole('button', { name: '次のカードを読み込む' }).click();
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('次のことば'); expect(mock.note.cards.every(card => card.suspended)).toBe(true);
  expect(mock.writes).toHaveLength(2); expect(mock.writes[0]).toEqual(mock.writes[1]); expect(mock.writes[1]).toMatchObject({ version: 1, suspended: true });
  await expect(page.locator('#undo')).toBeEnabled(); await expect(page.locator('.dopa-counter')).toHaveAttribute('data-dopa-total','0');
  expect(await page.evaluate(() => sessionStorage.getItem('dopanki_undo'))).toBe('prior-event');
});

test('suspending last note completes quietly without rewards', async ({ page }) => {
  const mock = new Mock(); mock.empty = true; await mock.attach(page); await page.getByRole('button', { name: '出題停止', exact: true }).click(); await page.getByRole('button', { name: 'すべて出題停止して次へ' }).click();
  await expect(page.locator('#finale')).toBeVisible(); await expect(page.locator('#finale')).not.toHaveClass(/is-celebrating/); expect(mock.reviews).toEqual([]); await expect(page.locator('.dopa-counter')).toHaveAttribute('data-dopa-total','0');
});

test('study editor and suspension fit desktop and mobile', async ({ page }) => {
  const mock = new Mock(); await page.setViewportSize({ width: 1280, height: 1000 }); await mock.attach(page); await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/study-tools-desktop.png' }); await page.getByRole('button', { name: 'ノートを編集', exact: true }).click();
  await expect(page.frameLocator('iframe[title="裏のプレビュー"]').locator('body')).toContainText('思いがけない発見'); await page.screenshot({ path: '.local/screenshots/study-editor-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(editor(page)).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(390); expect(await editor(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.local/screenshots/study-editor-mobile.png' }); await editor(page).locator('.manage-save').scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/screenshots/study-editor-mobile-save.png' });
  await page.getByRole('button', { name: '学習に戻る', exact: true }).click(); await page.screenshot({ path: '.local/screenshots/study-tools-mobile.png' });
  await page.getByRole('button', { name: '出題停止', exact: true }).click(); await page.screenshot({ path: '.local/screenshots/study-suspend-mobile.png' });
});
