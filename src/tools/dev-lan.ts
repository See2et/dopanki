import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

// A Host header cannot establish connection origin. Passwordless dev must bind
// loopback at the network layer; this separate LAN launcher requires a secret.
let password = '';
try { password = parseEnv(await readFile('.dev.vars','utf8')).APP_PASSWORD || ''; }
catch { /* Missing or unreadable configuration must not expose a LAN listener. */ }
if (!password.trim()) {
  console.error('LAN起動には .dev.vars の APP_PASSWORD が必要です。READMEのスマホ利用手順に従って設定してください。');
  process.exit(1);
}
const child = spawn('npx',['wrangler','dev','--ip','0.0.0.0'], { stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error',error => { console.error(error.message); process.exit(1); });
child.on('exit',(code,signal) => process.exit(code ?? (signal ? 1 : 0)));
