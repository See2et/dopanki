import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { importStatements, validateImport } from '../lib/import';
import type { ImportDocument } from '../lib/types';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const onlySql = args.includes('--sql-only');
const value = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : fallback; };
const input = args.find((arg,i) => !arg.startsWith('--') && !['--timezone','--day-start'].includes(args[i-1]));
if (!input) {
  console.error('Usage: npm run import:anki -- PACKAGE.apkg [--timezone Asia/Tokyo] [--day-start 4] [--remote | --sql-only]');
  process.exit(1);
}
const run = (command: string, arguments_: string[], capture = false) => {
  const child = spawnSync(command,arguments_,{ stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${command} failed (${child.status}). ${capture ? child.stderr : ''}`);
  return child.stdout;
};
const output = resolve('.local/import');
await mkdir(output,{ recursive: true });
const source = resolve(input);
if (source.endsWith('.json')) {
  await access(source);
} else {
  try { await access('.venv/bin/python'); }
  catch {
    run('uv',['venv','.venv']);
    run('uv',['pip','install','--python','.venv/bin/python','-r','requirements.txt']);
  }
  const importerArgs = ['scripts/import_anki.py',source,'--output',output,'--timezone',value('--timezone','Asia/Tokyo'),'--require-scheduling'];
  if (args.includes('--day-start')) importerArgs.push('--day-start',value('--day-start','4'));
  run('.venv/bin/python',importerArgs);
}
const document = JSON.parse(await readFile(source.endsWith('.json') ? source : join(output,'collection.json'),'utf8')) as unknown;
validateImport(document);
const d: ImportDocument = document;
const statements = importStatements(d);
const sqlPath = join(output,'import.sql');
const mode = remote ? '--remote' : '--local';
const execute = (arguments_: string[]) => { run('npx',['wrangler',...arguments_],true); };
// Publish collection metadata last: partial loads are never offered for learning.
await writeFile(sqlPath,statements.slice(1).join(';\n')+';\n');
await writeFile(join(output,'finalize.sql'),statements[0]+';\n');
if (onlySql) {
  console.log(`SQL created: ${sqlPath}, ${join(output,'finalize.sql')}. Metadata must be loaded last.`);
  process.exit(0);
}
console.log(`Preparing ${remote ? 'remote' : 'local'} database…`);
execute(['d1','migrations','apply','dopanki',mode]);
const queryResult = run('npx',['wrangler','d1','execute','dopanki',mode,'--command','SELECT COUNT(*) AS count FROM collections','--json'],true);
const parsed = JSON.parse(queryResult) as { results: { count: number }[] }[];
if (parsed.some(r => r.results.some(x => x.count > 0))) throw new Error('既に教材が取り込まれています。学習状態を守るため再取り込みは停止しました。別のDBで取り込んでください。');
// Incomplete previous import has no collection marker and can be retried safely.
execute(['d1','execute','dopanki',mode,'--command','DELETE FROM review_events; DELETE FROM imported_reviews; DELETE FROM cards; DELETE FROM notes; DELETE FROM note_types; DELETE FROM decks; DELETE FROM media;']);
console.log(`Loading ${d.cards.length} cards and ${d.reviews.length} history records…`);
execute(['d1','execute','dopanki',mode,'--file',sqlPath]);
for (const media of d.media) {
  const path = resolve(source.endsWith('.json') ? join(source,'..',media.path) : join(output,media.path));
  const objectKey = `dopanki-media/anki/${d.source.sha256}/${media.name}`;
  execute(['r2','object','put',objectKey,'--file',path,mode]);
}
execute(['d1','execute','dopanki',mode,'--file',join(output,'finalize.sql')]);
console.log(`Imported ${basename(d.source.name)}: ${d.cards.length} cards, ${d.reviews.length} reviews, ${d.media.length} media (${remote ? 'remote' : 'local'}).`);
for (const warning of d.warnings) console.log(`Warning: ${warning}`);
