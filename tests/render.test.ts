import { describe, it, expect } from 'vitest';
import { renderCard, clozeText, normalizedAnswer } from '../src/lib/render';
import type { StudyCard } from '../src/lib/types';
import { fixture } from './fixture';
import { initialSchedule } from '../src/lib/import';

function card(): StudyCard {
  const d = fixture();
  return { id: '1', revision: 0, ordinal: 0, note: d.notes[0], noteType: d.noteTypes[0], deck: d.decks[0], schedule: initialSchedule(d.cards[0],d.decks[0]), preview: {} as StudyCard['preview'] };
}
describe('Anki template rendering', () => {
  it('preserves native literal entities in typed answers and speech', () => {
    const c=card();c.note.contentFormat='plain';c.note.fields[1]='&lt; &amp; <literal>\nnext';
    c.noteType.templates[0].front='{{KR}}{{type:KR}}{{tts ko_KR:KR}}';
    const r=renderCard(c,'front');expect(r.html).toContain('&amp;lt; &amp;amp; &lt;literal&gt;<br>next');
    expect(r.typedAnswer?.expected).toBe(c.note.fields[1]);expect(r.speech[0].text).toBe(c.note.fields[1]);
  });
  it('supports the actual deck structure: Korean typed answer and back-only TTS', () => {
    const c = card(); const front = renderCard(c,'front'); const back = renderCard(c,'back',front.html);
    expect(front.html).toContain('こんにちは'); expect(front.html).not.toContain('안녕하세요'); expect(front.speech).toEqual([]);
    expect(front.typedAnswer?.expected).toBe('안녕하세요'); expect(back.html).toContain('안녕하세요');
    expect(back.speech).toEqual([{ text: '안녕하세요', lang: 'ko-KR', voices: ['AwesomeTTS'], rate: 1 }]);
  });
  it('uses independent cloze ordinals with hints and nested deletion', () => {
    const text = 'A {{c1::서울::都市}} and {{c2::부산}}';
    expect(clozeText(text,0,'front')).not.toContain('서울'); expect(clozeText(text,0,'front')).toContain('[都市]');
    expect(clozeText(text,1,'front')).not.toContain('부산'); expect(clozeText(text,1,'front')).toContain('서울');
    expect(clozeText('{{c1::a {{c2::b}} c}}',0,'front')).toContain('[…]');
    expect(clozeText('{{c1::a {{c2::b}} c}}',0,'back')).toContain('a b c');
  });
  it('resolves nested conditional fields without altering note contents', () => {
    const c = card(); c.noteType.templates[0].front = '{{#KR}}x{{#JP}}{{JP}}{{/JP}}{{/KR}}{{^Missing}}y{{/Missing}}';
    expect(renderCard(c,'front').html).toBe('xこんにちはy');
  });
  it('typed cloze compares with the hidden answer and does not reveal it on the question', () => {
    const c = card(); c.note.fields[0] = '{{c1::서울}}에 가요';
    c.noteType.templates[0].front = '{{cloze:JP}} {{type:cloze:JP}}';
    c.noteType.templates[0].back = '{{cloze:JP}} {{type:cloze:JP}}';
    const front = renderCard(c,'front');
    expect(front.html).not.toContain('서울'); expect(front.typedAnswer?.expected).toBe('서울');
    expect(renderCard(c,'back').html).toContain('서울');
  });
  it('does not replay FrontSide audio and normalizes Hangul keyboard composition', () => {
    const c = card(); c.noteType.templates[0].front = '[sound:test.mp3]{{JP}}'; c.noteType.templates[0].back = '{{FrontSide}}{{KR}}';
    const front = renderCard(c,'front'); expect(front.sounds).toEqual(['test.mp3']);
    expect(renderCard(c,'back',front.html).sounds).toEqual([]);
    expect(normalizedAnswer(' 안녕하세요 '.normalize('NFD'))).toBe('안녕하세요');
  });
});
