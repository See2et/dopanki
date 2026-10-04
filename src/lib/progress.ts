import { nextStudyDayBoundary, studyDayBoundary } from './scheduler';
import type { ImportDocument, ProgressResponse } from './types';

const DAY = 86_400_000;
const ratedImport = "json_extract(data,'$.rating') IN (1,2,3,4) AND json_extract(data,'$.type') IN (0,1,2,3)";
type DayBucket = { earliest: number; latest: number; answers: number };
type DayRange = { date: string; start: number; end: number };

/** The calendar label follows the scheduler's local wall-clock rollover. */
function studyDate(timestamp: number, format: Intl.DateTimeFormat, dayStart: number): string {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour - dayStart)).toISOString().slice(0,10);
}

/** Read-only projection: imported rated answers and non-undone Dopanki events. */
export async function progress(db: D1Database, collection: ImportDocument['collection'], now: number): Promise<ProgressResponse> {
  const { timeZone, dayStart } = collection;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const today = studyDate(now,format,dayStart);
  const boundary = studyDayBoundary(now,timeZone,dayStart);
  const tomorrowEnd = nextStudyDayBoundary(nextStudyDayBoundary(now,timeZone,dayStart),timeZone,dayStart);
  const [buckets, tomorrowResult] = await Promise.all([
    // SQLite has no IANA timezone support. Aggregate by UTC day first, then split only
    // buckets that cross a local rollover; historical review rows never leave the DB.
    db.prepare(`SELECT MIN(earliest) AS earliest,MAX(latest) AS latest,SUM(answers) AS answers FROM (
      SELECT date(json_extract(data,'$.reviewedAt')/1000.0,'unixepoch') AS utc_day,
        MIN(json_extract(data,'$.reviewedAt')) AS earliest,MAX(json_extract(data,'$.reviewedAt')) AS latest,COUNT(*) AS answers
      FROM imported_reviews WHERE ${ratedImport} AND json_extract(data,'$.reviewedAt')<=?
        AND date(json_extract(data,'$.reviewedAt')/1000.0,'unixepoch') IS NOT NULL GROUP BY utc_day
      UNION ALL
      SELECT date(reviewed_at/1000.0,'unixepoch') AS utc_day,MIN(reviewed_at),MAX(reviewed_at),COUNT(*)
      FROM review_events WHERE undone=0 AND reviewed_at<=? GROUP BY utc_day
    ) GROUP BY utc_day`).bind(now,now).all<DayBucket>(),
    db.prepare(`WITH ranked AS (
      SELECT e.before_state,
        FIRST_VALUE(e.after_state) OVER(PARTITION BY e.card_id ORDER BY e.after_revision DESC) AS after_state,
        ROW_NUMBER() OVER(PARTITION BY e.card_id ORDER BY e.after_revision) AS first_review
      FROM review_events e JOIN cards c ON c.id=e.card_id
      WHERE e.undone=0 AND e.reviewed_at>=? AND e.reviewed_at<=? AND c.queue>=0
    ), changes AS (
      SELECT json_extract(before_state,'$.state') AS before_state,json_extract(before_state,'$.due') AS before_due,
        json_extract(after_state,'$.state') AS after_state,json_extract(after_state,'$.due') AS after_due
      FROM ranked WHERE first_review=1
    ) SELECT COUNT(*) AS reviewedCards,
      COALESCE(SUM(before_state<>0 AND before_due<? AND after_state<>0 AND after_due>=?),0) AS movedBeyondTomorrow,
      COALESCE(SUM(before_state=0 AND after_state<>0 AND after_due<?),0) AS addedForTomorrow,
      COALESCE(SUM((before_state<>0 AND before_due<?)-(after_state<>0 AND after_due<?)),0) AS netReduction,
      (SELECT COUNT(*) FROM cards WHERE queue>=0 AND state<>0 AND due<?) AS dueCards FROM changes`)
      .bind(boundary,now,tomorrowEnd,tomorrowEnd,tomorrowEnd,tomorrowEnd,tomorrowEnd,tomorrowEnd)
      .first<ProgressResponse['tomorrow']>(),
  ]);
  const answers = new Map<string,number>();
  const add = (date: string, count: number) => answers.set(date,(answers.get(date) ?? 0)+count);
  const split: DayRange[] = [];
  for (const bucket of buckets.results) {
    const firstDate = studyDate(bucket.earliest,format,dayStart);
    if (firstDate === studyDate(bucket.latest,format,dayStart)) {
      add(firstDate,bucket.answers);
      continue;
    }
    let start = bucket.earliest;
    while (start <= bucket.latest) {
      const end = Math.min(nextStudyDayBoundary(start,timeZone,dayStart),bucket.latest+1);
      split.push({ date: studyDate(start,format,dayStart), start, end });
      start = end;
    }
  }
  if (split.length) {
    const counts = await db.prepare(`WITH event_decks AS (SELECT DISTINCT deck_id FROM review_events),
      ranges AS (SELECT json_extract(value,'$.date') AS date,json_extract(value,'$.start') AS start,
        json_extract(value,'$.end') AS end FROM json_each(?))
      SELECT date,SUM(
        (SELECT COUNT(*) FROM imported_reviews WHERE ${ratedImport}
          AND json_extract(data,'$.reviewedAt')>=ranges.start AND json_extract(data,'$.reviewedAt')<ranges.end
          AND json_extract(data,'$.reviewedAt')<=?)
        + (SELECT COUNT(*) FROM review_events WHERE deck_id IN (SELECT deck_id FROM event_decks)
          AND undone=0 AND reviewed_at>=ranges.start AND reviewed_at<ranges.end AND reviewed_at<=?)
      ) AS answers FROM ranges GROUP BY date`).bind(JSON.stringify(split),now,now).all<{ date: string; answers: number }>();
    for (const row of counts.results) if (row.answers) add(row.date,row.answers);
  }
  const todayDate = Date.parse(`${today}T00:00:00Z`);
  const weekStart = new Date(todayDate-((new Date(todayDate).getUTCDay()+6)%7)*DAY).toISOString().slice(0,10);
  return {
    today,
    days: Array.from({ length: 182 },(_,index) => {
      const date = new Date(todayDate-(181-index)*DAY).toISOString().slice(0,10);
      return { date, answers: answers.get(date) ?? 0 };
    }),
    totalStudyDays: answers.size,
    weekStudyDays: [...answers.keys()].filter(date => date>=weekStart && date<=today).length,
    todayAnswers: answers.get(today) ?? 0,
    tomorrow: tomorrowResult!,
  };
}
