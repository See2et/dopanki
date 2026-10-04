import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Runs against the Vite dev server with every /api and /media request answered by an in-memory fake,
// so no imported collection or local database is touched.
const BASE = (process.env.DOPANKI_URL || 'http://127.0.0.1:5174').replace(/\/+$/,'');
const SHOTS = '.local/verification/redesign';
const minute = 60000;
const day = 86400000;
const config = { desiredRetention: 0.9, parameters: [], learningSteps: [1,10], relearningSteps: [10], maximumInterval: 36500, newPerDay: 20, fsrsEnabled: true };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');

const noteTypes = {
  korean: { id: '100', name: '韓国語 基本', kind: 'normal', fields: ['JP','KR','Audio'], css: '.card { font-size: 24px; }',
    templates: [{ name: 'JP → KR', front: '{{JP}}{{type:KR}}', back: '{{JP}}<hr>{{tts ko_KR voices=AwesomeTTS:KR}}{{type:KR}}{{Audio}}<div><img class="flag" src="flag.png" alt="flag"></div>' }] },
  english: { id: '200', name: 'Basic', kind: 'normal', fields: ['Front','Back'], css: '',
    templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id=answer>{{Back}}{{tts en_US:Back}}' }] },
  typed: { id: '300', name: 'Typed', kind: 'normal', fields: ['Q','A'], css: '',
    templates: [{ name: 'Card 1', front: '{{Q}}{{type:A}}', back: '{{Q}}<hr>{{type:A}}' }] },
};
interface MockCard { id: string; deckId: string; revision: number; noteType: (typeof noteTypes)[keyof typeof noteTypes]; fields: string[] }
const koreanCards = (): MockCard[] => [['こんにちは','안녕하세요'],['ありがとう','감사합니다'],['愛してる','사랑해요'],['大丈夫','괜찮아요'],['おやすみ','잘 자요']]
  .map(([jp,kr],i) => ({ id: String(1001+i), deckId: '10', revision: 1, noteType: noteTypes.korean, fields: [jp,kr,'[sound:hello.mp3]'] }));
const englishCards = (): MockCard[] => [
  { id: '2001', deckId: '2', revision: 1, noteType: noteTypes.english, fields: ['りんご','apple'] },
  { id: '2002', deckId: '2', revision: 1, noteType: noteTypes.typed, fields: ['Escaped?','<b>x</b> &lt;img src=x onerror=alert(1)&gt;'] },
];
const deckNames: Record<string,string> = { '1': '韓国語', '10': '韓国語::あいさつ', '2': 'English', '3': '完了済み' };
const scope = (deckId: string) => deckId === '1' ? ['1','10'] : [deckId];

class MockApi {
  queue: MockCard[];
  readonly totals = new Map<string,number>();
  reviewRequests: { eventId: string; cardId: string; revision: number; rating: number }[] = [];
  undoRequests: { eventId: string }[] = [];
  saved = new Map<string,MockCard>();
  undone = new Set<string>();
  history: { eventId: string; card: MockCard; index: number }[] = [];
  reviewModes: ('ok' | 'abort' | 'abort-after-save' | '500' | '409')[] = [];
  undoModes: ('ok' | '409')[] = [];
  studyFailures = 0;
  failStudyAfterReview = 0;
  studyDelay = 0;
  studyRequests = 0;
  constructor(cards: MockCard[]) {
    this.queue = cards;
    for (const card of cards) this.totals.set(card.deckId,(this.totals.get(card.deckId) || 0) + 1);
    this.totals.set('3',5);
  }
  async attach(page: Page) {
    await page.route(`${BASE}/api/**`, route => this.handle(route));
    await page.route(`${BASE}/media/**`, route => route.request().url().endsWith('.png')
      ? route.fulfill({ status: 200, contentType: 'image/png', body: png })
      : route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) }));
  }
  private json(route: Route, status: number, data: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }); }
  private counts(ids: string[]) {
    const due = this.queue.filter(card => ids.includes(card.deckId)).length;
    return { new: due, learning: 0, review: 0, total: ids.reduce((n,id) => n + (this.totals.get(id) || 0),0) };
  }
  private answered(ids: string[]) { return this.history.filter(h => ids.includes(h.card.deckId)).length; }
  private summary(id: string, parentId: string | null) {
    const counts = this.counts(scope(id));
    return { id, name: deckNames[id], configId: '1', config, parentId, depth: parentId ? 1 : 0, label: deckNames[id].split('::').at(-1),
      ownCounts: counts, ownAnsweredToday: 0, counts, answeredToday: this.answered(scope(id)) };
  }
  private studyCard(card: MockCard) {
    const now = Date.now();
    const state = (s: number, due: number) => ({ state: s, due, stability: 2, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, lastReview: null, learningSteps: 0 });
    return { id: card.id, revision: card.revision, ordinal: 0, schedule: state(0,now),
      note: { id: `n${card.id}`, guid: `g${card.id}`, noteTypeId: card.noteType.id, fields: card.fields, tags: [] },
      noteType: card.noteType, deck: { id: card.deckId, name: deckNames[card.deckId], configId: '1', config },
      preview: { 1: state(1,now+minute), 2: state(1,now+6*minute), 3: state(2,now+day), 4: state(2,now+4*day) } };
  }
  private async handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/session') return this.json(route,200,{ authenticated: true, passwordRequired: true });
    if (path === '/api/logout') return this.json(route,200,{ ok: true });
    if (path === '/api/overview') return this.json(route,200,{ imported: true, warnings: [],
      decks: [this.summary('1',null), this.summary('10','1'), this.summary('2',null), this.summary('3',null)] });
    if (path.startsWith('/api/study/')) {
      this.studyRequests++;
      if (this.studyDelay) await new Promise(resolve => setTimeout(resolve,this.studyDelay));
      if (this.studyFailures > 0) { this.studyFailures--; return this.json(route,500,{ error: '次のカードを取得できませんでした（テスト）' }); }
      const ids = scope(decodeURIComponent(path.slice('/api/study/'.length)));
      const card = this.queue.find(c => ids.includes(c.deckId));
      return this.json(route,200,{ card: card ? this.studyCard(card) : null, counts: this.counts(ids), nextDue: card ? null : Date.now()+day, answeredToday: this.answered(ids) });
    }
    if (path === '/api/review') {
      const body = request.postDataJSON();
      this.reviewRequests.push(body);
      const mode = this.reviewModes.shift() ?? 'ok';
      if (mode === '500') return this.json(route,500,{ error: '保存に失敗しました（テスト）' });
      if (mode === '409') return this.json(route,409,{ error: '別の画面で更新されました。カードを読み直してください。' });
      if (mode === 'abort') return route.abort('failed');
      if (this.saved.has(body.eventId)) return this.undone.has(body.eventId) ? this.json(route,409,{ error: '回答IDが別の操作に使用されています。' }) : this.json(route,200,{ ok: true, eventId: body.eventId, duplicate: true });
      const index = this.queue.findIndex(c => c.id === body.cardId);
      if (index < 0 || this.queue[index].revision !== body.revision) return this.json(route,409,{ error: '別の画面で更新されました。カードを読み直してください。' });
      const [card] = this.queue.splice(index,1); card.revision++;
      this.saved.set(body.eventId,card); this.history.push({ eventId: body.eventId, card, index });
      this.studyFailures += this.failStudyAfterReview; this.failStudyAfterReview = 0;
      if (mode === 'abort-after-save') return route.abort('failed');
      return this.json(route,200,{ ok: true, eventId: body.eventId });
    }
    if (path === '/api/undo') {
      const body = request.postDataJSON();
      this.undoRequests.push(body);
      const last = this.history.at(-1);
      if (!last || last.eventId !== body.eventId || this.undoModes.shift() === '409') return this.json(route,409,{ error: 'このカードはその後に更新されているため、取り消せません。' });
      this.history.pop(); this.undone.add(body.eventId); last.card.revision++; this.queue.splice(last.index,0,last.card);
      return this.json(route,200,{ ok: true, cardId: last.card.id });
    }
    return this.json(route,404,{ error: 'APIが見つかりません。' });
  }
}

/** Counts speech, synthesized audio and fireworks without changing what the app decides to do. */
function instrument() {
  if (window.top !== window) return;
  const audible = new Set<AudioNode>();
  const fx = { speak: 0, cancel: 0, spoken: [] as string[], contexts: 0, oscillators: 0, bursts: 0, toasts: 0, get live() { return audible.size; } };
  (window as unknown as { __fx: typeof fx }).__fx = fx;
  // `live` counts nodes currently wired to the speakers, i.e. whether anything can still be heard.
  const proto = AudioNode.prototype as unknown as { connect: (...args: unknown[]) => unknown; disconnect: (...args: unknown[]) => unknown };
  const connect = proto.connect; const disconnect = proto.disconnect;
  proto.connect = function (this: AudioNode, ...args: unknown[]) { if (args[0] instanceof AudioDestinationNode) audible.add(this); return connect.apply(this,args); };
  proto.disconnect = function (this: AudioNode, ...args: unknown[]) { if (!args.length || args[0] instanceof AudioDestinationNode) audible.delete(this); return disconnect.apply(this,args); };
  const synth = window.speechSynthesis;
  if (synth) {
    const cancel = synth.cancel.bind(synth);
    synth.speak = (utterance: SpeechSynthesisUtterance) => { fx.speak++; fx.spoken.push(utterance.text); };
    synth.cancel = () => { fx.cancel++; cancel(); };
  }
  const Native = window.AudioContext;
  if (Native) {
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) { super(options); fx.contexts++; }
      createOscillator() { fx.oscillators++; return super.createOscillator(); }
    };
  }
  // Each fireworks canvas is counted once, even when it arrives inside a newly added effect layer.
  const seen = new WeakSet<Element>();
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const canvas of [node,...node.querySelectorAll('canvas.fireworks')]) if (canvas.matches('canvas.fireworks') && !seen.has(canvas)) { seen.add(canvas); fx.bursts++; }
      if (node.matches('.medal-toast') && !seen.has(node)) { seen.add(node); fx.toasts++; }
    }
  }).observe(document.body,{ childList: true, subtree: true }));
}
type Fx = { speak: number; cancel: number; spoken: string[]; contexts: number; oscillators: number; bursts: number; toasts: number; live: number };
const fx = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __fx: Fx }).__fx }));

async function open(page: Page, mock: MockApi) {
  await mock.attach(page);
  await page.addInitScript(instrument);
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading',{ name: '今日の復習' })).toBeVisible();
}
async function startDeck(page: Page, id: string) {
  await page.locator(`[data-deck="${id}"]`).click();
  await expect(page.locator('#reveal')).toBeVisible();
}
async function reveal(page: Page) {
  await page.locator('#reveal').click();
  await expect(page.locator('[data-rating="1"]')).toBeVisible();
}
/** Festival total as rendered by the app (the attribute carries the exact unformatted value). */
async function total(page: Page) {
  const value = await page.locator('[data-dopa-total]').first().getAttribute('data-dopa-total');
  return Number(value);
}
async function nextQuestion(page: Page) { await expect(page.locator('#reveal')).toBeVisible({ timeout: 5000 }); }
async function noOverflow(page: Page, width: number) {
  const scroll = await page.evaluate(() => Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));
  expect(scroll).toBeLessThanOrEqual(width);
}
async function shot(page: Page, name: string) {
  const size = page.viewportSize()!;
  await mkdir(SHOTS,{ recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${size.width}x${size.height}.png` });
}

test('Again and Good earn identical rewards shot for shot; the burst is short and the next card is quiet', async ({ browser }) => {
  const runs: number[][] = [];
  for (const order of [[1,3],[3,1]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const mock = new MockApi(koreanCards());
    await open(page,mock);
    await startDeck(page,'10');
    expect(await total(page)).toBe(0);
    const amounts: number[] = [];
    for (const rating of order) {
      await reveal(page);
      const before = await total(page);
      mock.studyDelay = 900;
      await page.keyboard.press(String(rating));
      const value = page.locator('#payoff .payoff-value');
      await expect(value).toBeVisible();
      await expect(page.locator('#payoff .payoff-unit')).toHaveText('ドパ');
      const shown = Number(await value.getAttribute('data-dopa-amount'));
      await nextQuestion(page);
      mock.studyDelay = 0;
      expect(mock.reviewRequests.at(-1)!.rating).toBe(rating);
      expect(await total(page) - before).toBe(shown);
      // Quiet next card: once the short "N枚目" wipe has passed nothing animates, and nothing ever covers the controls.
      await expect(page.locator('canvas')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.getAnimations().length),{ timeout: 1000 }).toBe(0);
      const hit = await page.locator('#reveal').evaluate(button => { const r = button.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width/2,r.y + r.height/2) === button; });
      expect(hit).toBe(true);
      amounts.push(shown);
    }
    // Without a slow network the burst ends by itself in well under two and a half seconds; Space skips it at once.
    await reveal(page);
    const started = Date.now();
    await page.keyboard.press('2');
    await expect(page.locator('#payoff')).toBeVisible();
    await nextQuestion(page);
    expect(Date.now() - started).toBeLessThan(2500);
    await reveal(page);
    await page.keyboard.press('4');
    await expect(page.locator('#payoff.is-bursting')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.locator('#payoff')).toHaveCount(0);
    expect((await fx(page)).bursts).toBe(4);
    runs.push(amounts);
    await page.close();
  }
  expect(runs[0]).toEqual(runs[1]);
  expect(runs[0][1]).toBeGreaterThan(runs[0][0]);
});

test('celebration audio is disconnected before the next recall card, and later payoffs still sound', async ({ page }) => {
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  // Skipped payoff.
  await reveal(page);
  await page.keyboard.press('3');
  await expect(page.locator('#payoff.is-bursting')).toBeVisible();
  await expect.poll(async () => (await fx(page)).live).toBe(1);
  await page.keyboard.press('Space');
  await nextQuestion(page);
  expect((await fx(page)).live).toBe(0);
  // Payoff that ends on its own.
  await reveal(page);
  const before = (await fx(page)).oscillators;
  await page.keyboard.press('2');
  await expect(page.locator('#payoff.is-bursting')).toBeVisible();
  await expect.poll(async () => (await fx(page)).live).toBe(1);
  expect((await fx(page)).oscillators).toBeGreaterThan(before);
  await nextQuestion(page);
  expect((await fx(page)).live).toBe(0);
});

test('undo during a sounding burst silences it and returns to a quiet recall, whether the undo fails or succeeds', async ({ page }) => {
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  const undo = page.getByRole('button',{ name: '取り消す' });
  const undoDuringBurst = async () => {
    await reveal(page);
    await page.keyboard.press('3');
    await expect(undo).toBeEnabled();
    await expect(page.locator('#payoff.is-bursting')).toBeVisible();
    await expect.poll(async () => (await fx(page)).live).toBe(1);
    await undo.click();
  };
  // Failed undo: the reward and the review stay, but the celebration is still silenced.
  mock.undoModes = ['409'];
  await undoDuringBurst();
  await expect(page.locator('.error')).toContainText('取り消せません');
  await nextQuestion(page);
  expect((await fx(page)).live).toBe(0);
  const kept = await total(page);
  expect(kept).toBeGreaterThan(0);
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('ありがとう');
  // Successful undo: exactly that reward is reversed and the same card comes back quietly.
  await undoDuringBurst();
  await expect(page.locator('.undo-note')).toContainText('ドパも戻しました');
  await nextQuestion(page);
  expect((await fx(page)).live).toBe(0);
  expect(await total(page)).toBe(kept);
  expect(mock.undoRequests.at(-1)!.eventId).toBe(mock.reviewRequests.at(-1)!.eventId);
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('ありがとう');
  await expect(page.locator('#payoff')).toHaveCount(0);
});

test('a delayed medal notice never restarts sound after a skip or an early undo', async ({ page }) => {
  // Page timers are paused so the 300ms medal callback provably fires after the skip/undo.
  await page.clock.install();
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  const undo = page.getByRole('button',{ name: '取り消す' });
  const rateWithMedal = async (key: string) => {
    const shown = (await fx(page)).toasts;
    await reveal(page);
    await page.keyboard.press(key);
    await expect(page.locator('#payoff.is-bursting')).toBeVisible();
    await expect(undo).toBeEnabled(); // the next card has loaded
    expect((await fx(page)).toasts).toBe(shown); // the medal callback has not fired yet
  };
  const afterCallback = async () => {
    const before = await fx(page);
    expect(before.live).toBe(0);
    await page.clock.runFor(500);
    const after = await fx(page);
    expect(after.live).toBe(0);
    expect(after.oscillators).toBe(before.oscillators);
  };
  // Early undo that fails: sound stays off, the medal and its non-blocking notice are kept.
  await rateWithMedal('3');
  mock.undoModes = ['409'];
  await undo.click();
  await expect(page.locator('.error')).toContainText('取り消せません');
  await afterCallback();
  expect(await toastIds(page)).toEqual(['first-review']);
  await page.locator('.medal-toast-close').click();
  // Early undo that succeeds: no sound and the pending notice is withdrawn.
  await rateWithMedal('1');
  await undo.click();
  await expect(page.locator('.undo-note')).toContainText('取り消しました');
  await afterCallback();
  await expect(page.locator('#medal-toast')).toHaveCount(0);
  // Skip on the next card before the callback: the notice appears, silently, over a quiet card.
  await rateWithMedal('1');
  await page.keyboard.press('Space');
  await nextQuestion(page);
  await afterCallback();
  expect(await toastIds(page)).toEqual(['first-again']);
  // A medal shown during a burst that is still playing does sound.
  await page.locator('.medal-toast-close').click();
  await reveal(page); await page.keyboard.press('3');
  await expect(page.locator('#payoff.is-bursting')).toBeVisible();
  const during = (await fx(page)).oscillators;
  await page.clock.runFor(350);
  expect(await toastIds(page)).toEqual(['comeback']);
  expect((await fx(page)).oscillators).toBeGreaterThan(during);
});

const MEDAL_SHOTS = '.local/verification/medals';
async function medalShot(page: Page, name: string) {
  const size = page.viewportSize()!;
  await mkdir(MEDAL_SHOTS,{ recursive: true });
  await page.screenshot({ path: `${MEDAL_SHOTS}/${name}-${size.width}x${size.height}.png` });
}
const toastIds = (page: Page) => page.locator('#medal-toast li[data-medal-id]').evaluateAll(items => items.map(item => item.getAttribute('data-medal-id')));
async function medalList(page: Page) {
  await page.locator('#open-medals').click();
  const items = page.locator('#medal-dialog [data-medal]');
  await expect(items).toHaveCount(10);
  const earned = await items.evaluateAll(list => Object.fromEntries(list.map(item => [item.getAttribute('data-medal'),item.getAttribute('data-earned') === 'true'])));
  return earned as Record<string,boolean>;
}

test('medals: simultaneous awards, retries, failed saves, undo, failed undo, reload and the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  // A lost response then a same-event retry: one Again earns two medals, announced once together.
  await reveal(page);
  mock.reviewModes = ['abort-after-save'];
  await page.keyboard.press('1');
  await expect(page.locator('.error')).toBeVisible();
  expect((await fx(page)).toasts).toBe(0);
  await page.keyboard.press('1');
  await expect(page.locator('#medal-toast')).toBeVisible();
  expect(await toastIds(page)).toEqual(['first-review','first-again']);
  await page.locator('.medal-toast-close').click();
  await expect(page.locator('#medal-toast')).toHaveCount(0);
  await nextQuestion(page);
  expect((await fx(page)).toasts).toBe(1);
  // A failed save earns nothing; its retry is a recall right after Again.
  await reveal(page);
  mock.reviewModes = ['500'];
  await page.keyboard.press('3');
  await expect(page.locator('.error')).toContainText('保存に失敗しました');
  expect((await fx(page)).toasts).toBe(1);
  await page.keyboard.press('3');
  await expect(page.locator('#medal-toast li[data-medal-id]')).toHaveCount(1);
  expect(await toastIds(page)).toEqual(['comeback']);
  await page.keyboard.press('Escape');
  await expect(page.locator('#medal-toast')).toHaveCount(0);
  await nextQuestion(page);
  await reveal(page); await page.keyboard.press('4'); await nextQuestion(page);
  await expect(page.locator('.streak-pill')).toHaveAttribute('data-streak','2');
  // Third recall in a row: two medals at once. A successful undo withdraws the notice and the medals.
  await reveal(page); await page.keyboard.press('2');
  await expect(page.locator('#medal-toast')).toBeVisible();
  expect(await toastIds(page)).toEqual(['remembered-3','balanced']);
  await nextQuestion(page);
  await expect(page.locator('.streak-pill')).toHaveAttribute('data-streak','3');
  await page.getByRole('button',{ name: '取り消す' }).click();
  await expect(page.locator('.undo-note')).toContainText('取り消しました');
  await expect(page.locator('#medal-toast')).toHaveCount(0);
  await expect(page.locator('.streak-pill')).toHaveAttribute('data-streak','2');
  // Earn them again, then a failed undo keeps them; a reload shows no notification again.
  await reveal(page); await page.keyboard.press('2');
  await expect(page.locator('#medal-toast li[data-medal-id]')).toHaveCount(2);
  await nextQuestion(page);
  mock.undoModes = ['409'];
  await page.getByRole('button',{ name: '取り消す' }).click();
  await expect(page.locator('.error')).toContainText('取り消せません');
  await page.reload();
  await nextQuestion(page);
  await page.waitForTimeout(500);
  expect((await fx(page)).toasts).toBe(0);
  await page.getByRole('button',{ name: '← デッキ一覧' }).click();
  await expect(page.locator('.medal-strip-count')).toContainText('5');
  const earned = await medalList(page);
  expect(earned).toEqual({ 'first-review': true, 'first-again': true, 'honest-3': false, 'remembered-3': true, 'remembered-5': false,
    'remembered-10': false, comeback: true, balanced: true, 'reviews-10': false, 'reviews-20': false });
  await expect(page.locator('#medal-dialog [data-medal="honest-3"]')).toContainText('「もう一度」を正直に3回選ぶ');
  await page.keyboard.press('Escape');
  await expect(page.locator('#medal-dialog')).toHaveCount(0);
});

for (const [width,height] of [[390,844],[1280,900]] as const) {
  test(`medal screens at ${width}x${height}: Again and recall feedback, the medal notice and the list`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const mock = new MockApi(koreanCards());
    await open(page,mock);
    await startDeck(page,'10');
    // Same reward, different tone: an honest Again is blue and kind, a recall is warm and counts the streak.
    await reveal(page);
    const againBefore = await total(page);
    await page.keyboard.press('1');
    await expect(page.locator('#payoff[data-verdict="again"]')).toBeVisible();
    await expect(page.locator('.stamp.is-again')).toContainText('また');
    await expect(page.locator('.payoff-verdict')).toContainText('正直に申告');
    const againAmount = Number(await page.locator('#payoff .payoff-value').getAttribute('data-dopa-amount'));
    await page.waitForTimeout(450);
    await medalShot(page,'again-feedback');
    await nextQuestion(page);
    expect(await total(page) - againBefore).toBe(againAmount);
    for (const key of ['3','4']) { await reveal(page); await page.keyboard.press(key); await nextQuestion(page); }
    await reveal(page);
    await page.keyboard.press('2');
    await expect(page.locator('#payoff[data-verdict="recalled"]')).toBeVisible();
    await expect(page.locator('.stamp')).toContainText('思い出せた');
    await expect(page.locator('.payoff-verdict')).toContainText('3連続');
    await expect(page.locator('#medal-toast')).toBeVisible();
    await page.waitForTimeout(700);
    await medalShot(page,'recall-feedback-and-medal');
    await nextQuestion(page);
    await medalShot(page,'medal-notice-over-next-card');
    // The notice stays over ドパハム's stage, above the card content, and never blocks studying.
    const notice = (await page.locator('#medal-toast').boundingBox())!;
    const sheet = (await page.locator('.card-sheet').boundingBox())!;
    expect(notice.y + notice.height).toBeLessThanOrEqual(sheet.y);
    await page.keyboard.press('Space');
    await expect(page.locator('[data-rating="1"]')).toBeVisible();
    await expect(page.locator('#medal-toast')).toHaveCount(0,{ timeout: 6000 });
    await page.getByRole('button',{ name: '← デッキ一覧' }).click();
    await expect(page.locator('.medal-strip')).toBeVisible();
    await medalShot(page,'home-medal-strip');
    await medalList(page);
    await medalShot(page,'medal-list');
    await page.keyboard.press('Escape');
  });
}

test('failed saves and 409 earn nothing; a same-event retry is rewarded exactly once', async ({ page }) => {
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  await reveal(page);
  // The server stores the review but the response is lost.
  mock.reviewModes = ['abort-after-save'];
  await page.keyboard.press('3');
  await expect(page.locator('.error')).toBeVisible();
  await expect(page.locator('.rating-help')).toContainText('同じ評価を押して再送');
  await expect(page.locator('[data-rating="1"]')).toBeDisabled();
  expect(await total(page)).toBe(0);
  await expect(page.locator('#payoff')).toHaveCount(0);
  await page.keyboard.press('3');
  await expect(page.locator('#payoff')).toBeVisible();
  await nextQuestion(page);
  const first = await total(page);
  expect(first).toBeGreaterThan(0);
  expect(mock.reviewRequests).toHaveLength(2);
  expect(mock.reviewRequests[1].eventId).toBe(mock.reviewRequests[0].eventId);
  expect(mock.saved.size).toBe(1);

  await reveal(page);
  mock.reviewModes = ['500'];
  await page.keyboard.press('1');
  await expect(page.locator('.error')).toContainText('保存に失敗しました');
  expect(await total(page)).toBe(first);
  await page.keyboard.press('1');
  await nextQuestion(page);
  const second = await total(page);
  expect(second).toBeGreaterThan(first);
  expect(mock.reviewRequests[3].eventId).toBe(mock.reviewRequests[2].eventId);

  await reveal(page);
  mock.reviewModes = ['409'];
  await page.keyboard.press('4');
  await expect(page.locator('.error')).toContainText('別の画面で更新されました');
  await nextQuestion(page);
  expect(await total(page)).toBe(second);
  expect((await fx(page)).bursts).toBe(2);
});

test('a saved review whose next-card load fails keeps one reward and cannot be rated twice', async ({ page }) => {
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  await reveal(page);
  mock.failStudyAfterReview = 1;
  await page.keyboard.press('3');
  await expect(page.locator('#payoff')).toBeVisible();
  const retry = page.getByRole('button',{ name: '次のカードを読み込む' });
  await expect(retry).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.error')).toContainText('次のカードを取得できませんでした');
  await expect(page.locator('[data-rating]')).toHaveCount(0);
  const rewarded = await total(page);
  expect(rewarded).toBeGreaterThan(0);
  for (const key of ['1','2','3','4','Space']) await page.keyboard.press(key);
  await nextQuestion(page);
  expect(mock.reviewRequests).toHaveLength(1);
  expect(await total(page)).toBe(rewarded);
  await expect(page.getByRole('button',{ name: '取り消す' })).toBeEnabled();
  expect((await fx(page)).bursts).toBe(1);
});

test('undo after reload reverses exactly the latest reward; reloads and finished screens add nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  await startDeck(page,'10');
  await reveal(page); await page.keyboard.press('3'); await nextQuestion(page);
  const first = await total(page);
  await reveal(page); await page.keyboard.press('1'); await nextQuestion(page);
  const second = await total(page);
  expect(second).toBeGreaterThan(first);
  await page.reload();
  await nextQuestion(page);
  expect(await total(page)).toBe(second);
  await expect(page.locator('#payoff')).toHaveCount(0);
  const undo = page.getByRole('button',{ name: '取り消す' });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator('.undo-note')).toContainText('ドパも戻しました');
  await nextQuestion(page);
  expect(await total(page)).toBe(first);
  expect(mock.undoRequests.at(-1)!.eventId).toBe(mock.reviewRequests.at(-1)!.eventId);
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('ありがとう');
  await page.reload();
  await nextQuestion(page);
  expect(await total(page)).toBe(first);
  await expect(page.getByRole('button',{ name: '取り消す' })).toBeDisabled();
  // A new real review at the same festival position earns the same amount again.
  await reveal(page); await page.keyboard.press('4'); await nextQuestion(page);
  expect(await total(page)).toBe(second);
  // Opening an already finished deck is not a reward.
  await page.getByRole('button',{ name: '← デッキ一覧' }).click();
  await page.locator('[data-deck="3"]').click();
  await expect(page.getByRole('heading',{ name: 'いまの復習は完了です' })).toBeVisible();
  await expect(page.locator('#finale')).not.toHaveClass(/is-celebrating/);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await total(page)).toBe(second);
  await page.reload();
  await expect(page.getByRole('heading',{ name: 'いまの復習は完了です' })).toBeVisible();
  await expect(page.locator('#finale')).not.toHaveClass(/is-celebrating/);
  expect(await total(page)).toBe(second);
  expect((await fx(page)).bursts).toBe(0);
});

test('keyboard, card iframe, media and escaped stage words are preserved without Korean assumptions', async ({ page }) => {
  const dialogs: string[] = []; page.on('dialog',dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const errors: string[] = []; page.on('pageerror',error => errors.push(error.message));
  const mock = new MockApi([...koreanCards(),...englishCards()]);
  await open(page,mock);
  await startDeck(page,'10');
  const frame = page.locator('#card-frame');
  await expect(frame).toHaveAttribute('sandbox','allow-same-origin');
  expect(await frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  const input = page.locator('#answer-input');
  await expect(input).toHaveAttribute('lang','ko-KR');
  await input.focus();
  await page.keyboard.type('안녕 1');
  await page.keyboard.press('Space');
  await expect(input).toHaveValue('안녕 1 ');
  await expect(page.locator('#reveal')).toBeVisible();
  await input.fill('안녕하세요');
  await page.keyboard.press('Enter');
  await expect(page.locator('#spotlight .spotlight-word')).toHaveText('안녕하세요');
  await expect(page.locator('#spotlight .spotlight-word')).toHaveAttribute('lang','ko-KR');
  const card = page.frameLocator('#card-frame');
  await expect(card.locator('.expected-answer')).toHaveText('안녕하세요');
  // The card document keeps its transparent .card body and light scheme; what shows through stays white.
  expect(await card.locator('html').evaluate(html => getComputedStyle(html).colorScheme)).toBe('light');
  expect(await frame.evaluate(iframe => [getComputedStyle(iframe).backgroundColor,getComputedStyle(iframe.parentElement!).backgroundColor])).toEqual(['rgb(255, 255, 255)','rgb(255, 255, 255)']);
  await expect(card.locator('img.flag')).toHaveAttribute('src',`${BASE}/media/flag.png`);
  await expect.poll(() => card.locator('img.flag').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.locator('#audio audio')).toHaveAttribute('src','/media/hello.mp3');
  await expect(page.locator('.answer-comparison')).toContainText('一致しています');
  await expect(page.getByRole('button',{ name: '▶ 読み上げる' })).toBeVisible();
  for (const [i,label] of ['もう一度','難しい','普通','簡単'].entries()) {
    await expect(page.locator(`[data-rating="${i+1}"]`)).toContainText(label);
    await expect(page.locator(`[data-rating="${i+1}"]`)).toHaveAttribute('aria-keyshortcuts',String(i+1));
  }
  await expect(page.locator('[data-rating="1"]')).toContainText('1分');
  await expect(page.locator('[data-rating="4"]')).toContainText('4日');
  await page.mouse.move(0,0);
  const looks = await page.locator('[data-rating]').evaluateAll(buttons => buttons.map(b => { const s = getComputedStyle(b); return `${s.backgroundImage}|${s.borderColor}|${s.color}|${b.getBoundingClientRect().width.toFixed(1)}`; }));
  expect(new Set(looks).size).toBe(1);
  await page.keyboard.press('Space');
  expect(mock.reviewRequests).toHaveLength(0);
  await page.keyboard.press('2');
  await nextQuestion(page);
  expect(mock.reviewRequests[0]).toMatchObject({ cardId: '1001', rating: 2, revision: 1 });

  await page.getByRole('button',{ name: '← デッキ一覧' }).click();
  await startDeck(page,'2');
  await expect(page.locator('#answer-input')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(page.locator('#spotlight .spotlight-word')).toHaveText('apple');
  await expect(page.locator('#spotlight .spotlight-word')).toHaveAttribute('lang','en-US');
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('りんご');
  await page.keyboard.press('3');
  await nextQuestion(page);
  await expect(page.locator('#answer-input')).not.toHaveAttribute('lang',/.+/);
  await page.keyboard.press('Enter');
  const word = page.locator('#spotlight .spotlight-word');
  await expect(word).toHaveText('x <img src=x onerror=alert(1)>');
  await expect(word).not.toHaveAttribute('lang',/.+/);
  await expect(page.locator('#spotlight img')).toHaveCount(0);
  await expect(page.frameLocator('#card-frame').locator('img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('reduced motion skips bursts; the sound setting persists and covers effects and automatic readout', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const mock = new MockApi(koreanCards());
  await open(page,mock);
  let state = await fx(page);
  expect(state.contexts).toBe(0); expect(state.speak).toBe(0);
  await startDeck(page,'10');
  state = await fx(page);
  expect(state.contexts).toBe(0); expect(state.speak).toBe(0);
  await reveal(page);
  state = await fx(page);
  expect(state.speak).toBe(1); expect(state.spoken).toEqual(['안녕하세요']);
  await page.keyboard.press('3');
  await nextQuestion(page);
  state = await fx(page);
  expect(state.bursts).toBe(0);
  expect(state.contexts).toBe(1);
  expect(state.oscillators).toBeGreaterThan(0);
  expect(state.live).toBe(0);
  expect(await total(page)).toBeGreaterThan(0);

  const toggle = page.locator('#sound-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed','true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','false');
  await page.reload();
  await nextQuestion(page);
  await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed','false');
  await reveal(page);
  expect((await fx(page)).speak).toBe(0);
  await page.getByRole('button',{ name: '▶ 読み上げる' }).click();
  expect((await fx(page)).speak).toBe(1);
  await page.keyboard.press('2');
  await nextQuestion(page);
  state = await fx(page);
  expect(state.oscillators).toBe(0); expect(state.contexts).toBe(0); expect(state.bursts).toBe(0);

  await reveal(page);
  let cancels = (await fx(page)).cancel;
  await page.getByRole('button',{ name: '← デッキ一覧' }).click();
  await expect(page.getByRole('heading',{ name: '今日の復習' })).toBeVisible();
  expect((await fx(page)).cancel).toBeGreaterThan(cancels);
  cancels = (await fx(page)).cancel;
  await page.getByRole('button',{ name: 'ログアウト' }).click();
  await expect(page.locator('#password')).toBeVisible();
  expect((await fx(page)).cancel).toBeGreaterThan(cancels);
});

test('a round-number milestone celebrates stopping without adding cards; huge numerals fit 320px', async ({ page, browser }) => {
  const seed = () => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded','1');
    sessionStorage.setItem('dopanki_festival',JSON.stringify({ total: 5e68, count: 499, last: null, counted: [] }));
  };
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = new MockApi(koreanCards());
  await page.addInitScript(seed);
  await open(page,mock);
  await expect(page.locator('.bar-dopa')).toContainText('無量大数');
  await startDeck(page,'10');
  await reveal(page);
  await page.keyboard.press('2');
  await expect(page.locator('#payoff .payoff-value')).toContainText('無量大数');
  await expect(page.locator('#payoff.is-break')).toBeVisible({ timeout: 5000 });
  const keepGoing = page.getByRole('button',{ name: /続ける/ });
  await expect(keepGoing).toBeVisible();
  await shot(page,'break');
  await noOverflow(page,390);
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page,320);
  const amountBox = await page.locator('#payoff .payoff-amount').boundingBox();
  expect(amountBox!.x).toBeGreaterThanOrEqual(0);
  expect(amountBox!.x + amountBox!.width).toBeLessThanOrEqual(320);
  // The break waits for a choice; it neither reviews nor schedules anything by itself.
  await page.waitForTimeout(600);
  await expect(page.locator('#payoff.is-break')).toBeVisible();
  expect(mock.reviewRequests).toHaveLength(1);
  await page.keyboard.press('Enter');
  await nextQuestion(page);
  await expect(page.frameLocator('#card-frame').locator('body')).toContainText('ありがとう');
  expect(mock.queue).toHaveLength(4);

  const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const second = new MockApi(koreanCards());
  await other.addInitScript(seed);
  await open(other,second);
  await startDeck(other,'10');
  await reveal(other);
  await other.keyboard.press('3');
  await other.getByRole('button',{ name: 'ここで休憩する' }).click({ timeout: 5000 });
  await expect(other.locator('.rest-note')).toContainText('おつかれさま');
  await expect(other.getByRole('heading',{ name: '今日の復習' })).toBeVisible();
  expect(second.reviewRequests).toHaveLength(1);
  expect(second.queue).toHaveLength(4);
  await startDeck(other,'10');
  await expect(other.frameLocator('#card-frame').locator('body')).toContainText('ありがとう');
  await other.close();
});

for (const [width,height] of [[1280,900],[390,844]] as const) {
  test(`festival screens at ${width}x${height}: home, question, answer, payoff timeline, fever, end and login`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height });
    const mock = new MockApi([...koreanCards().slice(0,3),...englishCards()]);
    await open(page,mock);
    await noOverflow(page,width);
    await shot(page,'home');
    await startDeck(page,'10');
    await noOverflow(page,width);
    await shot(page,'question');
    await page.locator('#answer-input').fill('안녕하세요');
    await reveal(page);
    await expect(page.locator('#spotlight')).toBeVisible();
    await page.waitForTimeout(120);
    await shot(page,'answer-reveal-120ms');
    await page.waitForTimeout(700);
    await noOverflow(page,width);
    await shot(page,'answer');
    if (width < 400) {
      await page.setViewportSize({ width: 320, height: 700 });
      await noOverflow(page,320);
      await page.setViewportSize({ width, height });
    }
    // First reward: frames across the burst, then the wipe into a still next card.
    await page.keyboard.press('3');
    await expect(page.locator('#payoff.is-bursting')).toBeVisible();
    for (const [at,wait] of [[100,100],[400,300],[800,400]] as const) {
      await page.waitForTimeout(wait);
      await shot(page,`payoff-1-${at}ms`);
    }
    await noOverflow(page,width);
    await nextQuestion(page);
    await shot(page,'payoff-1-wipe');
    await expect.poll(() => page.evaluate(() => document.getAnimations().length),{ timeout: 1000 }).toBe(0);
    await shot(page,'next-question-quiet');
    // A long session: the crew has grown, the stage is in FEVER and the total crosses a new unit.
    const fever = await browser.newPage({ viewport: { width, height } });
    await fever.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded','1');
      sessionStorage.setItem('dopanki_festival',JSON.stringify({ total: 9000, count: 40, last: null, counted: [] }));
    });
    await open(fever,new MockApi(koreanCards()));
    await shot(fever,'home-after-session');
    await startDeck(fever,'10');
    await shot(fever,'fever-question');
    await reveal(fever);
    await fever.keyboard.press('1');
    await expect(fever.locator('#payoff.is-bursting')).toBeVisible();
    for (const [at,wait] of [[120,120],[450,330],[900,450],[1300,400]] as const) {
      await fever.waitForTimeout(wait);
      await shot(fever,`fever-payoff-${at}ms`);
    }
    await noOverflow(fever,width);
    await nextQuestion(fever);
    await expect.poll(() => fever.evaluate(() => document.getAnimations().length),{ timeout: 1000 }).toBe(0);
    await shot(fever,'fever-next-question-quiet');
    await fever.close();
    // Last card: the finished screen celebrates once.
    await reveal(page);
    await page.keyboard.press('1');
    await nextQuestion(page);
    await reveal(page);
    await page.keyboard.press('4');
    await expect(page.locator('#finale.is-celebrating')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#fx-layer canvas.fireworks')).toHaveCount(1);
    await page.waitForTimeout(300);
    await shot(page,'end-300ms');
    await page.waitForTimeout(900);
    await noOverflow(page,width);
    await shot(page,'end');
    await page.getByRole('button',{ name: 'もう一度確認' }).click();
    await expect(page.locator('#finale')).not.toHaveClass(/is-celebrating/);
    await page.getByRole('button',{ name: 'ログアウト' }).click();
    await expect(page.locator('#password')).toBeVisible();
    await noOverflow(page,width);
    await shot(page,'login');
  });
}
