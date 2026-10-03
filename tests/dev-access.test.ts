import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

it('LAN launcher refuses missing and empty secrets before starting a listener', () => {
  const directory = mkdtempSync(join(tmpdir(),'dopanki-access-'));
  try {
    for (const contents of [null, 'APP_PASSWORD=""', 'APP_PASSWORD="  "']) {
      if (contents !== null) writeFileSync(join(directory,'.dev.vars'),contents);
      const child = spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('src/tools/dev-lan.ts')], { cwd: directory, encoding: 'utf8', timeout: 10000 });
      expect(child.status).toBe(1); expect(child.stderr).toContain('APP_PASSWORD');
    }
  } finally { rmSync(directory,{ recursive: true, force: true }); }
});
