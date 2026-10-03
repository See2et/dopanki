import type { StudyCard } from './types';

export interface Speech { text: string; lang: string; voices: string[]; rate: number }
export interface RenderedCard {
  html: string; css: string; speech: Speech[]; sounds: string[];
  typedAnswer: { expected: string; ignoreAccents: boolean } | null;
  warnings: string[];
}
export const escapeHtml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function plainText(s: string): string {
  return s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
export function normalizedAnswer(s: string, ignoreAccents = false): string {
  const n = s.normalize('NFC').trim().replace(/\s+/g,' ');
  return ignoreAccents ? n.normalize('NFD').replace(/\p{M}/gu,'').normalize('NFC') : n;
}
/** Balanced scan also preserves Anki's nested clozes. */
export function clozeText(text: string, ordinal: number, side: 'front' | 'back', only = false): string {
  let output = ''; let cursor = 0; const targets: string[] = [];
  const pattern = /{{c(\d+)::/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    output += text.slice(cursor, match.index);
    let depth = 1; let end = pattern.lastIndex; let hintAt = -1;
    for (; end < text.length; end++) {
      if (text.slice(end,end+2) === '{{') { depth++; end++; }
      else if (text.slice(end,end+2) === '}}') { depth--; if (!depth) break; end++; }
      else if (depth === 1 && hintAt < 0 && text.slice(end,end+2) === '::') { hintAt = end; end++; }
    }
    if (depth) { output += text.slice(match.index); cursor = text.length; break; }
    const value = text.slice(pattern.lastIndex, hintAt >= 0 ? hintAt : end);
    const hint = hintAt >= 0 ? plainText(text.slice(hintAt+2,end)) : '…';
    const target = Number(match[1]) === ordinal+1;
    const answer = clozeText(value,ordinal,side);
    if (target) {
      const shown = side === 'front' ? `[${escapeHtml(hint)}]` : answer;
      targets.push(shown);
      output += `<span class="cloze">${shown}</span>`;
    } else output += answer;
    cursor = end+2; pattern.lastIndex = cursor;
  }
  output += text.slice(cursor);
  return only ? targets.join(', ') : output;
}
type Token = { kind: 'text'; value: string } | { kind: 'field'; value: string } | { kind: 'conditional'; value: string; inverted: boolean; children: Token[] };
function parse(template: string): Token[] {
  const root: Token[] = []; const stack: { name: string; nodes: Token[] }[] = [{ name: '', nodes: root }];
  const re = /{{([^{}]+)}}/g; let cursor = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const nodes = stack.at(-1)!.nodes;
    if (cursor < m.index) nodes.push({ kind: 'text', value: template.slice(cursor,m.index) });
    const value = m[1].trim();
    if (value[0] === '#' || value[0] === '^') {
      const conditional: Token = { kind: 'conditional', value: value.slice(1), inverted: value[0] === '^', children: [] };
      nodes.push(conditional); stack.push({ name: conditional.value, nodes: conditional.children });
    } else if (value[0] === '/') {
      if (stack.length > 1 && stack.at(-1)!.name === value.slice(1)) stack.pop();
      else nodes.push({ kind: 'text', value: escapeHtml(m[0]) });
    } else nodes.push({ kind: 'field', value });
    cursor = re.lastIndex;
  }
  stack.at(-1)!.nodes.push({ kind: 'text', value: template.slice(cursor) });
  return root;
}
export function renderCard(card: StudyCard, side: 'front' | 'back', frontHtml = ''): RenderedCard {
  const { note, noteType, ordinal, deck } = card;
  const template = noteType.templates[noteType.kind === 'cloze' ? 0 : ordinal];
  const result: RenderedCard = { html: '', css: noteType.css, speech: [], sounds: [], typedAnswer: null, warnings: [] };
  if (/<script\b|\son\w+\s*=/i.test(template.front + template.back)) result.warnings.push('テンプレート内のJavaScriptは実行しません。');
  const fields = Object.fromEntries(noteType.fields.map((name,i) => [name,note.fields[i] ?? '']));
  Object.assign(fields, { Tags: note.tags.join(' '), Type: noteType.name, Deck: deck.name, Subdeck: deck.name.split('::').at(-1)!, Card: template.name, FrontSide: frontHtml });
  function replace(value: string): string {
    const bits = value.split(':');
    const name = bits.pop()!;
    let content = fields[name] ?? '';
    if (!(name in fields)) result.warnings.push(`未対応または不明なフィールド: ${value}`);
    if (bits.includes('type') && bits.includes('cloze')) {
      const expected = plainText(clozeText(content,ordinal,'back',true));
      result.typedAnswer = { expected, ignoreAccents: bits.includes('nc') };
      return side === 'front' ? '' : `<div class="expected-answer">${escapeHtml(expected)}</div>`;
    }
    for (const filter of bits.reverse()) {
      if (filter === 'cloze') content = clozeText(content,ordinal,side);
      else if (filter === 'cloze-only') content = clozeText(content,ordinal,side,true);
      else if (filter === 'text') content = escapeHtml(plainText(content));
      else if (filter === 'type') {
        const expected = plainText(content);
        result.typedAnswer = { expected, ignoreAccents: bits.includes('nc') };
        content = side === 'front' ? '' : `<div class="expected-answer">${escapeHtml(expected)}</div>`;
      } else if (filter === 'nc') { /* handled by type */ }
      else if (filter.startsWith('tts ')) {
        const options = filter.slice(4).trim().split(/\s+/);
        const lang = (options[0] || 'en_US').replaceAll('_','-');
        const voices = options.find(s => s.startsWith('voices='))?.slice(7).split(',') || [];
        const rate = Number(options.find(s => s.startsWith('speed='))?.slice(6) || 1);
        const text = plainText(content).trim();
        if (text) result.speech.push({ text, lang, voices, rate: Number.isFinite(rate) ? Math.max(0.1,Math.min(3,rate)) : 1 });
        content = '';
      } else if (['furigana','kana','kanji'].includes(filter)) {
        content = content.replace(/([^\s\[\]]+)\[([^\]]+)\]/g, (_, kanji: string, reading: string) => filter === 'kana' ? reading : filter === 'kanji' ? kanji : `<ruby>${kanji}<rt>${reading}</rt></ruby>`);
      } else result.warnings.push(`未対応のフィルター: ${filter}`);
    }
    return content;
  }
  const walk = (tokens: Token[]): string => tokens.map(t => t.kind === 'text' ? t.value : t.kind === 'field' ? replace(t.value) : (Boolean(plainText(fields[t.value] ?? '').trim()) !== t.inverted ? walk(t.children) : '')).join('');
  result.html = walk(parse(side === 'front' ? template.front : template.back));
  result.html = result.html.replace(/\[anki:tts\s+([^\]]+)\]([\s\S]*?)\[\/anki:tts\]/g, (_, options: string, text: string) => {
    const language = /\blang=([^\s]+)/.exec(options)?.[1] || 'en_US';
    result.speech.push({ text: plainText(text), lang: language.replaceAll('_','-'), voices: [], rate: 1 }); return '';
  });
  // FrontSide must not replay front audio on the back. Field replacement above preserves its display.
  result.html = result.html.replace(/\[sound:([^\]]+)\]/g, (_, name: string) => { result.sounds.push(name); return ''; });
  result.warnings = [...new Set(result.warnings)];
  return result;
}
