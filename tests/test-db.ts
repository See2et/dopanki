import { DatabaseSync } from 'node:sqlite';
export class TestDb {
  sqlite = new DatabaseSync(':memory:');
  queries = 0;
  afterFirst?: (sql:string) => void;
  afterAll?: (sql:string) => void;
  beforeRun?: (sql:string) => void;
  reads: {sql:string;args:(string|number|null)[];rows:number;method:'first'|'all'}[] = [];
  prepare(sql: string) {
    this.queries++;
    const db = this.sqlite;
    const owner = this;
    let args: (string | number | null)[] = [];
    const statement = {
      bind(...values: (string | number | null)[]) { args = values; return statement; },
      async first() { const row=db.prepare(sql).get(...args) ?? null; owner.reads.push({sql,args:[...args],rows:row?1:0,method:'first'}); owner.afterFirst?.(sql); return row; },
      async all() { const results=db.prepare(sql).all(...args); owner.reads.push({sql,args:[...args],rows:results.length,method:'all'}); owner.afterAll?.(sql); return { results, success: true, meta: {} }; },
      async run() { owner.beforeRun?.(sql); const result = db.prepare(sql).run(...args); return { results: [], success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  async batch(statements: ReturnType<TestDb['prepare']>[]) {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
