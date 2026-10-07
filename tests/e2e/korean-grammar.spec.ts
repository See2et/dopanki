import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { applyKoreanGrammarLabels } from '../../web/korean-grammar';

const shots = '.local/verification/korean-grammar/screenshots';
const config = { newPerDay: 20, reviewPerDay: 200, desiredRetention: .9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, fsrsEnabled: true };
const deck = { id: 'deck', name: '韓国語', configId: 'config', config, version: 1 };
const back = '{{FrontSide}}<hr>{{type:韓国語}}{{tts ko_KR:韓国語}}';
const korean = { id: 'type-ko', name: '韓国語', kind: 'normal', fields: ['日本語','韓国語'], fieldDefinitions: [{ id: 'field-jp', name: '日本語', required: true }, { id: 'field-kr', name: '韓国語', required: true }], templates: [{ id: 'template-0', name: '日本語→韓国語', front: '{{日本語}}{{type:韓国語}}', back }], css: '.card { font-size: 28px; }', version: 1 };
const crowded = { ...korean, id: 'type-full', name: '項目の多いタイプ', fields: [...korean.fields, ...Array.from({ length: 29 }, (_, i) => `メモ${i + 1}`)], fieldDefinitions: [...korean.fieldDefinitions, ...Array.from({ length: 29 }, (_, i) => ({ id: `memo-${i + 1}`, name: `メモ${i + 1}`, required: false }))] };
const cloze = { ...korean, id: 'type-cloze', name: '穴埋め', kind: 'cloze', fields: ['Text'], fieldDefinitions: [{ id: 'field-0', name: 'Text', required: false }], templates: [{ id: 'template-0', name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}' }] };

async function manage(page: Page, patch?: (body: any) => { status?: number; body: unknown }) {
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && patch) { const result = patch(request.postDataJSON()); await route.fulfill({ status: result.status || 200, json: result.body }); return; }
    const data: Record<string, unknown> = {
      '/api/session': { authenticated: true, passwordRequired: false },
      '/api/progress': { today: '2026-10-07', days: [{ date: '2026-10-07', answers: 0 }], totalStudyDays: 0, weekStudyDays: 0, todayAnswers: 0, tomorrow: { reviewedCards: 0, movedBeyondTomorrow: 0, addedForTomorrow: 0, netReduction: 0, dueCards: 0 } },
      '/api/practice': { sessions: [] },
      '/api/overview': { imported: true, warnings: [], decks: [{ ...deck, parentId: null, depth: 0, label: deck.name, counts: { new: 1, learning: 0, review: 0, total: 1 }, ownCounts: { new: 1, learning: 0, review: 0, total: 1 }, answeredToday: 0, ownAnsweredToday: 0 }] },
      '/api/manage/decks': { decks: [deck] }, '/api/manage/note-types': { noteTypes: [korean, crowded, cloze] }, '/api/manage/notes': { notes: [], total: 0 },
    };
    await route.fulfill({ json: data[path] || { ok: true } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '教材管理', exact: true }).click();
  await page.getByRole('button', { name: 'ノートタイプ', exact: true }).click();
}
const fieldNames = (page: Page) => page.locator('#type-fields input[name^="name:"]');
const backFrame = (page: Page) => page.locator('#type-preview').frameLocator('iframe[title="裏のプレビュー"]');

test('the explicit action adds optional grammar fields and back labels to the unsaved draft once, then saves identities', async ({ page }) => {
  const bodies: any[] = [];
  await manage(page, body => { bodies.push(body); return bodies.length === 1 ? { status: 503, body: { error: '一時的な通信エラー' } } : { body: { noteType: { ...korean, ...body, version: 2 } } }; });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: /^韓国語.*フィールド/ }).click();
  // Unsaved edits, including a field rename, made before the action must survive it.
  await page.getByRole('textbox', { name: 'タイプ名' }).fill('韓国語（文法つき）');
  await fieldNames(page).nth(1).fill('韓国語回答');
  await page.getByRole('textbox', { name: '表面のHTML' }).fill('{{日本語}}<br>{{type:韓国語回答}}');
  await page.getByRole('textbox', { name: '共通CSS' }).fill('.card { font-size: 28px; color: #233; }');
  await page.getByRole('button', { name: '品詞・活用欄を追加' }).click();
  await expect(page.locator('#manage-status')).toContainText('品詞・変格活用のラベルと活用例欄を整えました');
  await expect(fieldNames(page)).toHaveCount(5);
  await expect(fieldNames(page).nth(2)).toHaveValue('品詞'); await expect(fieldNames(page).nth(3)).toHaveValue('変格活用');
  for (const i of [2, 3, 4]) await expect(page.locator('#type-fields .manage-definition').nth(i).getByRole('checkbox', { name: '必須' })).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'タイプ名' })).toHaveValue('韓国語（文法つき）');
  await expect(fieldNames(page).nth(1)).toHaveValue('韓国語回答');
  await expect(page.getByRole('textbox', { name: '表面のHTML' })).toHaveValue('{{日本語}}<br>{{type:韓国語回答}}');
  // The unchanged back is rewritten here, so it takes the pending rename the server would otherwise apply.
  const backValue = await page.getByRole('textbox', { name: '裏面のHTML' }).inputValue();
  expect(backValue.startsWith('{{FrontSide}}<hr>{{type:韓国語回答}}{{tts ko_KR:韓国語回答}}<div class="dpk-grammar">')).toBe(true); expect(backValue.match(/dpk-grammar-chip/g)).toHaveLength(2);
  const css = await page.getByRole('textbox', { name: '共通CSS' }).inputValue();
  expect(css.startsWith('.card { font-size: 28px; color: #233; }')).toBe(true); expect(css.match(/dopanki:korean-grammar-labels/g)).toHaveLength(1);

  // The renderer preview shows labels on the back only, and keeps typed answer and TTS.
  await page.getByText('サンプルで表示を確認', { exact: true }).click();
  await page.getByRole('textbox', { name: '活用例', exact: true }).fill('듣다 + -어요 → 들어요\n듣고 はそのまま。');
  await page.getByRole('button', { name: 'プレビューを更新' }).click();
  await expect(backFrame(page).locator('.dpk-conjugation-examples-value')).toHaveText('듣다 + -어요 → 들어요듣고 はそのまま。');
  await expect(backFrame(page).locator('.dpk-conjugation-examples-value br')).toHaveCount(1);
  await expect(backFrame(page).locator('.dpk-grammar-pos')).toContainText('品詞のサンプル');
  await expect(backFrame(page).locator('.dpk-grammar-conjugation')).toContainText('変格活用のサンプル');
  await expect(page.locator('#type-preview').frameLocator('iframe[title="表のプレビュー"]').locator('.dpk-grammar')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '表の解答入力プレビュー' })).toBeVisible();
  await expect(page.getByRole('button', { name: '読み上げを試す' })).toBeVisible();
  await expect(page.locator('#type-preview .manage-hint')).toHaveCount(0);
  await mkdir(shots, { recursive: true });
  await page.locator('.manage-addon').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/editor-action-desktop.png` });
  await page.locator('#type-preview').screenshot({ path: `${shots}/editor-preview-desktop.png` });

  await page.getByRole('button', { name: '品詞・活用欄を追加' }).click();
  await expect(page.locator('#manage-status')).toContainText('追加済み');
  await expect(fieldNames(page)).toHaveCount(5);
  await expect(page.getByRole('textbox', { name: '裏面のHTML' })).toHaveValue(backValue);

  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('入力は残っています');
  await expect(fieldNames(page)).toHaveCount(5); await expect(page.getByRole('textbox', { name: '裏面のHTML' })).toHaveValue(backValue);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(390);
  await page.locator('.manage-addon').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/editor-action-mobile.png` });
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ノートタイプ', exact: true })).toBeVisible();

  expect(bodies).toHaveLength(2); expect(bodies[1].requestId).toBe(bodies[0].requestId);
  const saved = bodies[1];
  expect(saved).toMatchObject({ version: 1, name: '韓国語（文法つき）', css });
  expect(saved.fieldDefinitions.slice(0, 2)).toEqual([korean.fieldDefinitions[0], { ...korean.fieldDefinitions[1], name: '韓国語回答' }]);
  expect(saved.fieldDefinitions.slice(2).map((f: any) => [f.name, f.required])).toEqual([['品詞', false], ['変格活用', false], ['活用例', false]]);
  expect(saved.fieldDefinitions.slice(2).every((f: any) => /^[0-9a-f-]{36}$/.test(f.id))).toBe(true);
  expect(saved.templates).toEqual([{ id: 'template-0', name: '日本語→韓国語', front: '{{日本語}}<br>{{type:韓国語回答}}', back: backValue }]);
  // Same unknown-reference rule as the server: every template token names a field or a built-in.
  const known = new Set([...saved.fieldDefinitions.map((f: any) => f.name), 'Tags', 'Type', 'Deck', 'Subdeck', 'Card', 'FrontSide']);
  for (const t of saved.templates) for (const m of `${t.front}${t.back}`.matchAll(/{{([^{}]+)}}/g)) expect(known.has(m[1].trim().replace(/^[#^/]/, '').split(':').at(-1))).toBe(true);
});

test('a validation error leaves the draft unchanged, and cloze types offer no action', async ({ page }) => {
  let patched = false; await manage(page, () => { patched = true; return { body: {} }; });
  await page.getByRole('button', { name: /^項目の多いタイプ/ }).click();
  await page.getByRole('textbox', { name: 'タイプ名' }).fill('編集中の名前');
  await page.getByRole('button', { name: '品詞・活用欄を追加' }).click();
  await expect(page.getByRole('alert')).toContainText('フィールドは32個までです');
  await expect(fieldNames(page)).toHaveCount(31);
  await expect(page.getByRole('textbox', { name: '裏面のHTML' })).toHaveValue(back);
  await expect(page.getByRole('textbox', { name: '共通CSS' })).toHaveValue(korean.css);
  await expect(page.getByRole('textbox', { name: 'タイプ名' })).toHaveValue('編集中の名前');
  expect(patched).toBe(false);
  await page.getByRole('button', { name: '一覧へ戻る' }).click(); await page.getByRole('button', { name: '破棄して移動' }).click();
  await page.getByRole('button', { name: /^穴埋め/ }).click();
  await expect(page.getByText('穴埋め式は現在、閲覧のみです。')).toBeVisible();
  await expect(page.getByRole('button', { name: '品詞・活用欄を追加' })).toHaveCount(0);
});

// Study screen rendering of the saved template, using the same helper output as the editor.
const labelled = (() => { const r = applyKoreanGrammarLabels(korean, () => crypto.randomUUID()); if (!r.ok) throw new Error(r.error); return { ...korean, ...r.input, fields: r.input.fieldDefinitions.map(f => f.name) }; })();
const schedule = { state: 0, due: 0, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, lastReview: null, learningSteps: 0 };
async function study(page: Page, type: typeof labelled | typeof korean, values: string[]) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      '/api/session': { authenticated: true, passwordRequired: false }, '/api/practice': { sessions: [] },
      '/api/progress': { today: '2026-10-07', days: [{ date: '2026-10-07', answers: 0 }], totalStudyDays: 0, weekStudyDays: 0, todayAnswers: 0, tomorrow: { reviewedCards: 0, movedBeyondTomorrow: 0, addedForTomorrow: 0, netReduction: 0, dueCards: 1 } },
      '/api/overview': { imported: true, warnings: [], decks: [{ ...deck, parentId: null, depth: 0, label: deck.name, counts: { new: 1, learning: 0, review: 0, total: 1 }, answeredToday: 0 }] },
      '/api/study-options/deck': { deckId: 'deck', studyDay: '2026-10-07', limits: { new: 20, review: 200 }, available: { new: 1, review: 0 }, extra: { new: 0, review: 0 }, restart: null },
      '/api/study/deck': { card: { id: 'card', revision: 1, ordinal: 0, schedule, note: { id: 'note', guid: 'guid', noteTypeId: type.id, fields: values, tags: [], contentFormat: 'plain' }, noteType: type, deck, preview: { 1: { ...schedule, due: Date.now() + 60000 }, 2: { ...schedule, due: Date.now() + 360000 }, 3: { ...schedule, due: Date.now() + 86400000 }, 4: { ...schedule, due: Date.now() + 345600000 } } }, counts: { new: 1, learning: 0, review: 0, total: 1 }, answeredToday: 0, nextDue: null },
    };
    await route.fulfill({ json: data[path] || { ok: true } });
  });
  // A reload resumes the open study session, so the deck list is only shown on the first visit.
  await page.goto('/'); const deckButton = page.locator('[data-deck="deck"]'); const input = page.locator('#answer-input');
  await expect(deckButton.or(input)).toBeVisible(); if (await deckButton.isVisible()) await deckButton.click();
  await input.fill('춥다'); await page.locator('#reveal').click();
  const frame = page.frameLocator('#card-frame[title="答え"]');
  await expect(frame.locator('body')).toContainText('寒い');
  await expect.poll(() => page.locator('#card-frame').evaluate(f => (f as HTMLIFrameElement).style.height)).not.toBe('');
  return frame;
}
const cases = {
  empty: ['寒い', '춥다', '', '', ''],
  examplesOnly: ['寒い', '춥다', '', '', '춥다 + -어요 → 추워요\n춥고 はそのまま。'],
  populated: ['寒い', '춥다', '形容詞', 'ㅂ変格', '춥다 + -어요 → 추워요\n춥다 + -(으)면 → 추우면'],
  long: ['寒い', '춥다', '形容詞（状態・感覚を表す。用言として活用し、連体形は추운）', 'ㅂ変格活用：語幹末のㅂが母音で始まる語尾の前で우に変わる（춥다→추워요、춥+은→추운）。돕다・곱다は와になる例外', '춥다 + -어요 → 추워요\n춥다 + -(으)면 → 추우면\n춥고 はそのまま。' + '長い補足'.repeat(50)],
};
for (const [width, height, device] of [[390, 844, 'mobile'], [1280, 900, 'desktop']] as const) {
  test(`study back shows compact grammar labels on ${device}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await mkdir(shots, { recursive: true });
    const baseline = await study(page, korean, cases.empty.slice(0, 2));
    const baseHeight = await baseline.locator('body').evaluate(b => b.scrollHeight);
    for (const [name, values] of Object.entries(cases)) {
      await page.unrouteAll({ behavior: 'wait' });
      const frame = await study(page, labelled, values);
      const labels = frame.locator('.dpk-grammar');
      if (name === 'empty') {
        await expect(labels).toBeHidden();
        await expect(frame.locator('.dpk-conjugation-examples')).toHaveCount(0);
        expect(await frame.locator('body').evaluate(b => b.scrollHeight)).toBe(baseHeight);
      } else if (name !== 'examplesOnly') {
        await expect(frame.locator('.dpk-grammar-pos .dpk-grammar-value')).toHaveText(values[2]);
        await expect(frame.locator('.dpk-grammar-conjugation .dpk-grammar-value')).toHaveText(values[3]);
        const sizes = await frame.locator('.dpk-grammar-pos').evaluate(chip => [chip.querySelector('.dpk-grammar-key')!, chip.querySelector('.dpk-grammar-value')!, document.body].map(e => parseFloat(getComputedStyle(e).fontSize)));
        expect(sizes[0]).toBe(11); expect(sizes[1]).toBe(13); expect(sizes[1]).toBeLessThan(sizes[2]);
        const overflow = await frame.locator('body').evaluate(b => ({ scroll: b.ownerDocument.documentElement.scrollWidth, client: b.ownerDocument.documentElement.clientWidth, chips: [...b.querySelectorAll('.dpk-grammar-chip')].map(c => c.getBoundingClientRect().right) }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client); for (const right of overflow.chips) expect(right).toBeLessThanOrEqual(overflow.client);
        if (name === 'long') expect(await frame.locator('.dpk-grammar-conjugation').evaluate(c => c.getBoundingClientRect().height)).toBeGreaterThan(40);
      }
      if (name !== 'empty') {
        const example = frame.locator('.dpk-conjugation-examples');
        await expect(example).toBeVisible();
        await expect(example.locator('.dpk-conjugation-examples-heading')).toHaveText('活用例');
        await expect(example.locator('br')).toHaveCount(values[4].split('\n').length - 1);
        const bounds = await example.evaluate(e => ({ right: e.getBoundingClientRect().right, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, font: getComputedStyle(e).fontSize }));
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
        expect(bounds.right).toBeLessThanOrEqual(bounds.client);
        expect(bounds.font).toBe('16px');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      // The rating bar is sticky; scrolling to the end shows the card bottom as a learner sees it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.screenshot({ path: `${shots}/study-${name}-${device}.png`, animations: 'disabled' });
    }
  });
}
