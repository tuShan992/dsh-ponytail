// Guards around deleting the DSH_HOME source clone on uninstall.
// Run with: node test-cleanup.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cl-'));
const home = path.join(root, 'home');
const prof = path.join(root, 'profile');
process.env.DSH_HOME = home;
process.env.DSH_PROFILE_DIR = prof;

const plugin = path.join(home, 'plugins', 'dsh-ponytail');
fs.mkdirSync(path.join(plugin, '.git'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-ponytail' }));
fs.writeFileSync(path.join(plugin, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/tuShan992/dsh-ponytail.git\n');

const mod = await import(pathToFileURL(path.join(process.cwd(), 'index.js')).href);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

fs.mkdirSync(prof, { recursive: true });
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({ dependencies: { 'dsh-ponytail': 'file:x' } }));
ok(mod.dependsOnSelf() === true, 'dependency present -> keep');

fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'other' }));
mod.removeSourceClone();
ok(fs.existsSync(plugin), 'wrong package name -> not deleted');
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-ponytail' }));

fs.rmSync(path.join(plugin, '.git'), { recursive: true, force: true });
mod.removeSourceClone();
ok(fs.existsSync(plugin), 'no .git -> not deleted');

fs.mkdirSync(path.join(plugin, '.git'), { recursive: true });
fs.writeFileSync(path.join(plugin, '.git', 'config'), 'url=https://github.com/tuShan992/dsh-ponytail.git\n');
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({ dependencies: {} }));
ok(mod.dependsOnSelf() === false, 'dependency gone -> cleanup');
mod.removeSourceClone();
ok(!fs.existsSync(plugin), 'clone deleted after uninstall');

fs.writeFileSync(path.join(prof, 'package.json'), '{ not json');
ok(mod.dependsOnSelf() === true, 'unreadable manifest -> keep');

fs.rmSync(root, { recursive: true, force: true });
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('ALL PASS');
