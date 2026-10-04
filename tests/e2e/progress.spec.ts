import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { ProgressResponse } from '../../src/lib/types';

const BASE = (process.env.DOPANKI_URL || 'http://127.0.0.1:5174').replace(/\/+$/, '');
const SHOTS = '.local/verification/progress';
const config = { desiredRetention: 0.9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, newPerDay: 20, fsrsEnabled: true };

async function setup(page: Page, options: { history?: boolean; failProgress?: boolean; addedTomorrow?: boolean } = {}) {
  let answered = false;
  let failProgress = !!options.failProgress;
  let failReview = false;
  const days = Array.from({ length: 182 }, (_,i) => {
    const date = new Date(Date.UTC(2026,9,4) - (181-i)*86400000).toISOString().slice(0,10);
    return { date, answers: options.history && i < 181 ? i % 9 === 0 ? 62 : i % 3 === 0 ? 12 : i % 4 === 0 ? 3 : 0 : 0 };
  });
  const deck = { id: '1', name: '韓国語', label: '韓国語', configId: '1', config, parentId: null, depth: 0,
    counts: { new: 0, learning: 0, review: 1, total: 1 }, ownCounts: { new: 0, learning: 0, review: 1, total: 1 }, answeredToday: 0, ownAnsweredToday: 0 };
  const state = { state: 2, due: Date.now()-86400000, stability: 10, difficulty: 5, elapsedDays: 10, scheduledDays: 10, reps: 3, lapses: 0, lastReview: Date.now()-10*86400000, learningSteps: 0 };
  const card = { id: '1001', revision: 0, ordinal: 0, schedule: state, deck,
    note: { id: '1', guid: '1', noteTypeId: '1', fields: ['ありがとう','감사합니다'], tags: [] },
    noteType: { id: '1', name: '基本', kind: 'normal', fields: ['JP','KR'], css: '', templates: [{ name: '表裏', front: '{{JP}}', back: '{{FrontSide}}<hr>{{KR}}' }] },
    preview: { 1: { ...state, due: Date.now()+60000 }, 2: { ...state, due: Date.now()+2*86400000 }, 3: { ...state, due: Date.now()+10*86400000 }, 4: { ...state, due: Date.now()+20*86400000 } } };
  await page.route(`${BASE}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/session') return respond({ authenticated: true, passwordRequired: false });
    if (path === '/api/overview') return respond({ imported: true, warnings: [], decks: [{ ...deck, answeredToday: answered ? 1 : 0, counts: { ...deck.counts, review: answered ? 0 : 1 } }] });
    if (path === '/api/progress') {
      if (failProgress) return respond({ error: '集計を取得できませんでした' }, 500);
      const progress: ProgressResponse = { today: '2026-10-04', days: days.map((d,i) => i === 181 ? { ...d, answers: answered ? 1 : 0 } : d),
        todayAnswers: answered ? 1 : 0, weekStudyDays: options.history ? 4 + (answered ? 1 : 0) : answered ? 1 : 0,
        totalStudyDays: days.filter(d => d.answers > 0).length + (answered ? 1 : 0),
        tomorrow: { reviewedCards: answered ? 1 : 0, movedBeyondTomorrow: answered && !options.addedTomorrow ? 1 : 0, addedForTomorrow: answered && options.addedTomorrow ? 1 : 0, netReduction: answered ? options.addedTomorrow ? -1 : 1 : 0, dueCards: answered ? options.addedTomorrow ? 14 : 12 : 13 } };
      return respond(progress);
    }
    if (path === '/api/study/1') return respond({ card: answered ? null : card, counts: { new: 0, learning: 0, review: answered ? 0 : 1, total: 1 }, answeredToday: answered ? 1 : 0, nextDue: answered ? Date.now()+10*86400000 : null });
    if (path === '/api/review') {
      if (failReview) return respond({ error: '保存に失敗しました' }, 500);
      answered = true; return respond({ ok: true, eventId: route.request().postDataJSON().eventId });
    }
    if (path === '/api/undo') { answered = false; return respond({ ok: true, cardId: '1001' }); }
    return respond({ error: 'APIが見つかりません' }, 404);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { localStorage.setItem('dopanki_sound', 'off'); });
  await page.goto(BASE);
  return { failProgress: (value: boolean) => { failProgress = value; }, failReview: (value: boolean) => { failReview = value; } };
}
// Home shows the records as one summary bar; the calendar and tomorrow card open below it (and stay open).
async function openRecords(page: Page) {
  await page.locator('#records-toggle').click();
  await expect(page.locator('#records-toggle')).toHaveAttribute('aria-expanded', 'true');
}

test('persistent calendar and tomorrow result update on save, undo and reload', async ({ page }) => {
  await setup(page);
  await openRecords(page);
  await expect(page.getByRole('heading', { name: '学習カレンダー' })).toBeVisible();
  const today = page.locator('.calendar-day[data-date="2026-10-04"]');
  await expect(today).toHaveAttribute('data-answers', '0');
  await today.press('ArrowLeft');
  await expect(page.locator('.calendar-selection')).toContainText('9月27日');
  await page.keyboard.press('End');
  await expect(today).toBeFocused();
  await page.getByRole('button', { name: '韓国語を学習' }).click();
  await page.getByRole('button', { name: /答えを表示/ }).click();
  await page.locator('[data-rating="3"]').click();
  await expect(page.locator('#finale')).toBeVisible();
  await expect(page.locator('.tomorrow-headline')).toHaveText('1枚を明後日以降へ');
  await expect(page.locator('.tomorrow-result')).toContainText('明日への持ち越しが1枚減りました');
  await page.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(page.getByRole('button', { name: /答えを表示/ })).toBeVisible();
  await page.getByRole('button', { name: '← デッキ一覧' }).click();
  await expect(today).toHaveAttribute('data-answers', '0');
  await expect(page.locator('.tomorrow-headline')).toContainText('今日の1枚が');
  await page.getByRole('button', { name: '韓国語を学習' }).click();
  await page.getByRole('button', { name: /答えを表示/ }).click();
  await page.locator('[data-rating="3"]').click();
  await page.locator('#finale-home').click();
  await expect(today).toHaveAttribute('data-answers', '1');
  await page.reload();
  await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
  await page.locator('#home').click();
  await expect(page.locator('.calendar-stats')).toContainText('累計の学習日1日');
  await expect(today).toHaveAttribute('data-answers', '1');
});

test('record-loading failure and failed save do not prevent learning or grant a day', async ({ page }) => {
  const mock = await setup(page, { failProgress: true });
  await expect(page.locator('.progress-unavailable')).toBeVisible();
  mock.failProgress(false);
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await openRecords(page);
  await expect(page.locator('.calendar-day.is-today')).toHaveAttribute('data-answers', '0');
  await page.getByRole('button', { name: '韓国語を学習' }).click();
  await page.getByRole('button', { name: /答えを表示/ }).click();
  mock.failReview(true);
  await page.locator('[data-rating="3"]').click();
  await expect(page.getByRole('alert')).toContainText('保存に失敗しました');
  mock.failReview(false); mock.failProgress(true);
  await page.locator('[data-rating="3"]').click();
  await expect(page.locator('#finale')).toBeVisible();
  await expect(page.locator('.progress-unavailable')).toBeVisible();
  mock.failProgress(false);
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
  await page.locator('#finale-home').click();
  await expect(page.locator('.calendar-day.is-today')).toHaveAttribute('data-answers', '1');
});

test('calendar is usable on desktop and narrow phones', async ({ page }) => {
  await setup(page, { history: true });
  await openRecords(page);
  await expect(page.locator('.calendar-day')).toHaveCount(182);
  await mkdir(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: `${SHOTS}/desktop-home.png`, fullPage: true });
  for (const width of [390,320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
    await page.locator('.calendar-day.is-today').click();
    await expect(page.locator('.calendar-selection')).toContainText('10月4日');
    await page.screenshot({ path: `${SHOTS}/mobile-${width}-home.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '韓国語を学習' }).click();
  await page.getByRole('button', { name: /答えを表示/ }).click();
  await page.locator('[data-rating="3"]').click();
  await expect(page.locator('.tomorrow-result')).toContainText('1枚減りました');
  await page.getByRole('button', { name: '勲章の通知を閉じる' }).click();
  await page.screenshot({ path: `${SHOTS}/mobile-complete.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: `${SHOTS}/desktop-complete.png`, fullPage: true });
});

// New learning can add tomorrow work; the UI must not claim that every saved answer reduces it.
test('new learning shows increased tomorrow work without a false reduction claim', async ({ page }) => {
  await setup(page, { addedTomorrow: true });
  await page.getByRole('button', { name: '韓国語を学習' }).click();
  await page.getByRole('button', { name: /答えを表示/ }).click();
  await page.locator('[data-rating="3"]').click();
  await expect(page.locator('.tomorrow-result')).toContainText('復習予定が1枚増えました');
  await expect(page.locator('.tomorrow-added')).toContainText('新しく学んだ1枚');
  await expect(page.locator('.tomorrow-headline')).not.toContainText('明後日以降へ');
});
