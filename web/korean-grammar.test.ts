import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NoteTypeInput } from '../src/lib/manage-types';
import type { StudyCard } from '../src/lib/types';
import { renderCard } from '../src/lib/render';
import { importStatements } from '../src/lib/import';
import { app } from '../src/server/index';
import { fixture } from '../tests/fixture';
import { TestDb } from '../tests/test-db';
import { applyKoreanGrammarLabels, grammarLabelCss, conjugationExamplesCss, referencesField } from './korean-grammar';

const korean = (): NoteTypeInput => ({
  name: '韓国語',
  fieldDefinitions: [{ id: 'jp', name: '日本語', required: true }, { id: 'kr', name: '韓国語', required: true }],
  templates: [
    { id: 'jp-kr', name: '日本語→韓国語', front: '{{日本語}}{{type:韓国語}}', back: '{{FrontSide}}<hr>{{type:韓国語}}{{tts ko_KR:韓国語}}' },
    { id: 'kr-jp', name: '韓国語→日本語', front: '{{韓国語}}', back: '{{FrontSide}}<hr>{{日本語}}' },
  ],
  css: '.card { font-size: 28px; text-align: left; }',
});
let n = 0;
const ids = () => `new-${++n}`;
beforeEach(() => { n = 0; });
const applied = (input: NoteTypeInput, saved?: NoteTypeInput) => { const r = applyKoreanGrammarLabels(input, ids, saved); if (!r.ok) throw new Error(r.error); return r; };
const card = (input: NoteTypeInput, values: Record<string,string>, ordinal = 0) => ({
  id: 'c', ordinal, note: { id: 'n', guid: 'g', noteTypeId: 't', fields: input.fieldDefinitions.map(f => values[f.name] ?? ''), tags: [], contentFormat: 'plain' },
  noteType: { id: 't', name: input.name, kind: 'normal', fields: input.fieldDefinitions.map(f => f.name), templates: input.templates, css: input.css },
  deck: { id: 'd', name: 'deck', configId: '', config: {} },
}) as unknown as StudyCard;
const both = (c: StudyCard) => { const front = renderCard(c, 'front'); return { front, back: renderCard(c, 'back', front.html) }; };

describe('Korean grammar labels draft action', () => {
  it('adds three optional fields, back-only labels per template and CSS once, keeping existing identities', () => {
    const draft = korean(); const before = structuredClone(draft);
    const { input, changed } = applied(draft);
    expect(changed).toBe(true);
    expect(draft).toEqual(before);
    expect(input.fieldDefinitions).toEqual([...before.fieldDefinitions, { id: 'new-1', name: '品詞', required: false }, { id: 'new-2', name: '変格活用', required: false }, { id: 'new-3', name: '活用例', required: false }]);
    expect(input.templates.map(t => [t.id, t.name, t.front])).toEqual(before.templates.map(t => [t.id, t.name, t.front]));
    input.templates.forEach((t, i) => { expect(t.back.startsWith(before.templates[i].back)).toBe(true); expect(t.back.match(/class="dpk-grammar"/g)).toHaveLength(1); });
    expect(input.css.startsWith(before.css)).toBe(true);
    expect(input.css).toContain(grammarLabelCss);
    expect(input.css.endsWith(conjugationExamplesCss)).toBe(true);
    expect(input.name).toBe(before.name);
  });

  it('is idempotent when applied again', () => {
    const once = applied(korean()).input;
    const twice = applyKoreanGrammarLabels(once, ids);
    expect(twice).toEqual({ ok: true, input: once, changed: false });
  });

  it('keeps a custom single-field reference and adds only the missing label', () => {
    const draft = korean();
    draft.fieldDefinitions.push({ id: 'pos', name: '品詞', required: true });
    draft.templates[0].back += '{{#品詞}}<em class="mine">{{text:品詞}}</em>{{/品詞}}';
    const { input } = applied(draft);
    expect(input.fieldDefinitions.filter(f => f.name === '品詞')).toEqual([{ id: 'pos', name: '品詞', required: true }]);
    expect(input.fieldDefinitions.slice(-2)).toEqual([{ id: 'new-1', name: '変格活用', required: false }, { id: 'new-2', name: '活用例', required: false }]);
    expect(input.templates[0].back.startsWith(`${draft.templates[0].back}<div class="dpk-grammar">{{#変格活用}}<span class="dpk-grammar-chip dpk-grammar-conjugation"><span class="dpk-grammar-key">活用</span><span class="dpk-grammar-value">{{変格活用}}</span></span>{{/変格活用}}</div>`)).toBe(true);
    expect(input.templates[1].back.match(/dpk-grammar-chip/g)).toHaveLength(2);
    expect(referencesField('{{ #品詞 }}', '品詞')).toBe(true);
    expect(referencesField('{{品詞の例}}', '品詞')).toBe(false);
  });

  it('migrates a pending rename only in unchanged backs it rewrites, keeping edited bodies and fronts verbatim', () => {
    const saved = korean(); const draft = structuredClone(saved);
    draft.fieldDefinitions[1].name = '韓国語回答';
    draft.templates[1].back = '{{FrontSide}}<hr><b>{{韓国語回答}}</b>{{#日本語}}{{/日本語}}';
    const { input } = applied(draft, saved);
    expect(input.templates[0].back.startsWith('{{FrontSide}}<hr>{{type:韓国語回答}}{{tts ko_KR:韓国語回答}}<div class="dpk-grammar">')).toBe(true);
    expect(input.templates[1].back.startsWith(`${draft.templates[1].back}<div class="dpk-grammar">`)).toBe(true);
    expect(input.templates.map(t => t.front)).toEqual(saved.templates.map(t => t.front));
    expect(applyKoreanGrammarLabels(input, ids, saved)).toMatchObject({ ok: true, changed: false });
  });

  it('adds no CSS when every back already shows all three fields', () => {
    const draft = korean(); draft.fieldDefinitions.push({ id: 'a', name: '品詞', required: false }, { id: 'b', name: '変格活用', required: false }, { id: 'c', name: '活用例', required: false });
    draft.templates.forEach(t => { t.back += '{{品詞}}{{変格活用}}{{活用例}}'; });
    expect(applyKoreanGrammarLabels(draft, ids)).toEqual({ ok: true, input: draft, changed: false });
  });

  it('upgrades old labelled types without replacing CSS, and preserves custom example references', () => {
    const legacy = applied(korean()).input;
    legacy.fieldDefinitions.pop();
    legacy.templates.forEach(t => { t.back = t.back.replace(/{{#活用例}}[\s\S]*?{{\/活用例}}/, ''); });
    legacy.css = legacy.css.slice(0, legacy.css.indexOf('/* dopanki:korean-conjugation-examples */')).trimEnd();
    const upgraded = applied(legacy).input;
    expect(upgraded.fieldDefinitions.slice(0, -1)).toEqual(legacy.fieldDefinitions);
    expect(upgraded.css.startsWith(legacy.css)).toBe(true);
    expect(upgraded.css).toContain(conjugationExamplesCss);
    upgraded.templates.forEach((t, i) => {
      expect(t.back.startsWith(legacy.templates[i].back)).toBe(true);
      expect(t.back.match(/class="dpk-conjugation-examples"/g)).toHaveLength(1);
    });
    expect(applied(upgraded).changed).toBe(false);
    const custom = korean();
    custom.fieldDefinitions.push({ id: 'example', name: '活用例', required: false });
    custom.templates[0].back += '{{#活用例}}<aside>{{text:活用例}}</aside>{{/活用例}}';
    const result = applied(custom).input;
    expect(result.fieldDefinitions.find(f => f.name === '活用例')?.id).toBe('example');
    expect(result.templates[0].back).not.toContain('dpk-conjugation-examples');
    const shown = both(card(result, { 日本語: '聞く', 韓国語: '듣다', 活用例: '듣다 + -어요 → 들어요\n듣고 <そのまま>' }, 1));
    expect(shown.front.html).not.toContain('들어요');
    expect(shown.back.html).toContain('듣다 + -어요 → 들어요<br>듣고 &lt;そのまま&gt;');
    expect(shown.back.html).toContain('dpk-conjugation-examples-heading">活用例');
  });

  it('refuses field, back and CSS limit violations without changing the draft', () => {
    const many = korean(); for (let i = 0; i < 29; i++) many.fieldDefinitions.push({ id: `f${i}`, name: `f${i}`, required: false });
    const snapshot = structuredClone(many);
    const error = applyKoreanGrammarLabels(many, ids);
    expect(error.ok).toBe(false); expect(error.ok ? '' : error.error).toContain('32');
    expect(many).toEqual(snapshot);
    many.fieldDefinitions.splice(-2);
    expect(applied(many).input.fieldDefinitions).toHaveLength(32);

    const longBack = korean(); longBack.templates[1].back += 'x'.repeat(29800);
    const backSnapshot = structuredClone(longBack);
    const backError = applyKoreanGrammarLabels(longBack, ids);
    expect(backError.ok ? '' : backError.error).toContain('カード 2 の裏面');
    expect(longBack).toEqual(backSnapshot);

    const longCss = korean(); longCss.css += 'x'.repeat(39500);
    const cssSnapshot = structuredClone(longCss);
    const cssError = applyKoreanGrammarLabels(longCss, ids);
    expect(cssError.ok ? '' : cssError.error).toContain('共通CSS');
    expect(longCss).toEqual(cssSnapshot);
  });

  it('renders compact labels on the back only, with an empty wrapper and unchanged typed answer and TTS when blank', () => {
    const draft = korean(); const { input } = applied(draft);
    const values = { 日本語: '寒い', 韓国語: '춥다' };
    const original = both(card(draft, values)); const blank = both(card(input, values)); const spaces = both(card(input, { ...values, 品詞: '  ', 変格活用: '\n', 活用例: ' \n ' }));
    expect(blank.front).toEqual({ ...original.front, css: input.css });
    expect(blank.back.html).toBe(`${original.back.html}<div class="dpk-grammar"></div>`);
    expect(spaces.back.html).toBe(blank.back.html);
    expect(blank.back.typedAnswer).toEqual(original.back.typedAnswer);
    expect(blank.back.speech).toEqual(original.back.speech);
    expect(grammarLabelCss).toContain('.dpk-grammar:empty{display:none}');

    const filled = both(card(input, { ...values, 品詞: '形容詞', 変格活用: 'ㅂ<変格>' }));
    expect(filled.front.html).toBe(original.front.html);
    expect(filled.back.html).toContain('<span class="dpk-grammar-key">品詞</span><span class="dpk-grammar-value">形容詞</span>');
    expect(filled.back.html).toContain('<span class="dpk-grammar-key">活用</span><span class="dpk-grammar-value">ㅂ&lt;変格&gt;</span>');
    expect(filled.back.warnings).toEqual([]);
    const onlyConjugation = both(card(input, { ...values, 変格活用: 'ㅂ変格' }));
    expect(onlyConjugation.back.html).not.toContain('dpk-grammar-pos');
    expect(onlyConjugation.back.html).toContain('dpk-grammar-conjugation');
  });
});

describe('saving the draft through the management API', () => {
  let db: TestDb;
  beforeEach(() => {
    db = new TestDb();
    for (const f of ['0001_initial.sql','0002_history_time.sql','0003_authoring.sql','0004_custom_practice.sql','0005_practice_deletion.sql','0006_study_options.sql','0007_restart_new_limit.sql']) db.sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    db.sqlite.exec(importStatements(fixture()).join(';') + ';');
  });
  afterEach(() => db.sqlite.close());
  const request = (path: string, body?: Record<string,unknown>, method = 'GET') => app.request(`http://localhost/api/manage${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }, { DB: db as unknown as D1Database, MEDIA: {} as R2Bucket, ASSETS: {} as Fetcher });
  const rows = (table: string) => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();

  it.each(['韓国語', ' 韓国語 '])('accepts a pending field rename %j with labels, keeping cards, schedules, review history, typed answer and TTS', async pending => {
    const { noteType } = await (await request('/note-types/1')).json() as any;
    const before = { cards: rows('cards'), imported: rows('imported_reviews'), events: rows('review_events') };
    const draft = structuredClone(noteType); draft.fieldDefinitions[1].name = pending;
    const { input } = applied(draft, noteType);
    // The draft keeps the typed name; only generated references use the server's trimmed name.
    expect(input.fieldDefinitions[1].name).toBe(pending);
    const response = await request('/note-types/1', { ...input, version: noteType.version, requestId: 'korean-grammar-labels-test-1' }, 'PATCH');
    expect(response.status).toBe(200);
    const { noteType: saved } = await response.json() as any;
    expect(saved.fieldDefinitions.map((f: any) => [f.id, f.name])).toEqual([...noteType.fieldDefinitions.map((f: any, i: number) => [f.id, i === 1 ? '韓国語' : f.name]), ['new-1', '品詞'], ['new-2', '変格活用'], ['new-3', '活用例']]);
    expect(saved.templates.map((t: any) => [t.id, t.front])).toEqual(noteType.templates.map((t: any) => [t.id, t.front.replace('{{type:KR}}', '{{type:韓国語}}')]));
    expect(saved.templates[0].back.startsWith('{{JP}}<hr>{{tts ko_KR voices=AwesomeTTS:韓国語}}{{type:韓国語}}<div class="dpk-grammar">')).toBe(true);
    expect({ cards: rows('cards'), imported: rows('imported_reviews'), events: rows('review_events') }).toEqual(before);
    const { note } = await (await request('/notes/1')).json() as any;
    expect(note.fields).toEqual({ JP: 'こんにちは', 韓国語: '안녕하세요', 品詞: '', 変格活用: '', 活用例: '' });
    const { back } = both(card(saved, note.fields));
    expect(back.typedAnswer).toEqual({ expected: '안녕하세요', ignoreAccents: false });
    expect(back.speech.map(s => [s.text, s.lang])).toEqual([['안녕하세요', 'ko-KR']]);
    expect(back.warnings).toEqual([]);
    const examples = '듣다 + -어요 → 들어요\n듣고 はそのまま。';
    const updated = await request('/notes/1', { version: note.version, requestId: 'korean-example-note-edit', fields: { 活用例: examples } }, 'PATCH');
    expect(updated.status).toBe(200);
    const { note: edited } = await (await request('/notes/1')).json() as any;
    expect(edited.fields).toEqual({ ...note.fields, 活用例: examples });
    expect({ cards: rows('cards'), imported: rows('imported_reviews'), events: rows('review_events') }).toEqual(before);
    expect(applyKoreanGrammarLabels(saved, ids, saved)).toMatchObject({ ok: true, changed: false });
  });
});
