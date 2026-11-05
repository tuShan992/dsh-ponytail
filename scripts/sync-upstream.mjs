#!/usr/bin/env node
// Re-package the DSH plugin from the latest upstream ponytail.
//
// What it does, in order:
//   1. download the upstream npm package (@dietrichgebert/ponytail)
//   2. copy every skills/<name>/SKILL.md into this package's skills/
//   3. record the upstream version in package.json (and mirror it as the
//      plugin version unless --keep-version)
//   4. run the self-test and roll everything back if it fails
//   5. optionally `npm pack` a distributable tarball (--pack)
//
// Everything DSH-specific (index.js, cordis.patch.yml, README, LICENSE, the
// manifest's peer deps) is left untouched — only the skill bodies and the
// version metadata are refreshed.
//
// Usage:
//   node scripts/sync-upstream.mjs                 # track npm "latest"
//   node scripts/sync-upstream.mjs --version 5.3.3 # pin a release
//   node scripts/sync-upstream.mjs --pack          # also build dist/*.tgz
//   node scripts/sync-upstream.mjs --keep-version  # don't touch package version
//   node scripts/sync-upstream.mjs --no-test       # skip the self-test
//   node scripts/sync-upstream.mjs --dry-run       # fetch + report, change nothing

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PKG_FILE = path.join(REPO, "package.json");
const SKILLS_DIR = path.join(REPO, "skills");
const UPSTREAM = "@dietrichgebert/ponytail";

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
  process.exit(0);
}

const target = opt("--version") || "latest";
const mirrorVersion = !hasFlag("--keep-version");
const wantPack = hasFlag("--pack");
const runTest = !hasFlag("--no-test");
const dryRun = hasFlag("--dry-run");

function log(...a) { console.log(...a); }
function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ponytail-sync-"));
const npmCache = path.join(tmp, "npm-cache");
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };

try {
  // 1. Download the upstream package --------------------------------------
  // Uses the registry over HTTPS with Node's built-in fetch, so this works
  // both from a terminal and from the DSH host (whose PATH has no npm).
  log(`→ fetching ${UPSTREAM}@${target} …`);
  const registry = (process.env.PONYTAIL_REGISTRY || process.env.npm_config_registry || "https://registry.npmmirror.com").replace(/\/+$/, "");
  const metaUrl = `${registry}/${UPSTREAM.replace("/", "%2F")}/${target}`;
  let meta;
  try {
    const res = await fetch(metaUrl, { headers: { accept: "application/json" } });
    if (!res.ok) die(`registry returned HTTP ${res.status} for ${metaUrl}`);
    meta = await res.json();
  } catch (error) {
    die(`could not fetch ${metaUrl}:\n${(error && error.message) || error}`);
  }
  const tarballUrl = meta && meta.dist && meta.dist.tarball;
  if (!tarballUrl) die(`registry response has no dist.tarball for ${UPSTREAM}@${target}`);
  const tarball = path.join(tmp, "upstream.tgz");
  try {
    const res = await fetch(tarballUrl);
    if (!res.ok) die(`tarball download returned HTTP ${res.status}: ${tarballUrl}`);
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  } catch (error) {
    die(`could not download ${tarballUrl}:\n${(error && error.message) || error}`);
  }

  // 2. Extract it ---------------------------------------------------------
  const extractDir = path.join(tmp, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const pkgDir = path.join(extractDir, "package");
  const upPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const upVersion = upPkg.version || target;

  const upSkillsDir = path.join(pkgDir, "skills");
  if (!fs.existsSync(upSkillsDir)) die(`upstream package has no skills/ directory`);
  const upSkills = fs.readdirSync(upSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(upSkillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  if (upSkills.length === 0) die("upstream package ships no skills/*/SKILL.md");

  log(`  upstream version: ${upVersion}`);
  log(`  upstream skills:  ${upSkills.join(", ")}`);

  if (dryRun) {
    cleanup();
    log("\n(dry run — nothing written)");
    process.exit(0);
  }

  // 3. Back up current state (for rollback) ------------------------------
  const backupDir = path.join(tmp, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(SKILLS_DIR)) fs.cpSync(SKILLS_DIR, path.join(backupDir, "skills"), { recursive: true });
  fs.copyFileSync(PKG_FILE, path.join(backupDir, "package.json"));

  // 4. Copy the skill bodies ---------------------------------------------
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const changed = [];
  for (const name of upSkills) {
    const src = path.join(upSkillsDir, name, "SKILL.md");
    const dstDir = path.join(SKILLS_DIR, name);
    const dst = path.join(dstDir, "SKILL.md");
    fs.mkdirSync(dstDir, { recursive: true });
    const before = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;
    const after = fs.readFileSync(src, "utf8");
    if (before !== after) {
      fs.writeFileSync(dst, after);
      changed.push(name);
    }
  }
  const localOnly = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !upSkills.includes(name));

  // 5. Update package.json metadata --------------------------------------
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, "utf8"));
  pkg.upstream = { name: UPSTREAM, version: upVersion };
  if (mirrorVersion) pkg.version = upVersion;
  fs.writeFileSync(PKG_FILE, `${JSON.stringify(pkg, null, 2)}\n`);

  log(changed.length ? `  updated: ${changed.join(", ")}` : "  skills already up to date");
  if (localOnly.length) log(`  note: kept local-only skills: ${localOnly.join(", ")}`);

  // 6. Self-test (roll back on failure) ----------------------------------
  if (runTest) {
    log("→ running self-test …");
    try {
      run(process.execPath, [path.join(REPO, "test.mjs")], { stdio: "inherit" });
    } catch {
      fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
      fs.cpSync(path.join(backupDir, "skills"), SKILLS_DIR, { recursive: true });
      fs.copyFileSync(path.join(backupDir, "package.json"), PKG_FILE);
      die("self-test failed — changes rolled back.");
    }
    log("  ✓ self-test passed");
  }

  // 7. Optional distributable --------------------------------------------
  if (wantPack) {
    log("→ packing distributable …");
    const outDir = path.join(REPO, "dist");
    fs.mkdirSync(outDir, { recursive: true });
    const out = run("npm", ["--cache", npmCache, "pack", ".", "--pack-destination", outDir, "--silent"], { cwd: REPO });
    log(`  ✓ ${path.join(outDir, out.trim().split("\n").filter(Boolean).pop())}`);
  }

  cleanup();
  log(`\n✔ dsh-ponytail synced to upstream ${upVersion}${mirrorVersion ? ` (plugin v${upVersion})` : ""}`);
} catch (error) {
  cleanup();
  die(error && error.stack ? error.stack : String(error));
}
