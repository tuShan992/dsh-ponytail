// The detached janitor must delete the checkout after the dependency is gone,
// even though it runs outside the plugin process. Run with: node test-janitor.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-jan-'));
const home = path.join(root, 'home');
const prof = path.join(root, 'profile');
process.env.DSH_HOME = home;
process.env.DSH_PROFILE_DIR = prof;
const dir = path.join(home, 'plugins', 'dsh-ponytail');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ponytail' }));
fs.writeFileSync(path.join(dir, '.ponytail-source.json'), JSON.stringify({ name: 'dsh-ponytail', origin: 'x' }));
fs.mkdirSync(prof, { recursive: true });
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({ dependencies: { 'dsh-ponytail': 'file:x' } }));

const mod = await import(pathToFileURL(path.join(process.cwd(), 'index.js')).href);
const child = spawn(process.execPath, ['-e', mod.cleanupWorkerCode()], {
  env: { ...process.env, PT_DIR: dir, PT_PROFILE: prof },
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

await sleep(2000);
ok(fs.existsSync(dir), 'kept while dependency present');
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({ dependencies: {} }));
await sleep(3500);
ok(!fs.existsSync(dir), 'janitor deletes after uninstall');

fs.rmSync(root, { recursive: true, force: true });
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('ALL PASS');
