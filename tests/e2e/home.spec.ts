import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { ProgressResponse } from '../../src/lib/types';

// Every API call is answered in the browser, so these checks never touch the imported DB.
const BASE = (process.env.DOPANKI_URL || 'http://127.0.0.1:5174').replace(/\/+$/, '');
const SHOTS = process.env.HOME_SHOTS || '.local/verification/home';
const config = { desiredRetention: 0.9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, newPerDay: 20, fsrsEnabled: true };
type Counts = { new: number; learning: number; review: number; total: number };
const deck = (id: string, name: string, parentId: string | null, counts: Counts, answeredToday = 0) => ({
  id, name, label: name.split('::').at(-1)!, configId: '1', config, parentId, depth: name.split('::').length - 1,
  counts, ownCounts: counts, answeredToday, ownAnsweredToday: answeredToday,
});
const decks = [
  deck('ko', '韓国語', null, { new: 20, learning: 35, review: 200, total: 1215 }, 20),
  deck('ko-1', '韓国語::インテンシブ1', 'ko', { new: 20, learning: 34, review: 190, total: 986 }, 20),
  deck('ko-1-10', '韓国語::インテンシブ1::#10', 'ko-1', { new: 0, learning: 0, review: 74, total: 74 }),
  deck('ko-1-11', '韓国語::インテンシブ1::#11', 'ko-1', { new: 20, learning: 34, review: 116, total: 912 }, 20),
  deck('ko-2', '韓国語::表現テスト', 'ko', { new: 0, learning: 1, review: 10, total: 229 }),
  deck('en', '英語', null, { new: 5, learning: 0, review: 12, total: 300 }),
];

async function setup(page: Page, options: { lastDeck?: string; failProgress?: boolean; passwordRequired?: boolean; access?: boolean; width?: number } = {}) {
  let failProgress = !!options.failProgress;
  const days = Array.from({ length: 182 }, (_,i) => {
    const date = new Date(Date.UTC(2026,9,4) - (181-i)*86400000).toISOString().slice(0,10);
    return { date, answers: i === 181 ? 20 : i % 9 === 0 ? 62 : i % 3 === 0 ? 12 : i % 4 === 0 ? 3 : 0 };
  });
  const state = { state: 2, due: Date.now()-86400000, stability: 10, difficulty: 5, elapsedDays: 10, scheduledDays: 10, reps: 3, lapses: 0, lastReview: Date.now()-10*86400000, learningSteps: 0 };
  await page.route(`${BASE}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/session') return respond({ authenticated: true, passwordRequired: !!options.passwordRequired, ...(options.access ? { logoutUrl: '/cdn-cgi/access/logout' } : {}) });
    if (path === '/api/logout') return respond({ ok: true });
    if (path === '/api/overview') return respond({ imported: true, warnings: [], decks });
    if (path === '/api/progress') {
      if (failProgress) return respond({ error: '集計を取得できませんでした' }, 500);
      const progress: ProgressResponse = { today: '2026-10-04', days, todayAnswers: 20, weekStudyDays: 2,
        totalStudyDays: days.filter(d => d.answers > 0).length,
        tomorrow: { reviewedCards: 20, movedBeyondTomorrow: 12, addedForTomorrow: 0, netReduction: 12, dueCards: 1029 } };
      return respond(progress);
    }
    const study = path.match(/^\/api\/study\/(.+)$/);
    if (study) {
      const at = decks.find(d => d.id === decodeURIComponent(study[1]))!;
      const card = { id: `${at.id}-card`, revision: 0, ordinal: 0, schedule: state, deck: at,
        note: { id: '1', guid: '1', noteTypeId: '1', fields: ['ありがとう','감사합니다'], tags: [] },
        noteType: { id: '1', name: '基本', kind: 'normal', fields: ['JP','KR'], css: '', templates: [{ name: '表裏', front: '{{JP}}', back: '{{FrontSide}}<hr>{{KR}}' }] },
        preview: { 1: { ...state, due: Date.now()+60000 }, 2: { ...state, due: Date.now()+2*86400000 }, 3: { ...state, due: Date.now()+10*86400000 }, 4: { ...state, due: Date.now()+20*86400000 } } };
      return respond({ card, counts: at.counts, answeredToday: at.answeredToday, nextDue: null });
    }
    return respond({ error: 'APIが見つかりません' }, 404);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(last => {
    localStorage.setItem('dopanki_sound', 'off');
    if (last && !sessionStorage.getItem('home-test-ready')) { localStorage.setItem('dopanki_last_deck', last); sessionStorage.setItem('home-test-ready', '1'); }
  }, options.lastDeck ?? '');
  if (options.width) await page.setViewportSize({ width: options.width, height: options.width === 1280 ? 900 : 844 });
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: '今日の復習' })).toBeVisible();
  return { failProgress: (value: boolean) => { failProgress = value; } };
}
async function noOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  const scroll = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  expect(scroll).toBeLessThanOrEqual(width);
}

test('Access sessions open the home directly and log out through Access', async ({ page }) => {
  await setup(page, { access: true });
  await expect(page.locator('#password')).toHaveCount(0);
  await page.route('**/cdn-cgi/access/logout', route => route.fulfill({ contentType: 'text/html', body: '<h1>Access logout</h1>' }));
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/cdn-cgi/access/logout`);
});

test('authentication failure offers retry without an independent password prompt', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Cloudflare Accessでログインしてください。' }) }));
  await page.goto(BASE);
  await expect(page.getByRole('button', { name: '再読み込み' })).toBeVisible();
  await expect(page.locator('#password')).toHaveCount(0);
});
async function inFirstView(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

for (const width of [1280, 390, 320]) {
  test(`first view at ${width}px leads with today, resume and the decks`, async ({ page }) => {
    await setup(page, { lastDeck: 'ko-1-11', width });
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator('.today-due')).toContainText('272');
    await expect(page.locator('.due-summary')).toContainText('回答済み20');
    await expect(page.locator('.resume-name')).toHaveText('韓国語 / インテンシブ1 / #11');
    await expect(page.locator('#records-toggle')).toContainText('明日までの復習1,029枚');
    await expect(page.locator('#records-toggle')).toContainText('12枚を明後日以降へ');
    await expect(page.locator('#records-panel')).toBeHidden();
    await expect(page.locator('.medal-strip-count')).toContainText('0 / 10');
    // The one-tap start and the first deck are visible without scrolling, records stay one line.
    await inFirstView(page, '[data-resume]');
    await inFirstView(page, '#records-toggle');
    await inFirstView(page, '[data-deck="ko"]');
    for (const name of ['教材管理', 'バックアップ']) await expect(page.getByText(name, { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `${SHOTS}/home-${width}-first-view.png` });
    await page.screenshot({ path: `${SHOTS}/home-${width}-full.png`, fullPage: true });
    await page.locator('#records-toggle').click();
    await expect(page.locator('#records-panel .learning-calendar')).toBeVisible();
    await expect(page.locator('#records-panel .tomorrow-card')).toBeVisible();
    await noOverflow(page);
    await page.locator('#records-toggle').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/home-${width}-records-open.png` });
    await page.screenshot({ path: `${SHOTS}/home-${width}-records-open-full.png`, fullPage: true });
    await page.locator('#open-medals').click();
    await expect(page.locator('#medal-dialog [data-medal]')).toHaveCount(10);
    await page.screenshot({ path: `${SHOTS}/home-${width}-medals.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('#medal-dialog')).toHaveCount(0);
    await expect(page.locator('#open-medals')).toBeFocused();
  });
}

test('resume and deck rows start study and return to the deck list', async ({ page }) => {
  await setup(page, { lastDeck: 'ko-1-11', width: 390 });
  await page.locator('[data-resume]').click();
  await expect(page.locator('#reveal')).toBeVisible();
  await expect(page.locator('.study-deck')).toContainText('韓国語 / インテンシブ1 / #11');
  await page.getByRole('button', { name: '← デッキ一覧' }).click();
  await page.getByRole('button', { name: '英語を学習' }).click();
  await expect(page.locator('#reveal')).toBeVisible();
  await page.getByRole('button', { name: '← デッキ一覧' }).click();
  // The shortcut follows the deck most recently opened.
  await expect(page.locator('.resume-name')).toHaveText('英語');
  await page.locator('[data-resume]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#reveal')).toBeVisible();
});

test('without a previous deck the list is the starting point', async ({ page }) => {
  await setup(page, { width: 1280 });
  await expect(page.locator('[data-resume]')).toHaveCount(0);
  await expect(page.locator('.today-hint')).toContainText('下のデッキを選ぶ');
  await page.locator('[data-deck="ko-2"]').click();
  await expect(page.locator('#reveal')).toBeVisible();
});

test('search and collapse keep working, and collapse is remembered', async ({ page }) => {
  await setup(page, { width: 390 });
  await page.keyboard.press('/');
  await expect(page.locator('#deck-search')).toBeFocused();
  await page.keyboard.type('#10');
  await expect(page.locator('[data-deck="ko-1-10"]')).toBeVisible();
  await expect(page.locator('[data-deck="ko"]')).toBeVisible();
  await expect(page.locator('[data-deck="en"]')).toHaveCount(0);
  await page.locator('#deck-search').fill('存在しない');
  await expect(page.locator('.deck-empty')).toContainText('一致するデッキはありません');
  await page.locator('#deck-search').fill('');
  const toggle = page.locator('[data-toggle-deck="ko-1"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expect(page.locator('[data-deck="ko-1-10"]')).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-toggle-deck="ko-1"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-deck="ko-1-10"]')).toBeHidden();
  await page.locator('[data-toggle-deck="ko-1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-deck="ko-1-10"]')).toBeVisible();
  await noOverflow(page);
});

test('records open and close from the keyboard, and the choice is remembered', async ({ page }) => {
  await setup(page, { width: 1280 });
  const toggle = page.locator('#records-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('累計');
  await expect(toggle).toContainText('今週2日');
  await expect(toggle).toContainText('今日20回答');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { name: '学習カレンダー' })).toBeVisible();
  await expect(page.locator('.calendar-day')).toHaveCount(182);
  await expect(page.locator('.tomorrow-headline')).toHaveText('12枚を明後日以降へ');
  await expect(page.locator('.tomorrow-result')).toContainText('明日への持ち越しが12枚減りました');
  const today = page.locator('.calendar-day[data-date="2026-10-04"]');
  await today.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.calendar-selection')).toContainText('9月27日');
  await page.keyboard.press('End');
  await expect(today).toBeFocused();
  await page.locator('.progress-explanation summary').click();
  await expect(page.locator('.progress-explanation')).toContainText('同じカードへの複数の回答は1枚');
  await page.reload();
  await expect(page.locator('#records-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#records-panel')).toBeVisible();
  await page.locator('#records-toggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#records-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#records-panel')).toBeHidden();
});

test('a records failure stays out of the way and can be retried', async ({ page }) => {
  const mock = await setup(page, { lastDeck: 'en', failProgress: true, width: 320 });
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator('.home-records .progress-unavailable')).toContainText('学習記録を読み込めませんでした');
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/home-320-records-failed.png` });
  mock.failProgress(false);
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('#records-toggle')).toContainText('1,029');
  await page.locator('[data-resume]').click();
  await expect(page.locator('#reveal')).toBeVisible();
});

test('app bar keeps sound, material manager, backup and logout', async ({ page }) => {
  await setup(page, { passwordRequired: true, width: 320 });
  const sound = page.locator('#sound-toggle');
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'バックアップ' })).toHaveAttribute('href', '/api/export');
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
  await expect(page.getByRole('button', { name: '教材管理', exact: true })).toBeVisible();
  await noOverflow(page);
});
