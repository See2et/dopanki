import { describe, expect, it } from 'vitest';
import { answerFocus, beginFocus, focusStats, readFocus, reconcileFocus, undoFocus } from './focus';

describe('ten distinct cards per focus result', () => {
  it('keeps failures in the same batch and counts successful retries separately from first recall', () => {
    let s = beginFocus('1',123,[...Array(12)].map((_,i)=>String(i+1)));
    const fail = { eventId:'fail',cardId:'1',rating:1,resolved:false };
    s = answerFocus(s,fail); s = answerFocus(s,fail);
    expect(s.batch.pending).toHaveLength(10);
    s = answerFocus(s,{eventId:'retry',cardId:'1',rating:3,resolved:true});
    for (const cardId of s.batch.ids.slice(1)) s = answerFocus(s,{eventId:cardId,cardId,rating:3,resolved:true});
    expect(s.batch.pending).toEqual([]);
    expect(focusStats(s.batch)).toEqual({finished:10,recalledFirst:9,relearned:1,answers:11});
    expect(readFocus(JSON.stringify(s))).toEqual(s);
  });
  it('restores a completed batch on undo, even after starting the next batch', () => {
    let s = beginFocus('1',123,['1','2']);
    s = answerFocus(s,{eventId:'a',cardId:'1',rating:3,resolved:true});
    s = answerFocus(s,{eventId:'b',cardId:'2',rating:4,resolved:true});
    s = beginFocus('1',123,['3'],s.batch);
    s = undoFocus(s,'b');
    expect(s.batch.number).toBe(1);
    expect(s.batch.pending).toEqual(['2']);
    expect(focusStats(s.batch).finished).toBe(1);
  });
  it('finishes today after a failed answer crossing rollover without claiming successful relearning', () => {
    let s = beginFocus('1',123,['1']);
    s = answerFocus(s,{eventId:'cross-rollover',cardId:'1',rating:1,resolved:true});
    expect(s.batch.pending).toEqual([]);
    expect(focusStats(s.batch)).toEqual({finished:1,recalledFirst:0,relearned:0,answers:1});
  });
  it('does not count suspended or externally finished cards as remembered', () => {
    let s = beginFocus('1',123,['1','2']);
    s = reconcileFocus(s,['2']);
    expect(focusStats(s.batch).finished).toBe(0);
    expect(s.batch.excluded).toEqual(['1']);
    expect(readFocus('{"batch":{}}')).toBeNull();
  });
});
