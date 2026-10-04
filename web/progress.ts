import { escapeHtml } from '../src/lib/render';
import type { ProgressResponse } from '../src/lib/types';

const number = (value: number) => value.toLocaleString('ja-JP');
// Dates are study-day labels from the server, not instants in the browser's timezone.
const dateLabel = (date: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short',
}).format(new Date(`${date}T12:00:00Z`));
const level = (answers: number) => answers === 0 ? 0 : answers < 5 ? 1 : answers < 20 ? 2 : answers < 50 ? 3 : 4;

export function tomorrowMarkup(progress: ProgressResponse): string {
  const t = progress.tomorrow;
  const headline = t.movedBeyondTomorrow > 0
    ? `<strong>${number(t.movedBeyondTomorrow)}<small>枚</small></strong>を明後日以降へ`
    : t.reviewedCards > 0 ? '今日の積み重ねを記録しました' : '今日の1枚が、明日の自分につながる';
  const result = t.netReduction > 0
    ? `今日の学習で、明日への持ち越しが${number(t.netReduction)}枚減りました。`
    : t.netReduction < 0
      ? `今日の学習で、明日までの復習予定が${number(-t.netReduction)}枚増えました。少しずつ定着させていこう。`
      : t.reviewedCards > 0 ? '明日までの復習予定の枚数は変わらず。今日取り組んだ記録は残ります。'
        : '復習すると、明日への持ち越しがどれだけ減ったか見られます。';
  return `<section class="tomorrow-card" aria-labelledby="tomorrow-title">
    <p class="progress-eyebrow" id="tomorrow-title">明日の自分へ <span>全デッキ</span></p>
    <p class="tomorrow-headline">${headline}</p><p class="tomorrow-result">${result}</p>
    <dl class="tomorrow-stats"><div><dt>今日取り組んだカード</dt><dd>${number(t.reviewedCards)}<small>枚</small></dd></div><div><dt>明日までに復習予定</dt><dd>${number(t.dueCards)}<small>枚</small></dd></div></dl>
    ${t.addedForTomorrow ? `<p class="tomorrow-added">新しく学んだ${number(t.addedForTomorrow)}枚も、明日までの復習に加わりました。</p>` : ''}
    <details class="progress-explanation"><summary>数字の見方</summary><p>今日のDopankiでの最初の回答前と、最後の回答後の予定をカードごとに比較しています。同じカードへの複数の回答は1枚として数えます。停止中のカードは含みません。</p><p>「明日まで」には今日の未完了分も含み、日次上限をかける前の枚数です。新規学習や今後の回答で予定は変わります。取り込んだAnki履歴とカスタム学習はカレンダーに含みますが、この比較には含みません。</p></details>
  </section>`;
}

export function calendarMarkup(progress: ProgressResponse): string {
  const first = progress.days[0];
  const padding = first ? (new Date(`${first.date}T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const today = progress.days.find(day => day.date === progress.today);
  const selected = today ?? progress.days.at(-1);
  return `<section class="learning-calendar" aria-labelledby="calendar-title">
    <div class="calendar-heading"><div><p class="progress-eyebrow">毎日の積み重ね</p><h2 id="calendar-title">学習カレンダー</h2></div><span class="calendar-period">直近26週間</span></div>
    <dl class="calendar-stats"><div><dt>累計の学習日</dt><dd>${number(progress.totalStudyDays)}<small>日</small></dd></div><div><dt>今週</dt><dd>${progress.weekStudyDays}<small>日</small></dd></div><div><dt>今日の回答</dt><dd>${number(progress.todayAnswers)}<small>回</small></dd></div></dl>
    <p class="calendar-note">今日の内訳：通常学習 ${number(progress.todayNormalAnswers ?? progress.todayAnswers)}回 · カスタム学習 ${number(progress.todayPracticeAnswers ?? 0)}回</p>
    <div class="calendar-scroll"><div class="calendar-chart"><div class="calendar-weekdays" aria-hidden="true"><span>月</span><span></span><span>水</span><span></span><span>金</span><span></span><span>日</span></div><div class="calendar-cells" role="group" aria-label="日ごとの学習記録。矢印キーで日を選べます">
      ${'<span class="calendar-pad" aria-hidden="true"></span>'.repeat(padding)}${progress.days.map(day => {
        const label = `${dateLabel(day.date)}、${number(day.answers)}回答`;
        return `<button class="calendar-day level-${level(day.answers)}${day.date === progress.today ? ' is-today' : ''}" data-date="${escapeHtml(day.date)}" data-answers="${day.answers}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-pressed="${day === selected}" tabindex="${day === selected ? 0 : -1}"></button>`;
      }).join('')}
    </div></div></div>
    <div class="calendar-footer"><p class="calendar-selection" aria-live="polite">${selected ? `${dateLabel(selected.date)} · ${number(selected.answers)}回答` : 'まだ学習記録がありません'}</p><div class="calendar-legend" aria-label="色が濃いほど回答が多い日"><span>少</span>${[0,1,2,3,4].map(n => `<i class="level-${n}" aria-hidden="true"></i>`).join('')}<span>多</span></div></div>
    <p class="calendar-note">1枚でも色がつきます。「もう一度」も同じ1回答。休んでも、積み重ねた日数は残ります。</p>
  </section>`;
}

// On the home screen the records sit behind one summary bar so the deck list stays in view.
// The open/closed choice is a local display preference, like the deck tree's collapsed state.
const recordsKey = 'dopanki_records_open';
let recordsOpen = (() => { try { return localStorage.getItem(recordsKey) === '1'; } catch { return false; } })();

function recordsMarkup(progress: ProgressResponse): string {
  const t = progress.tomorrow;
  const week = progress.days.slice(-7).map(day => `<i class="level-${level(day.answers)}${day.date === progress.today ? ' is-today' : ''}"></i>`).join('');
  return `<button class="records-toggle" id="records-toggle" aria-expanded="${recordsOpen}" aria-controls="records-panel">
      <span class="records-title"><span class="records-chevron" aria-hidden="true"></span>学習の記録</span>
      <span class="records-week" aria-hidden="true">${week}</span>
      <span class="records-facts"><span><small>累計</small><b>${number(progress.totalStudyDays)}</b>日</span><span><small>今週</small><b>${progress.weekStudyDays}</b>日</span><span><small>今日</small><b>${number(progress.todayAnswers)}</b>回答</span><span class="records-tomorrow"><small>明日までの復習</small><b>${number(t.dueCards)}</b>枚${t.movedBeyondTomorrow > 0 ? ` <em>${number(t.movedBeyondTomorrow)}枚を明後日以降へ</em>` : ''}</span></span>
      <span class="records-hint" aria-hidden="true">${recordsOpen ? '閉じる' : '詳しく'}</span>
    </button>
    <div class="records-panel" id="records-panel" ${recordsOpen ? '' : 'hidden'}><div class="daily-progress">${calendarMarkup(progress)}${tomorrowMarkup(progress)}</div></div>`;
}

export function progressMarkup(progress: ProgressResponse | null, error: boolean, mode: 'home' | 'summary'): string {
  if (error) return '<p class="progress-unavailable" role="status">学習記録を読み込めませんでした。<button class="progress-retry">再読み込み</button></p>';
  if (!progress) return '<p class="progress-loading" role="status">学習記録を読み込んでいます…</p>';
  return mode === 'home' ? recordsMarkup(progress) : tomorrowMarkup(progress);
}

export function bindProgress(container: Element, retry: () => void): void {
  container.querySelector('.progress-retry')?.addEventListener('click', retry);
  const toggle = container.querySelector<HTMLButtonElement>('.records-toggle');
  toggle?.addEventListener('click', () => {
    recordsOpen = !recordsOpen;
    try { localStorage.setItem(recordsKey, recordsOpen ? '1' : '0'); } catch { /* The records still open for this view. */ }
    toggle.setAttribute('aria-expanded', String(recordsOpen));
    toggle.querySelector('.records-hint')!.textContent = recordsOpen ? '閉じる' : '詳しく';
    container.querySelector('.records-panel')?.toggleAttribute('hidden', !recordsOpen);
  });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.calendar-day')];
  const select = (button: HTMLButtonElement) => {
    for (const other of buttons) {
      other.setAttribute('aria-pressed', String(other === button));
      other.tabIndex = other === button ? 0 : -1;
    }
    const label = container.querySelector('.calendar-selection');
    if (label) label.textContent = `${dateLabel(button.dataset.date!)} · ${number(Number(button.dataset.answers))}回答`;
  };
  for (const [index,button] of buttons.entries()) {
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', event => {
      const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : offset === undefined ? null : Math.max(0,Math.min(buttons.length - 1,index + offset));
      if (next === null) return;
      event.preventDefault(); select(buttons[next]); buttons[next].focus();
    });
  }
}
