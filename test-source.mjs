// Ensures the materialized source checkout has no .git and records its origin.
// Needs network + git. Run with: node test-source.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-src-'));
const home = path.join(root, 'home');
const prof = path.join(root, 'profile');
process.env.DSH_HOME = home;
process.env.DSH_PROFILE_DIR = prof;
fs.mkdirSync(prof, { recursive: true });
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({ dependencies: { 'dsh-ponytail': 'github:tuShan992/dsh-ponytail' } }));

const mod = await import(pathToFileURL(path.join(process.cwd(), 'index.js')).href);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const dir = path.join(home, 'plugins', 'dsh-ponytail');

const steps = [];
const first = await mod.ensureSourceRepo(dir, steps);
ok(first.ok === true, 'clone ok');
ok(fs.existsSync(path.join(dir, 'package.json')), 'checkout has package.json');
ok(!fs.existsSync(path.join(dir, '.git')), 'checkout has no .git');
const meta = JSON.parse(fs.readFileSync(path.join(dir, '.ponytail-source.json'), 'utf8'));
ok(meta.name === 'dsh-ponytail' && /dsh-ponytail/.test(meta.origin), 'marker records origin');

const again = await mod.ensureSourceRepo(dir, []);
ok(again.ok === true && !fs.existsSync(path.join(dir, '.git')), 'refresh keeps no .git');

fs.rmSync(root, { recursive: true, force: true });
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('ALL PASS');
