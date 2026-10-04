/**
 * Presentation for the session medals: names, Japanese condition text and medal artwork.
 * The rules themselves live in medals.ts (MEDAL_RULES); nothing here decides who earns what.
 */
import { MEDAL_RULES, type MedalId } from './medals';
import { escapeHtml } from '../src/lib/render';

type Metal = 'bronze' | 'silver' | 'gold';
interface MedalLook { name: string; condition: string; glyph: string; metal: Metal; ribbon: [string, string] }

const looks: Record<MedalId, MedalLook> = {
  'first-review': { name: '開幕の一枚', condition: 'このセッションで最初の回答を記録する', glyph: '開', metal: 'bronze', ribbon: ['#ff8a3d', '#ffd23a'] },
  'first-again': { name: '正直者', condition: '「もう一度」を正直に1回選ぶ', glyph: '正', metal: 'bronze', ribbon: ['#3d6bff', '#7fc8ff'] },
  'honest-3': { name: '正直名人', condition: '「もう一度」を正直に3回選ぶ', glyph: '誠', metal: 'silver', ribbon: ['#3d6bff', '#9b7bff'] },
  'remembered-3': { name: '三連想起', condition: '3回続けて「思い出せた」（難しい・普通・簡単）', glyph: '3連', metal: 'bronze', ribbon: ['#ff5f9e', '#ffd23a'] },
  'remembered-5': { name: '五連想起', condition: '5回続けて「思い出せた」', glyph: '5連', metal: 'silver', ribbon: ['#ff5f9e', '#ff8a3d'] },
  'remembered-10': { name: '十連想起', condition: '10回続けて「思い出せた」', glyph: '10連', metal: 'gold', ribbon: ['#ff5f9e', '#9b7bff'] },
  comeback: { name: 'リベンジ', condition: '「もう一度」の直後の回答で「思い出せた」', glyph: '返', metal: 'silver', ribbon: ['#33c3a0', '#3d6bff'] },
  balanced: { name: '学びの天秤', condition: '「もう一度」1回以上と「思い出せた」3回以上', glyph: '均', metal: 'silver', ribbon: ['#33c3a0', '#ffd23a'] },
  'reviews-10': { name: '十枚突破', condition: 'このセッションで10枚に回答する', glyph: '10', metal: 'silver', ribbon: ['#9b7bff', '#5fd6ff'] },
  'reviews-20': { name: '二十枚突破', condition: 'このセッションで20枚に回答する', glyph: '20', metal: 'gold', ribbon: ['#ff8a3d', '#ff5f9e'] },
};
const metals: Record<Metal, { rim: string; face: string; label: string }> = {
  bronze: { rim: '#e39a5f', face: '#f7cfa4', label: '銅' },
  silver: { rim: '#b8c3d8', face: '#eef2fa', label: '銀' },
  gold: { rim: '#ffc21a', face: '#fff0a6', label: '金' },
};
const ink = '#27213a';

/** Medals in canonical rule order. */
export const MEDALS = MEDAL_RULES.map(rule => ({ id: rule.id, ...looks[rule.id] }));
export const medalName = (id: MedalId) => looks[id].name;
export const medalCondition = (id: MedalId) => looks[id].condition;
export const metalLabel = (id: MedalId) => metals[looks[id].metal].label;

/** A ribboned medal sticker. Unearned medals stay readable but drained of colour. */
export function medalArt(id: MedalId, earned = true) {
  const look = looks[id];
  const metal = metals[look.metal];
  const [left, right] = earned ? look.ribbon : ['#d9d3c7', '#e8e3d9'];
  const rim = earned ? metal.rim : '#d9d3c7';
  const face = earned ? metal.face : '#f1ede5';
  const size = look.glyph.length > 2 ? 15 : look.glyph.length > 1 ? 19 : 24;
  return `<svg class="medal-art${earned ? '' : ' is-locked'}" viewBox="0 0 80 100" aria-hidden="true" focusable="false">
    <path d="M22 2h16l8 40H30z" fill="${left}" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M42 2h16L50 42H34z" fill="${right}" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="40" cy="64" r="31" fill="${rim}" stroke="${ink}" stroke-width="3.2"/>
    <circle cx="40" cy="64" r="23" fill="${face}" stroke="${ink}" stroke-width="2"/>
    ${earned ? '<path d="M24 52a20 20 0 0 1 12-9" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" opacity=".85"/>' : ''}
    <text x="40" y="${64 + size * 0.36}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${earned ? ink : '#a39cb2'}" class="medal-glyph">${escapeHtml(look.glyph)}</text>
    ${earned ? `<path d="M64 30l2.2 5 5.4.6-4 3.6 1.1 5.3-4.7-2.7-4.7 2.7 1.1-5.3-4-3.6 5.4-.6z" fill="#fff6a8" stroke="${ink}" stroke-width="1.8" stroke-linejoin="round"/>` : ''}
  </svg>`;
}
