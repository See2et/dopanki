import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('imported deck: mobile typed answer, persisted FSRS review, undo and safe template', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on('pageerror',error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{ name: '今日の復習' })).toBeVisible();
  await mkdir('.local/screenshots',{ recursive: true });
  await page.screenshot({ path: '.local/screenshots/mobile-decks.png', fullPage: true });
  const overview = await (await request.get('/api/overview')).json();
  const deck = overview.decks.find((d: any) => d.counts.learning || d.counts.review || d.counts.new);
  expect(deck).toBeTruthy();
  const before = (await (await request.get(`/api/study/${deck.id}`)).json()).card;
  await page.locator(`[data-deck="${deck.id}"]`).click();
  await expect(page.getByRole('button',{ name: /答えを表示/ })).toBeVisible();
  await expect(page.locator('#answer-input')).toBeVisible();
  await page.locator('#answer-input').fill('テスト回答');
  await page.screenshot({ path: '.local/screenshots/mobile-question.png', fullPage: true });
  await page.getByRole('button',{ name: /答えを表示/ }).click();
  await expect(page.getByRole('button',{ name: '▶ 読み上げる' })).toBeVisible();
  await expect(page.frameLocator('#card-frame').locator('.expected-answer')).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.screenshot({ path: '.local/screenshots/mobile-answer.png', fullPage: true });
  await page.locator('[data-rating="3"]').click();
  await expect(page.getByRole('button',{ name: '取り消す' })).toBeEnabled();
  // Reload demonstrates server persistence; the event remains available for undo.
  await page.reload();
  await expect(page.getByRole('button',{ name: '取り消す' })).toBeEnabled();
  await page.getByRole('button',{ name: '取り消す' }).click();
  await expect(page.getByRole('button',{ name: /答えを表示/ })).toBeVisible();
  const restored = (await (await request.get(`/api/study/${deck.id}`)).json()).card;
  expect(restored.id).toBe(before.id); expect(restored.schedule).toEqual(before.schedule);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '.local/screenshots/desktop-question.png', fullPage: true });
  expect(errors).toEqual([]);
});
