import { nextStudyDayBoundary, studyDayBoundary } from './scheduler';
import type { ImportDocument, ProgressResponse } from './types';

const DAY = 86_400_000;
const ratedImport = "json_extract(data,'$.rating') IN (1,2,3,4) AND json_extract(data,'$.type') IN (0,1,2,3)";
type DirtyDay = { utc_day:string; revision:number };
// UTC date, local calendar label, inclusive start, exclusive end.
type DayRange = [string,string,number,number,number?];
const rangesSql=`SELECT json_extract(value,'$[0]') AS utc_day,json_extract(value,'$[1]') AS date,
  json_extract(value,'$[2]') AS start,json_extract(value,'$[3]') AS end,
  COALESCE(json_extract(value,'$[4]'),json_extract(value,'$[3]')) AS ceiling FROM json_each(?)`;
// Every source stays in SQLite. These are indexed timestamp ranges, not event materialization.
const rangeAnswers=`(SELECT COUNT(*) FROM imported_reviews WHERE ${ratedImport}
    AND json_extract(data,'$.reviewedAt')>=ranges.start AND json_extract(data,'$.reviewedAt')<ranges.end
    AND json_extract(data,'$.reviewedAt')<=ranges.ceiling)
  +(SELECT COUNT(*) FROM review_events WHERE undone=0 AND reviewed_at>=ranges.start AND reviewed_at<ranges.end AND reviewed_at<=ranges.ceiling)
  +(SELECT COUNT(*) FROM practice_events WHERE undone=0 AND reviewed_at>=ranges.start AND reviewed_at<ranges.end AND reviewed_at<=ranges.ceiling)`;

/** The calendar label follows the scheduler's local wall-clock rollover. */
function studyDate(timestamp: number, format: Intl.DateTimeFormat, dayStart: number): string {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour - dayStart)).toISOString().slice(0,10);
}
function dayRanges(utcDay:string, end:number, collection:ImportDocument['collection'], format:Intl.DateTimeFormat):DayRange[] {
  const result:DayRange[]=[];
  let start=Date.parse(`${utcDay}T00:00:00Z`);
  while(start<end) {
    const next=Math.min(end,nextStudyDayBoundary(start,collection.timeZone,collection.dayStart));
    if(next<=start)throw new Error('Invalid progress calendar boundary');
    result.push([utcDay,studyDate(start,format,collection.dayStart),start,next]); start=next;
  }
  return result;
}

/** Persisted, rebuildable projection; source history remains the canonical export. */
export async function progress(db: D1Database, collection: ImportDocument['collection'], now: number): Promise<ProgressResponse> {
  const { timeZone, dayStart } = collection;
  const calendar=JSON.stringify([timeZone,dayStart]);
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const today = studyDate(now,format,dayStart);
  const utcToday=new Date(now).toISOString().slice(0,10);
  const boundary = studyDayBoundary(now,timeZone,dayStart);
  const tomorrowEnd = nextStudyDayBoundary(nextStudyDayBoundary(now,timeZone,dayStart),timeZone,dayStart);
  const todayDate = Date.parse(`${today}T00:00:00Z`);
  const firstDate=new Date(todayDate-181*DAY).toISOString().slice(0,10);
  const weekStart = new Date(todayDate-((new Date(todayDate).getUTCDay()+6)%7)*DAY).toISOString().slice(0,10);
  const dirtySql=`SELECT d.utc_day,d.revision FROM progress_dirty d LEFT JOIN progress_buckets b
    ON b.calendar=? AND b.utc_day=d.utc_day WHERE d.utc_day<? AND (b.revision IS NULL OR b.revision<>d.revision)`;
  // Bounded cold-build work (at most 8192 UTC dates per request), never thousands of
  // calls or an unbounded .all of reviews. A larger cold build safely resumes on retry.
  // Current UTC day is always read live, including future events that become visible later.
  for(let attempt=0;attempt<4;attempt++) {
    const clock=await db.prepare('SELECT revision FROM progress_clock WHERE id=1').first<{revision:number}>();
    const revision=clock!.revision;
    const dirty=await db.prepare(`${dirtySql} ORDER BY d.utc_day LIMIT 2048`).bind(calendar,utcToday).all<DirtyDay>();
    if(dirty.results.length) {
      const ranges=dirty.results.flatMap(d=>dayRanges(d.utc_day,Date.parse(`${d.utc_day}T00:00:00Z`)+DAY,collection,format));
      const dates=JSON.stringify(dirty.results.map(d=>[d.utc_day,d.revision]));
      await db.batch([
        db.prepare(`DELETE FROM progress_days WHERE calendar=? AND utc_day IN(SELECT json_extract(value,'$[0]') FROM json_each(?))
          AND (SELECT revision FROM progress_clock WHERE id=1)=?`).bind(calendar,dates,revision),
        db.prepare(`INSERT INTO progress_days(calendar,utc_day,study_date,answers)
          SELECT ?,utc_day,date,${rangeAnswers} FROM (${rangesSql}) ranges
          WHERE (SELECT revision FROM progress_clock WHERE id=1)=?`).bind(calendar,JSON.stringify(ranges),revision),
        db.prepare(`INSERT INTO progress_buckets(calendar,utc_day,revision)
          SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
          WHERE (SELECT revision FROM progress_clock WHERE id=1)=?
          ON CONFLICT(calendar,utc_day) DO UPDATE SET revision=excluded.revision`).bind(calendar,dates,revision),
      ]);
    }
    const [projection,tomorrowResult,practiceToday] = await Promise.all([
      db.prepare(`WITH contributions AS (
        SELECT p.study_date AS date,p.answers FROM progress_days p JOIN progress_buckets b
          ON b.calendar=p.calendar AND b.utc_day=p.utc_day JOIN progress_dirty d ON d.utc_day=b.utc_day AND d.revision=b.revision
          WHERE p.calendar=? AND p.utc_day<?
        UNION ALL SELECT date,${rangeAnswers} FROM (${rangesSql}) ranges
      ), days AS (SELECT date,SUM(answers) AS answers FROM contributions GROUP BY date HAVING SUM(answers)>0)
      SELECT (SELECT revision FROM progress_clock WHERE id=1) AS revision,
        EXISTS(${dirtySql}) AS incomplete,COUNT(*) AS totalStudyDays,
        COALESCE(SUM(date>=? AND date<=?),0) AS weekStudyDays,
        COALESCE(SUM(CASE WHEN date=? THEN answers ELSE 0 END),0) AS todayAnswers,
        (SELECT json_group_array(json_object('date',date,'answers',answers)) FROM days WHERE date>=? AND date<=?) AS days FROM days`)
        .bind(calendar,utcToday,JSON.stringify(dayRanges(utcToday,now+1,collection,format).map(r=>[...r,now])),calendar,utcToday,
          weekStart,today,today,firstDate,today).first<{revision:number;incomplete:number;totalStudyDays:number;weekStudyDays:number;todayAnswers:number;days:string}>(),
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
      db.prepare('SELECT COUNT(*) AS answers FROM practice_events WHERE undone=0 AND reviewed_at>=? AND reviewed_at<=?')
        .bind(boundary,now).first<{ answers: number }>(),
    ]);
    const final=await db.prepare('SELECT revision FROM progress_clock WHERE id=1').first<{revision:number}>();
    // A mutation during range reads/publication cannot yield a partial or stale calendar.
    if(final!.revision!==revision||projection!.revision!==revision||projection!.incomplete)continue;
    const answers=new Map((JSON.parse(projection!.days) as {date:string;answers:number}[]).map(d=>[d.date,d.answers]));
    return {today,days:Array.from({length:182},(_,index)=>{
      const date=new Date(todayDate-(181-index)*DAY).toISOString().slice(0,10);
      return {date,answers:answers.get(date)??0};
    }),totalStudyDays:projection!.totalStudyDays,weekStudyDays:projection!.weekStudyDays,todayAnswers:projection!.todayAnswers,
      todayNormalAnswers:projection!.todayAnswers-(practiceToday?.answers??0),todayPracticeAnswers:practiceToday?.answers??0,
      tomorrow:tomorrowResult!};
  }
  throw new Error('Progress projection is rebuilding or history changed; retry safely');
}
