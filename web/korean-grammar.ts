import type { NoteTypeInput } from '../src/lib/manage-types';

/** Optional grammar metadata for Korean vocabulary. Values are entered per note; nothing is populated in bulk. */
export const grammarFields = [
  { name: '品詞', key: '品詞', variant: 'pos' },
  { name: '変格活用', key: '活用', variant: 'conjugation' },
] as const;
// Mirrors the management API limits, so the editor can refuse before touching the draft.
export const grammarLimits = { fields: 32, back: 30000, css: 40000 };
const exampleField = '活用例';
const cssMarker = '/* dopanki:korean-grammar-labels */';
const examplesCssMarker = '/* dopanki:korean-conjugation-examples */';
export const conjugationExamplesCss = `${examplesCssMarker}
.dpk-conjugation-examples{box-sizing:border-box;max-width:100%;margin:1rem 0 0;padding:.75rem 1rem;border-left:3px solid #e6cf9d;border-radius:.25rem;background:#fdfaf3;color:#443b2c;font-size:1rem;line-height:1.7;text-align:start;overflow-wrap:anywhere}
.dpk-conjugation-examples-heading{margin:0 0 .35rem;color:#85581a;font-size:.75rem;font-weight:700}
.dpk-conjugation-examples-value{min-width:0}`;
const examplesBlock = `{{#活用例}}<div class="dpk-conjugation-examples"><div class="dpk-conjugation-examples-heading">活用例</div><div class="dpk-conjugation-examples-value">{{活用例}}</div></div>{{/活用例}}`;

/**
 * Back-only labels. Values use rem so they stay small regardless of the card's own font size,
 * and chips sit inline so they follow the card's text alignment. The wrapper has no whitespace,
 * so with both fields blank it is `:empty` and takes no space.
 */
export const grammarLabelCss = `${cssMarker}
.dpk-grammar{margin:1rem 0 0;line-height:1.5}
.dpk-grammar:empty{display:none}
.dpk-grammar-chip{display:inline-flex;align-items:baseline;gap:.45rem;max-width:100%;box-sizing:border-box;margin:.2rem .2rem 0;padding:.22rem .6rem .24rem;border:1px solid #cfe3d5;border-radius:.55rem;background:#f1f8f3;color:#2c6646;font-size:.8125rem;font-weight:500;text-align:start;vertical-align:top}
.dpk-grammar-key{flex:none;padding-right:.45rem;border-right:1px solid #bcd9c6;font-size:.6875rem;font-weight:700;letter-spacing:.06em;opacity:.85}
.dpk-grammar-value{min-width:0;overflow-wrap:anywhere}
.dpk-grammar-conjugation{border-color:#efdcb2;background:#fdf6e6;color:#85581a}
.dpk-grammar-conjugation .dpk-grammar-key{border-right-color:#e6cf9d}`;

const chip = (field: (typeof grammarFields)[number]) =>
  `{{#${field.name}}}<span class="dpk-grammar-chip dpk-grammar-${field.variant}"><span class="dpk-grammar-key">${field.key}</span><span class="dpk-grammar-value">{{${field.name}}}</span></span>{{/${field.name}}}`;

/** True when the template already uses the field in any form, e.g. `{{品詞}}`, `{{#品詞}}` or `{{text:品詞}}`. */
export function referencesField(template: string, name: string): boolean {
  for (const m of template.matchAll(/{{([^{}]+)}}/g)) if (m[1].trim().replace(/^[#^/]/,'').split(':').at(-1)!.trim() === name) return true;
  return false;
}

/** The reference rewrite the server applies to unchanged template sides when fields are renamed. */
function renameRefs(template: string, renames: Map<string,string>): string {
  return template.replace(/{{([^{}]+)}}/g, (match, token: string) => {
    const trimmed = token.trim(); const prefix = /^[#^/]/.test(trimmed) ? trimmed[0] : ''; const rest = prefix ? trimmed.slice(1) : trimmed;
    const split = rest.lastIndexOf(':'); const ref = rest.slice(split + 1);
    return renames.has(ref) ? `{{${prefix}${rest.slice(0, split + 1)}${renames.get(ref)}}}` : match;
  });
}

export type GrammarApplyResult =
  | { ok: true; input: NoteTypeInput; changed: boolean }
  | { ok: false; error: string };

/**
 * Returns a new draft with optional grammar fields, back labels, examples and CSS added once.
 * Existing fields, templates, IDs and custom references are kept; only what is missing is added.
 * On a validation error the given draft is returned untouched via `ok:false`.
 * `saved` is the stored type: the server migrates renamed references only in unchanged sides,
 * so a back still equal to its saved body gets pending renames applied here before labels are appended.
 */
export function applyKoreanGrammarLabels(draft: NoteTypeInput, newId: () => string, saved?: NoteTypeInput): GrammarApplyResult {
  const input = structuredClone(draft);
  // Destination names use the server's trimmed form; the draft's own field names stay as typed.
  const renames = new Map(saved?.fieldDefinitions.flatMap(f => { const name = input.fieldDefinitions.find(n => n.id === f.id)?.name.trim(); return name !== undefined && name !== f.name ? [[f.name, name] as const] : []; }));
  for (const name of [...grammarFields.map(f => f.name), exampleField]) if (!input.fieldDefinitions.some(f => f.name.trim() === name)) input.fieldDefinitions.push({ id: newId(), name, required: false });
  if (input.fieldDefinitions.length > grammarLimits.fields) return { ok: false, error: `フィールドは${grammarLimits.fields}個までです。品詞・変格活用・活用例を追加するには、${input.fieldDefinitions.length - grammarLimits.fields}個減らしてください。` };
  for (const [i, template] of input.templates.entries()) {
    const back = saved?.templates.find(t => t.id === template.id)?.back === template.back ? renameRefs(template.back, renames) : template.back;
    const missing = grammarFields.filter(field => !referencesField(back, field.name));
    const missingExamples = !referencesField(back, exampleField);
    if (!missing.length && !missingExamples) continue;
    template.back = `${back}${missing.length ? `<div class="dpk-grammar">${missing.map(chip).join('')}</div>` : ''}${missingExamples ? examplesBlock : ''}`;
    if (template.back.length > grammarLimits.back) return { ok: false, error: `カード ${i + 1} の裏面が${grammarLimits.back.toLocaleString('ja-JP')}文字を超えるため、活用欄を追加できません。` };
  }
  if (input.templates.some(t => t.back.includes('dpk-grammar-chip')) && !input.css.includes(cssMarker)) {
    input.css = input.css.trimEnd() ? `${input.css.trimEnd()}\n\n${grammarLabelCss}` : grammarLabelCss;
  }
  if (input.templates.some(t => t.back.includes('dpk-conjugation-examples')) && !input.css.includes(examplesCssMarker)) {
    input.css = input.css.trimEnd() ? `${input.css.trimEnd()}\n\n${conjugationExamplesCss}` : conjugationExamplesCss;
  }
  if (input.css.length > grammarLimits.css) return { ok: false, error: `共通CSSが${grammarLimits.css.toLocaleString('ja-JP')}文字を超えるため、活用欄を追加できません。` };
  return { ok: true, input, changed: JSON.stringify(input) !== JSON.stringify(draft) };
}
