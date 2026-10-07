import { describe, expect, it } from 'vitest';
import { normalizedAnswer } from '../src/lib/render';
import { answerComparison, answerDiff, type DiffOp } from './answer-diff';

const typedRow = (ops: DiffOp[]) => ops.map(op => op.kind === 'same' ? op.input : op.kind === 'extra' ? `[-${op.input}]` : `[+${op.expected}]`).join('');

describe('typed answer diff', () => {
  it('matches exactly when normalizedAnswer does: NFC, trimmed and collapsed whitespace', () => {
    expect(answerDiff('  안녕하세요 ','안녕하세요')).toEqual({ matched: true, ops: [{ kind: 'same', input: '안녕하세요', expected: '안녕하세요' }] });
    expect(answerDiff('café  au\tlait','café au lait').matched).toBe(true);
    expect(answerDiff('Apple','apple').matched).toBe(false);
  });

  it('ignores accents only for {{type:nc:}} fields, still showing the expected spelling', () => {
    expect(answerDiff('cafe','café').matched).toBe(false);
    expect(answerDiff('cafe','café',true)).toEqual({ matched: true, ops: [{ kind: 'same', input: 'cafe', expected: 'café' }] });
    // Accent-blind alignment keeps the real typo, not the accents, highlighted.
    expect(typedRow(answerDiff('resume','résumé!',true).ops)).toBe('resume[+!]');
    for (const [input,expected,nc] of [['cafe','café',true],['abc','abd',false],['  x ','x',false]] as const) {
      expect(answerDiff(input,expected,nc).matched).toBe(normalizedAnswer(input,nc) === normalizedAnswer(expected,nc));
    }
  });

  it('marks missing, extra and changed characters by grapheme', () => {
    expect(typedRow(answerDiff('안녕','안녕하세요').ops)).toBe('안녕[+하세요]');
    expect(typedRow(answerDiff('colour','color').ops)).toBe('colo[-u]r');
    expect(typedRow(answerDiff('recieve','receive').ops)).toBe('rec[-i]e[+i]ve');
    expect(typedRow(answerDiff('食べもの','食べ物').ops)).toBe('食べ[-もの][+物]');
    expect(typedRow(answerDiff('👍🏽ok','👍🏾ok').ops)).toBe('[-👍🏽][+👍🏾]ok');
  });

  it('shows unrelated words as one replaced span instead of scattered coincidences', () => {
    expect(typedRow(answerDiff('apple','orange').ops)).toBe('[-appl][+orang]e');
    expect(typedRow(answerDiff('たべもの','食べ物').ops)).toBe('[-たべもの][+食べ物]');
  });

  it('keeps shared words visible even when most of a sentence is missing', () => {
    const { ops, matched } = answerDiff('가방을 너무','가방이 너무 무거웠어요.');
    expect(matched).toBe(false);
    expect(typedRow(ops)).toBe('가방[-을][+이] 너무[+ 무거웠어요.]');
    expect(answerComparison('가방을 너무','가방이 너무 무거웠어요.')).toContain('가방<del>을</del> 너무');
    // Shared text away from either edge must survive unrelated surrounding text too.
    expect(typedRow(answerDiff('xxx 너무 yyy','zzzzz 너무 wwwww').ops)).toBe('[-xxx][+zzzzz] 너무 [-yyy][+wwwww]');
  });

  it('bounds the work on very long answers', () => {
    const long = 'あ'.repeat(600);
    expect(answerDiff(`x${long}y`,`z${long.replaceAll('あ','い')}w`).ops).toEqual([{ kind: 'extra', input: `x${long}y` },{ kind: 'missing', expected: `z${long.replaceAll('あ','い')}w` }]);
  });
});

describe('answer comparison markup', () => {
  it('renders nothing when the learner typed nothing', () => {
    expect(answerComparison('','안녕하세요')).toBe('');
    expect(answerComparison('   ','안녕하세요')).toBe('');
  });

  it('shows the answer once with a match note', () => {
    const html = answerComparison('안녕하세요 ','안녕하세요',false,'ko-KR');
    expect(html).toContain('is-match');
    expect(html).toContain('<div class="answer-value" lang="ko-KR">안녕하세요</div>');
    expect(html).toContain('入力と一致しています');
    expect(html.match(/answer-row/g)).toHaveLength(1);
  });

  it('marks the input row and the answer row, with a gap where something is missing', () => {
    const html = answerComparison('안녕','안녕하세요');
    expect(html).toContain('あなたの入力</span><div class="answer-value">안녕<span class="answer-gap" role="img" aria-label="不足"></span></div>');
    expect(html).toContain('正解</span><div class="answer-value">안녕<ins>하세요</ins></div>');
    expect(html).toContain('足りない・正しい文字');
    expect(html).not.toContain('余分・違う文字');
    const changed = answerComparison('食べもの','食べ物');
    expect(changed).toContain('食べ<del>もの</del></div>');
    expect(changed).toContain('食べ<ins>物</ins></div>');
    expect(changed).not.toContain('answer-gap');
  });

  it('escapes both the typed and the expected text', () => {
    const html = answerComparison('<img src=x onerror=alert(1)>','x <b>',false,'en" onclick="x');
    expect(html).not.toMatch(/<img|<b>|" onclick/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('lang="en&quot; onclick=&quot;x"');
  });
});
