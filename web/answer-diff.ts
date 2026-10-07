import { escapeHtml, normalizedAnswer } from '../src/lib/render';

/** `extra` exists only in the typed answer, `missing` only in the expected one; an adjacent pair is a changed span. */
export type DiffOp = { kind: 'same'; input: string; expected: string } | { kind: 'extra'; input: string } | { kind: 'missing'; expected: string };

const graphemes = (s: string) => typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined,{ granularity: 'grapheme' }).segment(s)].map(g => g.segment) : [...s];

/** Grapheme diff of a typed answer, compared under the same rules as answer matching (NFC, collapsed whitespace, optional accents). */
export function answerDiff(input: string, expected: string, ignoreAccents = false): { matched: boolean; ops: DiffOp[] } {
  const matched = normalizedAnswer(input,ignoreAccents) === normalizedAnswer(expected,ignoreAccents);
  const a = graphemes(normalizedAnswer(input)), b = graphemes(normalizedAnswer(expected));
  const key = (g: string) => ignoreAccents ? normalizedAnswer(g,true) || g : g;
  const ops: DiffOp[] = [];
  const same = (x: string, y: string) => { const last = ops.at(-1); if (last?.kind === 'same') { last.input += x; last.expected += y; } else if (x || y) ops.push({ kind: 'same', input: x, expected: y }); };
  const extra = (x: string) => { const last = ops.at(-1); if (last?.kind === 'extra') last.input += x; else if (x) ops.push({ kind: 'extra', input: x }); };
  const missing = (y: string) => { const last = ops.at(-1); if (last?.kind === 'missing') last.expected += y; else if (y) ops.push({ kind: 'missing', expected: y }); };
  let start = 0;
  while (start < a.length && start < b.length && key(a[start]) === key(b[start])) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && key(a[endA-1]) === key(b[endB-1])) { endA--; endB--; }
  same(a.slice(0,start).join(''),b.slice(0,start).join(''));
  const x = a.slice(start,endA), y = b.slice(start,endB), n = x.length, m = y.length;
  // Imported fields can hold whole sentences: bound the table so a long answer cannot stall the page.
  const rows = n && m && n * m <= 250_000 ? Array.from({ length: n + 1 },() => new Uint32Array(m + 1)) : null;
  if (rows) for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) rows[i][j] = key(x[i]) === key(y[j]) ? rows[i+1][j+1] + 1 : Math.max(rows[i+1][j],rows[i][j+1]);
  if (!rows) { extra(x.join('')); missing(y.join('')); }
  else {
    // Low overall similarity must not erase a shared word in a partially typed sentence.
    // Suppress only isolated coincidences, retaining substantive shared runs as anchors.
    const sparse = rows[0][0] * 2 < Math.max(n,m);
    let i = 0, j = 0, changedInput = '', changedExpected = '';
    const flush = () => { extra(changedInput); missing(changedExpected); changedInput = ''; changedExpected = ''; };
    while (i < n || j < m) {
      if (i < n && j < m && key(x[i]) === key(y[j])) {
        const fromI = i, fromJ = j;
        while (i < n && j < m && key(x[i]) === key(y[j])) { i++; j++; }
        const inputRun = x.slice(fromI,i).join(''), expectedRun = y.slice(fromJ,j).join('');
        if (!sparse || x.slice(fromI,i).filter(g => g.trim()).length >= 2) {
          flush(); same(inputRun,expectedRun);
        } else { changedInput += inputRun; changedExpected += expectedRun; }
      }
      else if (i < n && (j === m || rows[i+1][j] >= rows[i][j+1])) changedInput += x[i++];
      else changedExpected += y[j++];
    }
    flush();
  }
  same(a.slice(endA).join(''),b.slice(endB).join(''));
  return { matched, ops };
}

/**
 * The revealed comparison between what was typed and the expected answer, or '' when nothing was typed.
 * The typed row marks extra or wrong characters and where something is missing; the answer row marks what was missing.
 */
export function answerComparison(input: string, expected: string, ignoreAccents = false, lang?: string): string {
  if (!normalizedAnswer(input)) return '';
  const attr = lang ? ` lang="${escapeHtml(lang)}"` : '';
  const row = (kind: string, label: string, value: string) => `<div class="answer-row is-${kind}"><span class="answer-label">${label}</span><div class="answer-value"${attr}>${value}</div></div>`;
  const { matched, ops } = answerDiff(input,expected,ignoreAccents);
  if (matched) return `<section class="answer-comparison is-match" aria-label="入力と正解の比較">${row('expected','正解',escapeHtml(normalizedAnswer(expected)))}<p class="answer-status"><span aria-hidden="true">✓ </span>入力と一致しています</p></section>`;
  const replaced = (i: number) => ops[i-1]?.kind === 'extra' || ops[i+1]?.kind === 'extra';
  const typed = ops.map((op,i) => op.kind === 'same' ? escapeHtml(op.input) : op.kind === 'extra' ? `<del>${escapeHtml(op.input)}</del>` : replaced(i) ? '' : '<span class="answer-gap" role="img" aria-label="不足"></span>').join('');
  const answer = ops.map(op => op.kind === 'same' ? escapeHtml(op.expected) : op.kind === 'missing' ? `<ins>${escapeHtml(op.expected)}</ins>` : '').join('');
  const legend = [ops.some(op => op.kind === 'extra') ? '<span><del>字</del>余分・違う文字</span>' : '', ops.some(op => op.kind === 'missing') ? '<span><ins>字</ins>足りない・正しい文字</span>' : ''].join('');
  return `<section class="answer-comparison is-different" aria-label="入力と正解の比較">${row('input','あなたの入力',typed)}${row('expected','正解',answer)}${legend ? `<p class="answer-legend" aria-hidden="true">${legend}</p>` : ''}</section>`;
}

/** Shared look of the comparison; the card iframe cannot see the app stylesheet, so it gets this copy. */
export const answerComparisonCss = `.answer-comparison{width:fit-content;min-width:min(100%,260px);max-width:100%;box-sizing:border-box;margin:12px auto;padding:12px 16px;border:1.5px solid #f2c9b4;border-radius:14px;background:#fff8f3;text-align:left;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Noto Sans',sans-serif;color:#252923}
.answer-comparison.is-match{border-color:#b9e3cd;background:#f2faf5}
.answer-comparison .answer-row+.answer-row{margin-top:8px;padding-top:8px;border-top:1px dashed #ead8cc}
.answer-comparison .answer-label{display:block;font-size:12px;font-weight:600;color:#6b6478;letter-spacing:.04em}
.answer-comparison .answer-value{font-size:1.5em;font-weight:600;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.answer-comparison .is-input .answer-value{font-weight:500}
.answer-comparison del{color:#a3301f;background:#fde0d8;text-decoration:line-through 2px;border-radius:4px;padding:0 1px}
.answer-comparison ins{color:#13603d;background:#d4f0df;text-decoration:underline 2px;text-underline-offset:.18em;border-radius:4px;padding:0 1px}
.answer-comparison .answer-gap{display:inline-block;width:.5em;height:.9em;margin:0 1px;vertical-align:-.08em;border-radius:3px;background:#d4f0df;box-shadow:inset 0 -3px #2b8a5c}
.answer-comparison .answer-status{margin:8px 0 0;font-size:13px;font-weight:600;color:#13603d}
.answer-comparison .answer-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:10px 0 0;font-size:12px;color:#6b6478}
.answer-comparison .answer-legend del,.answer-comparison .answer-legend ins{margin-right:4px;font-weight:600}`;
