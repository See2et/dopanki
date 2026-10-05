import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Typed-answer comparison against the Vite dev server; every /api and /media request is a fake.
const BASE = (process.env.DOPANKI_URL || 'http://127.0.0.1:5174').replace(/\/+$/,'');
const SHOTS = '.local/verification/answer-diff';
const day = 86400000;
const config = { desiredRetention: 0.9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, newPerDay: 20, fsrsEnabled: true };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');

const types = {
  slot: { id: 't1', name: '韓国語', kind: 'normal', fields: ['JP','KR','Note','Audio'], css: '.card { font-size: 24px; } .explain { font-size: 16px; color: #555; }',
    templates: [{ name: 'JP → KR', front: '{{JP}}{{type:KR}}', back: '{{JP}}<hr>{{tts ko_KR:KR}}{{type:KR}}<div class="explain">{{Note}}</div>{{Audio}}<img class="pic" src="pic.png" alt="">' }] },
  slotless: { id: 't2', name: 'ことば', kind: 'normal', fields: ['表','裏'], css: '',
    templates: [{ name: 'カード1', front: '{{表}}{{type:裏}}', back: '{{FrontSide}}<hr>{{裏}}' }] },
  accents: { id: 't3', name: 'Français', kind: 'normal', fields: ['JP','FR'], css: '',
    templates: [{ name: 'Card 1', front: '{{JP}}{{type:nc:FR}}', back: '{{JP}}<hr>{{type:nc:FR}}' }] },
  authorClass: { id: 't4', name: '解説つき', kind: 'normal', fields: ['Q','Answer','Note'], css: '',
    templates: [{ name: 'Card 1', front: '{{Q}}{{type:Answer}}', back: '{{Q}}<hr>{{type:Answer}}<aside class="expected-answer">{{Note}}</aside>' }] },
};
type Card = { id: string; noteType: (typeof types)[keyof typeof types]; fields: string[] };
const cards = (): Card[] => [
  { id: 'c1', noteType: types.slot, fields: ['こんにちは','안녕하세요','丁寧なあいさつ。<b>朝・昼・夜</b>いつでも使える。','[sound:hello.mp3]'] },
  { id: 'c2', noteType: types.slotless, fields: ['食べ物','たべもの'] },
  { id: 'c3', noteType: types.accents, fields: ['カフェ','café'] },
];

async function open(page: Page, queue: Card[], reviews: unknown[] = []) {
  const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const counts = () => ({ new: queue.length, learning: 0, review: 0, total: 3 });
  await page.route(`${BASE}/media/**`, route => route.fulfill(route.request().url().endsWith('.png') ? { status: 200, contentType: 'image/png', body: png } : { status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) }));
  await page.route(`${BASE}/api/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill(json({ authenticated: true, passwordRequired: false }));
    if (path === '/api/overview') return route.fulfill(json({ imported: true, warnings: [], decks: [{ id: 'd', name: '入力練習', configId: '1', config, parentId: null, depth: 0, label: '入力練習', ownCounts: counts(), ownAnsweredToday: 0, counts: counts(), answeredToday: 0 }] }));
    if (path === '/api/study/d') {
      const card = queue[0]; const now = Date.now();
      const state = (s: number, due: number) => ({ state: s, due, stability: 2, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, lastReview: null, learningSteps: 0 });
      return route.fulfill(json({ card: card && { id: card.id, revision: 1, ordinal: 0, schedule: state(0,now),
        note: { id: `n${card.id}`, guid: card.id, noteTypeId: card.noteType.id, fields: card.fields, tags: [] }, noteType: card.noteType,
        deck: { id: 'd', name: '入力練習', configId: '1', config }, preview: { 1: state(1,now+60000), 2: state(1,now+360000), 3: state(2,now+day), 4: state(2,now+4*day) } },
      counts: counts(), nextDue: card ? null : now + day, answeredToday: 3 - queue.length }));
    }
    if (path === '/api/review') { const body = route.request().postDataJSON(); reviews.push(body); queue.splice(queue.findIndex(c => c.id === body.cardId),1); return route.fulfill(json({ ok: true, eventId: body.eventId })); }
    return route.fulfill(json({ error: 'APIが見つかりません。' },404));
  });
  await page.goto(`${BASE}/`);
  await page.locator('[data-deck="d"]').click();
  await expect(page.locator('#reveal')).toBeVisible();
}
const frame = (page: Page) => page.frameLocator('#card-frame');
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth,document.body.scrollWidth))).toBeLessThanOrEqual(width);
}
async function shot(page: Page, name: string) {
  await mkdir(SHOTS,{ recursive: true });
  // Let the iframe settle to its content height first.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}.png`, fullPage: true });
}
async function next(page: Page) {
  await page.keyboard.press('3');
  await expect(page.locator('#reveal')).toBeVisible({ timeout: 5000 });
}

test('typed answers are compared once, in place, without leaking before the reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on('pageerror',error => errors.push(error.message));
  const reviews: { cardId: string; rating: number }[] = [];
  await open(page,cards(),reviews);

  // Question: neither the answer nor its explanation is anywhere in the page or the card document.
  expect(await page.locator('#card-frame').getAttribute('srcdoc')).not.toMatch(/안녕하세요|丁寧/);
  await expect(page.locator('.answer-comparison, #spotlight')).toHaveCount(0);
  await page.locator('#answer-input').fill('안녕하세');
  await shot(page,'1-question');

  // A missing character: a gap in the input row, the missing part underlined in the answer row.
  await page.keyboard.press('Enter');
  const comparison = frame(page).locator('.answer-comparison.is-different');
  await expect(comparison.locator('.is-input .answer-value')).toHaveText('안녕하세');
  await expect(comparison.locator('.is-input .answer-gap')).toHaveCount(1);
  await expect(comparison.locator('.is-expected .answer-value')).toHaveText('안녕하세요');
  await expect(comparison.locator('.is-expected ins')).toHaveText('요');
  await expect(comparison.locator('.answer-value').first()).toHaveAttribute('lang','ko-KR');
  // The answer appears exactly once: no stage headline, no leftover slot, no second box outside the card.
  await expect(page.locator('#spotlight')).toHaveCount(0);
  await expect(page.locator('.answer-comparison')).toHaveCount(0);
  await expect(frame(page).locator('.expected-answer')).toHaveCount(0);
  // Template content around the slot stays, in its order: question, rule, comparison, explanation, image.
  expect(await frame(page).locator('body').evaluate(body => [...body.children].map(e => e.tagName.toLowerCase() + (e.className ? `.${e.className.split(' ')[0]}` : '')))).toEqual(['hr','section.answer-comparison','div.explain','img.pic']);
  await expect(frame(page).locator('.explain b')).toHaveText('朝・昼・夜');
  await expect(page.locator('#audio audio')).toHaveAttribute('src','/media/hello.mp3');
  await expect(page.getByRole('button',{ name: '▶ 読み上げる' })).toBeVisible();
  const box = await page.locator('#card-frame').boundingBox();
  expect(box!.height).toBeGreaterThan(200);
  await noOverflow(page,390);
  await shot(page,'2-missing');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page,320);
  await shot(page,'2-missing');
  await page.setViewportSize({ width: 390, height: 844 });

  // Changed characters on a back without a {{type:}} slot: compared below the card, field content untouched.
  await next(page);
  await page.locator('#answer-input').fill('たべもん');
  await page.keyboard.press('Enter');
  const below = page.locator('.answer-comparison.is-different');
  await expect(below.locator('.is-input del')).toHaveText('ん');
  await expect(below.locator('.is-expected ins')).toHaveText('の');
  await expect(below.locator('.answer-gap')).toHaveCount(0);
  await expect(below.locator('.answer-legend')).toContainText('余分・違う文字');
  await expect(frame(page).locator('body')).toContainText('たべもの');
  await expect(frame(page).locator('.answer-comparison')).toHaveCount(0);
  await noOverflow(page,390);
  await shot(page,'3-changed-below-card');

  // {{type:nc:}} ignores accents when matching but still shows the accented spelling.
  await next(page);
  await page.locator('#answer-input').fill(' cafe ');
  await page.keyboard.press('Enter');
  await expect(frame(page).locator('.answer-comparison.is-match .answer-value')).toHaveText('café');
  await expect(frame(page).locator('.answer-comparison')).toContainText('一致しています');
  await shot(page,'4-match');
  await page.keyboard.press('3');
  await expect.poll(() => reviews.map(r => [r.cardId,r.rating])).toEqual([['c1',3],['c2',3],['c3',3]]);
  expect(errors).toEqual([]);
});

test('author markup reusing .expected-answer survives; only the generated slot is replaced', async ({ page }) => {
  await open(page,[{ id: 'c4', noteType: types.authorClass, fields: ['ねこ','고양이','かわいい動物の解説'] }]);
  await page.locator('#answer-input').fill('고양');
  await page.keyboard.press('Enter');
  const card = frame(page);
  await expect(card.locator('aside.expected-answer')).toHaveText('かわいい動物の解説');
  await expect(card.locator('[data-dopanki-type-answer]')).toHaveCount(0);
  await expect(card.locator('.answer-comparison')).toHaveCount(1);
  await expect(card.locator('.answer-comparison .is-expected .answer-value')).toHaveText('고양이');
  // The expected answer is shown once: inside the comparison only.
  expect((await card.locator('body').innerText()).split('고양이')).toHaveLength(2);
  expect(await card.locator('body').evaluate(body => [...body.children].map(e => e.tagName.toLowerCase()))).toEqual(['hr','section','aside']);
});

test('nothing typed keeps the plain answer slot; desktop layout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page,cards());
  await page.keyboard.press('Enter');
  await expect(frame(page).locator('.expected-answer')).toHaveText('안녕하세요');
  await expect(frame(page).locator('.answer-comparison')).toHaveCount(0);
  await expect(page.locator('.answer-comparison, #spotlight')).toHaveCount(0);
  await next(page);
  await page.locator('#answer-input').fill('ごはん');
  await page.keyboard.press('Enter');
  await expect(page.locator('.answer-comparison .is-input del')).toHaveText('ごはん');
  await expect(page.locator('.answer-comparison .is-expected ins')).toHaveText('たべもの');
  await shot(page,'5-replaced-desktop');
});
