/**
 * ドパハム: Dopanki's hamster. Hamsters stuff their cheeks to keep things for later, the way a
 * review keeps a memory. Drawn as inline SVG stickers so no image assets are needed.
 */
export type Mood = 'calm' | 'happy' | 'cheer' | 'wow' | 'oops';
const ink = '#27213a';
export const hamColors = ['#ffb85c', '#ff9ec4', '#8ec5ff', '#7fdcb8', '#c3a6ff', '#ffe06b', '#ffa98a', '#9be7ff', '#c8ee7a', '#f2a6ff'];

function face(mood: Mood) {
  // "Oops" for an honest Again: a sheepish squint and a sweat drop, never sad or angry.
  if (mood === 'oops') return `<path d="M33 45l9 4.5-9 4.5M67 45l-9 4.5 9 4.5" fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <ellipse cx="50" cy="56" rx="2.8" ry="2.1" fill="${ink}"/><path d="M44 63.5q3-3 6 0t6 0" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M84 30c3 5 5 8 5 11a5 5 0 0 1-10 0c0-3 2-6 5-11z" fill="#7cc8ff" stroke="${ink}" stroke-width="2.2" stroke-linejoin="round"/>`;
  const eyes = mood === 'calm'
    ? `<circle cx="38" cy="49" r="4.6" fill="${ink}"/><circle cx="62" cy="49" r="4.6" fill="${ink}"/><circle cx="39.6" cy="47.4" r="1.6" fill="#fff"/><circle cx="63.6" cy="47.4" r="1.6" fill="#fff"/>`
    : mood === 'wow'
      ? `<path d="M38 42l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7zM62 42l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#ffd23a" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>`
      : `<path d="M32.5 51q5.5-8 11 0M56.5 51q5.5-8 11 0" fill="none" stroke="${ink}" stroke-width="3.6" stroke-linecap="round"/>`;
  const mouth = mood === 'calm'
    ? `<path d="M45 61q2.5 3 5 0q2.5 3 5 0" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`
    : `<path d="M42.5 59.5h15q-1.5 10-7.5 10t-7.5-10z" fill="#e04f72" stroke="${ink}" stroke-width="2.6" stroke-linejoin="round"/><path d="M46 66q4-3 8 0" fill="#ff9db4"/>`;
  return `${eyes}<ellipse cx="50" cy="56" rx="2.8" ry="2.1" fill="${ink}"/>${mouth}`;
}
function arms(mood: Mood, color: string) {
  const s = `fill="${color}" stroke="${ink}" stroke-width="3.2"`;
  return mood === 'cheer' || mood === 'wow'
    ? `<ellipse cx="12" cy="40" rx="7" ry="11.5" transform="rotate(-28 12 40)" ${s}/><ellipse cx="88" cy="40" rx="7" ry="11.5" transform="rotate(28 88 40)" ${s}/>`
    : `<ellipse cx="35" cy="76" rx="7.5" ry="5.6" ${s}/><ellipse cx="65" cy="76" rx="7.5" ry="5.6" ${s}/>`;
}

/** One hamster sticker. `color` picks the body colour; the first colour is ドパハム itself. */
export function hamster(mood: Mood = 'calm', color = hamColors[0], extra = '') {
  return `<svg class="ham ham-${mood}${extra ? ` ${extra}` : ''}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <g stroke="${ink}" stroke-width="3.6" stroke-linejoin="round">
      <circle cx="24" cy="24" r="11.5" fill="${color}"/><circle cx="76" cy="24" r="11.5" fill="${color}"/>
      <ellipse cx="34" cy="94" rx="10" ry="5.5" fill="${color}"/><ellipse cx="66" cy="94" rx="10" ry="5.5" fill="${color}"/>
      <path d="M50 14C80 14 93 36 93 60S74 95 50 95 7 84 7 60 20 14 50 14z" fill="${color}"/>
    </g>
    <circle cx="24" cy="24" r="5.2" fill="#ffc2d1"/><circle cx="76" cy="24" r="5.2" fill="#ffc2d1"/>
    <path d="M50 52c17 0 26 11 26 24s-11 16-26 16-26-3-26-16 9-24 26-24z" fill="#fff6e4"/>
    <ellipse cx="24" cy="61" rx="7.5" ry="5" fill="#ff8fab" opacity=".8"/><ellipse cx="76" cy="61" rx="7.5" ry="5" fill="#ff8fab" opacity=".8"/>
    ${face(mood)}${arms(mood, color)}
  </svg>`;
}

/** How many friends have joined ドパハム after `count` recorded reviews (never depends on ratings). */
export function friendsFor(count: number) {
  return [3, 6, 10, 15, 21, 30, 40, 55, 75].filter(threshold => count >= threshold).length;
}
