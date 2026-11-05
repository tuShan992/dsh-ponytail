import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const name = "dsh-ponytail";

// The four services this plugin uses:
//   skills       — serve the six `ponytail*` skills from ./skills
//   systemPrompt — inject the active ruleset into every turn
//   commands     — provide the `/ponytail` mode command
//   webServer    — the settings-page sync route (client half in ./client.js)
export const inject = ["skills", "systemPrompt", "commands", "webServer"];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(PLUGIN_DIR, "skills");
const PROVIDER_NAME = "dsh-ponytail";

// Rank used by bundled skills. The real value is exported by
// @deepseek-ai/dsh-skill; fall back to 600 so the module also loads (and can
// be unit-tested) outside a full DSH install.
let BUNDLED_SKILL_RANK = 600;
try {
  const mod = await import("@deepseek-ai/dsh-skill");
  if (typeof mod.BUNDLED_SKILL_RANK === "number") {
    BUNDLED_SKILL_RANK = mod.BUNDLED_SKILL_RANK;
  }
} catch {
  /* standalone / test environment: keep the fallback */
}

// `createUserMessage` lets a command start a model turn (used by the
// review/audit/debt commands, which need the model to do work). Optional so
// the module still loads without a full DSH install.
let createUserMessage;
try {
  const llm = await import("@deepseek-ai/dsh-llm");
  if (typeof llm.createUserMessage === "function") createUserMessage = llm.createUserMessage;
} catch {
  /* standalone / test environment */
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const RUNTIME_MODES = ["off", "lite", "full", "ultra"];
const RUNTIME_MODE_SET = new Set(RUNTIME_MODES);

function normalizeMode(value) {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  return RUNTIME_MODE_SET.has(mode) ? mode : undefined;
}

// Default mode resolution mirrors upstream ponytail:
//   PONYTAIL_DEFAULT_MODE env  >  ~/.config/ponytail/config.json  >  "full"
function readDefaultMode() {
  const fromEnv = normalizeMode(process.env.PONYTAIL_DEFAULT_MODE);
  if (fromEnv) return fromEnv;

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const configPaths = [
    path.join(configHome, "ponytail", "config.json"),
    path.join(os.homedir(), ".config", "ponytail", "config.json"),
  ];
  for (const file of configPaths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const fromFile = normalizeMode(parsed?.defaultMode);
      if (fromFile) return fromFile;
    } catch {
      /* missing or malformed config: try the next location */
    }
  }
  return "full";
}

// "stop ponytail" / "normal mode", ignoring case and a trailing . ! ?
function isDeactivationCommand(text) {
  if (typeof text !== "string") return false;
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, "").trim();
  return normalized === "stop ponytail" || normalized === "normal mode";
}

// ---------------------------------------------------------------------------
// Per-session state (mode per session, persisted to the profile)
// ---------------------------------------------------------------------------

function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  // GUI-launched hosts do not export DSH_PROFILE_DIR. The installed half loads
  // from <profile>/node_modules/dsh-ponytail, so the profile dir is two levels
  // up from PLUGIN_DIR.
  if (path.basename(path.dirname(PLUGIN_DIR)) === "node_modules") {
    return path.dirname(path.dirname(PLUGIN_DIR));
  }
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, "profiles", process.env.DSH_PROFILE || "default");
  return path.join(os.homedir(), ".dsh", "profiles", "default");
}

function stateDir() {
  return path.join(profileDir(), "ponytail");
}

function stateFile() {
  return path.join(stateDir(), "session-states.json");
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.sessions === "object" && parsed.sessions) {
      return parsed;
    }
  } catch {
    /* no state yet */
  }
  return { version: 1, sessions: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const target = stateFile();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
  } catch {
    /* best effort: a read-only profile must not break the turn */
  }
}

// ---------------------------------------------------------------------------
// Skill files: frontmatter + body
// ---------------------------------------------------------------------------

function stripFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1], body: raw.slice(match[0].length) };
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

// Minimal YAML frontmatter reader: enough for the six skill files
// (scalar `name`, and `description` as inline, folded `>`, or literal `|`).
function parseFrontmatter(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = match[2];

    if (rest === ">" || rest === "|") {
      const folded = rest === ">";
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === "") {
          block.push("");
          continue;
        }
        if (!/^\s+/.test(next)) break;
        block.push(next.replace(/^\s+/, ""));
      }
      i = j - 1;
      // Trim leading/trailing blank lines, then join.
      while (block.length && block[0] === "") block.shift();
      while (block.length && block[block.length - 1] === "") block.pop();
      result[key] = folded
        ? block.join(" ").replace(/\s+/g, " ").trim()
        : block.join("\n").trim();
      continue;
    }

    if (rest !== "") {
      result[key] = unquote(rest);
      continue;
    }

    // Plain scalar continued on indented following lines.
    const block = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === "") break;
      if (!/^\s+/.test(next)) break;
      block.push(next.trim());
    }
    if (block.length) {
      i = j - 1;
      result[key] = block.join(" ").trim();
    } else {
      result[key] = "";
    }
  }
  return result;
}

function scanSkills() {
  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    const file = path.join(dir, "SKILL.md");
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { frontmatter } = stripFrontmatter(raw);
    const meta = parseFrontmatter(frontmatter);
    const skillName = meta.name || entry.name;
    const description = (meta.description || "").trim() || `The ${skillName} skill.`;
    candidates.push({
      name: skillName,
      description,
      source: "bundled",
      provider: PROVIDER_NAME,
      rank: BUNDLED_SKILL_RANK,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: "directory", path: dir },
      locator: pathToFileURL(file).href,
      path: file,
    });
  }
  // Stable, readable ordering.
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

function readSkill(skillName) {
  const dir = path.join(SKILLS_DIR, skillName);
  const file = path.join(dir, "SKILL.md");
  const raw = fs.readFileSync(file, "utf8");
  return stripFrontmatter(raw).body;
}

const skillCache = new Map();
function getSkillBody(skillName) {
  if (!skillCache.has(skillName)) skillCache.set(skillName, readSkill(skillName));
  return skillCache.get(skillName);
}

// Start a real model turn from a command (same mechanism /plan uses), so the
// answer lands in the chat like any other skill instead of a command-only stub.
export function startQuestionTurn(agent, question, makeMessage) {
  if (!makeMessage || !agent || typeof agent.steer !== "function") return false;
  agent.steer(makeMessage({
    content: [{ type: "text", text: question }],
    source: { kind: "user" },
  }));
  return true;
}

// ---------------------------------------------------------------------------
// Ruleset builder (mirrors upstream hooks/ponytail-instructions.js)
// ---------------------------------------------------------------------------

// Keep only the table row / quoted example for the active level; ordinary
// rule lines survive verbatim.
function filterSkillBodyForMode(body, mode) {
  const lines = body.split("\n");
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();

    const row = /^\|\s*\*\*(lite|full|ultra)\*\*\s*\|/.exec(trimmed);
    if (row) {
      if (row[1] === mode) kept.push(line);
      continue;
    }

    const example = /^-\s*(lite|full|ultra)\s*:/.exec(trimmed);
    if (example) {
      if (example[1] === mode) kept.push(line);
      continue;
    }

    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFallbackInstructions(mode) {
  return [
    `PONYTAIL MODE ACTIVE — level: ${mode}`,
    "",
    "You are a lazy senior developer. The best code is the code never written. Solve the whole problem with the least new code, but finish every part the task needs (callers, tests, fixtures). Never cut validation, security, accessibility, error handling that prevents data loss, or anything the user explicitly asked for. Name what you skipped and any risk in one or two lines at the end.",
    "",
    "Scale by level: lite = build what was asked and name the smaller option in one line; full = the default rules; ultra = also push back on parts the need does not justify.",
  ].join("\n");
}

export function getPonytailInstructions(mode) {
  if (mode === "off") return "";
  const header = `PONYTAIL MODE ACTIVE — level: ${mode}\n\n`;
  let body;
  try {
    body = filterSkillBodyForMode(getSkillBody("ponytail"), mode);
  } catch {
    return header + getFallbackInstructions(mode);
  }
  return header + body;
}

// ---------------------------------------------------------------------------
// Sync-from-upstream (server half of the settings page)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "" && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// The desktop host is Electron: process.resourcesPath points at
// .../Contents/Resources, next to the bundled node and pnpm. GUI launches do
// not inherit a shell PATH, so we must use these absolute paths rather than
// spawning `node`/`pnpm` by name.
// The bundled node binary is `node.exe` on Windows and `node` elsewhere; asking
// for the wrong name silently falls through to the extensionless POSIX shim in
// runtime/bin, which Windows cannot spawn (ENOENT).
function bundledNodeName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function resourcesDirs() {
  const dirs = [];
  const nodeName = bundledNodeName();
  if (typeof process.resourcesPath === "string" && process.resourcesPath !== "") dirs.push(process.resourcesPath);
  // Walk up from process.execPath looking for a Contents/Resources that holds
  // the bundled runtime — covers a plain-node host whose execPath is the
  // bundled node itself.
  let dir;
  try {
    dir = path.dirname(process.execPath);
  } catch {
    dir = undefined;
  }
  for (let depth = 0; dir && depth < 8; depth += 1) {
    if (path.basename(dir) === "Resources" && fs.existsSync(path.join(dir, "runtime", "primary-runtime", "dependencies", "node", "bin", nodeName))) {
      dirs.push(dir);
      break;
    }
    dir = path.dirname(dir);
  }
  return dirs;
}

function resolveBundledNode() {
  const nodeName = bundledNodeName();
  const candidates = [process.env.PONYTAIL_NODE];
  for (const dir of resourcesDirs()) {
    candidates.push(path.join(dir, "runtime", "primary-runtime", "dependencies", "node", "bin", nodeName));
    candidates.push(path.join(dir, "runtime", "bin", nodeName));
  }
  return firstExistingFile(candidates) || "node";
}

function resolvePnpmCjs() {
  const candidates = [process.env.PONYTAIL_PNPM];
  for (const dir of resourcesDirs()) {
    candidates.push(path.join(dir, "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs"));
  }
  return firstExistingFile(candidates);
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The plugin SOURCE directory (the mutable copy the sync script writes to).
 *
 * The installed copy under node_modules is produced from it by `pnpm install`,
 * so the button must update the source and then reinstall — hence we read the
 * source path back out of the profile's dependency spec (`file:/abs/path`).
 */
function installSpec() {
  try {
    const pkg = readPkg(profileDir());
    const spec = pkg && pkg.dependencies && pkg.dependencies["dsh-ponytail"];
    return typeof spec === "string" ? spec : null;
  } catch {
    return null;
  }
}

function resolveSourceDir() {
  if (process.env.PONYTAIL_SOURCE_DIR) return process.env.PONYTAIL_SOURCE_DIR;
  const spec = installSpec();
  if (spec && (spec.startsWith("file:") || spec.startsWith("link:"))) {
    const ref = spec.slice(5);
    return path.isAbsolute(ref) ? ref : path.resolve(profileDir(), ref);
  }
  // A git/npm install keeps its mutable source checkout under DSH_HOME.
  return defaultPluginDir();
}

function defaultPluginDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "plugins", "dsh-ponytail");
}

function gitUrlFromSpec(spec) {
  const s = String(spec || "").trim();
  const m = /^github:([^#\s]+?)(?:#.*)?$/.exec(s);
  if (m) return `https://github.com/${m[1]}.git`;
  if (s.startsWith("git+")) return s.slice(4).replace(/#.*$/, "");
  if (/^https?:\/\//.test(s)) return s.replace(/#.*$/, "");
  return null;
}

function runGit(args, cwd, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    let timer = null;
    let timedOut = false;
    // GUI-launched hosts on macOS often lack Homebrew in PATH; widen it so a
    // real git is found instead of the Xcode command-line-tools shim.
    const extraPath = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => fs.existsSync(d)).join(path.delimiter);
    const PATH = [process.env.PATH || "", extraPath].filter(Boolean).join(path.delimiter);
    const env = { ...process.env, PATH, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", CI: "1" };
    try {
      child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: errorMessage(error), timedOut });
      return;
    }
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, timeoutMs);
    }
    if (child.stdout) child.stdout.on("data", (c) => { stdout += c; });
    if (child.stderr) child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + errorMessage(error), timedOut }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut }); });
  });
}

function sourceMetaPath(dir) {
  return path.join(dir, ".ponytail-source.json");
}

function readSourceMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(sourceMetaPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function writeSourceMeta(dir, origin) {
  try {
    fs.writeFileSync(sourceMetaPath(dir), JSON.stringify({ name: "dsh-ponytail", origin, at: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}

// fs.rmSync leaves read-only files behind on Windows (git pack files are read-only).
function rmrf(target) {
  const clear = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    if (stat.isDirectory()) {
      try { fs.chmodSync(p, 0o777); } catch { /* ignore */ }
      let entries = [];
      try { entries = fs.readdirSync(p); } catch { /* ignore */ }
      for (const entry of entries) clear(path.join(p, entry));
    } else {
      try { fs.chmodSync(p, 0o666); } catch { /* ignore */ }
    }
  };
  try { fs.rmSync(target, { recursive: true, force: true }); return; } catch { /* retry below */ }
  clear(target);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Materialize or refresh the plugin's source checkout under DSH_HOME, so the
// sync button clones it locally instead of depending on an external directory.
// The checkout keeps no `.git`: it is generated output, replaced on every sync.
async function ensureSourceRepo(dir, steps) {
  const meta = readSourceMeta(dir);
  const url = process.env.PONYTAIL_GIT_URL || gitUrlFromSpec(installSpec()) || (meta && meta.origin) || null;
  if (!url) {
    if (fs.existsSync(path.join(dir, "package.json"))) return { ok: true };
    return { ok: false, error: "no local checkout and no upstream url to clone" };
  }
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.dsh-ponytail-${process.pid}-${Date.now()}`);
  try { rmrf(tmp); } catch { /* ignore */ }
  const r = await runGit(["clone", "--depth", "1", url, tmp], parent);
  steps.push({ name: `git clone ${url}`, code: r.code, output: (r.stdout + r.stderr).trim().slice(-2000) });
  if (r.code !== 0) {
    try { rmrf(tmp); } catch { /* ignore */ }
    return { ok: false, error: "git clone failed" };
  }
  rmrf(path.join(tmp, ".git"));
  writeSourceMeta(tmp, url);
  try {
    rmrf(dir);
    fs.renameSync(tmp, dir);
  } catch {
    // Target could not be replaced atomically: copy over it instead.
    fs.cpSync(tmp, dir, { recursive: true, force: true });
    try { rmrf(tmp); } catch { /* ignore */ }
    writeSourceMeta(dir, url);
  }
  steps.push({ name: "materialized source (no .git)", code: 0, output: dir });
  if (!(await stripGitDir(dir))) {
    steps.push({ name: "remove .git", code: 1, output: "could not remove .git" });
    return { ok: false, error: "could not remove .git from the source checkout" };
  }
  return { ok: true };
}

// A leftover .git can survive the copy fallback when the old dir is locked.
async function stripGitDir(dir) {
  for (let i = 0; i < 6; i++) {
    try { rmrf(path.join(dir, ".git")); } catch { /* ignore */ }
    if (!fs.existsSync(path.join(dir, ".git"))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function nudgeReload() {
  // Replaced plugin files leave the host's routes unmounted (shows as HTTP 404);
  // bumping mtime makes the host reload the plugin.
  const now = new Date();
  for (const f of ["index.js", "cordis.patch.yml"]) {
    try { fs.utimesSync(path.join(installedDir(), f), now, now); } catch { /* ignore */ }
  }
}

function dependsOnSelf() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir(), "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (pkg && pkg[k] && Object.prototype.hasOwnProperty.call(pkg[k], "dsh-ponytail")) return true;
    }
    return false;
  } catch {
    return true; // unreadable manifest: assume still installed, never delete
  }
}

function removeSourceClone() {
  const dir = defaultPluginDir();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (!pkg || pkg.name !== "dsh-ponytail") return;
  } catch { return; }
  // Only delete a checkout we materialized ourselves (marker present); never a
  // user's own directory that merely happens to sit at the same path.
  const meta = readSourceMeta(dir);
  if (!meta || meta.name !== "dsh-ponytail") return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retried next tick */ }
}

// Worker script run in a detached node process. The host may restart right
// after `pnpm remove`, which kills timers owned by the plugin, so the janitor
// must outlive the plugin process to actually delete the checkout.
function cleanupWorkerCode() {
  return [
    'const fs=require("fs"),path=require("path");',
    'const dir=process.env.PT_DIR,prof=process.env.PT_PROFILE;',
    'const installed=()=>{try{const p=JSON.parse(fs.readFileSync(path.join(prof,"package.json"),"utf8"));',
    'const d=Object.assign({},p.dependencies,p.devDependencies,p.optionalDependencies);',
    'return Object.prototype.hasOwnProperty.call(d,"dsh-ponytail");}catch{return true;}};',
    'const mine=()=>{try{if(JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8")).name!=="dsh-ponytail")return false;}catch{return false;}',
    'try{const m=JSON.parse(fs.readFileSync(path.join(dir,".ponytail-source.json"),"utf8"));return m&&m.name==="dsh-ponytail";}catch{return false;}};',
    'const end=Date.now()+120000;',
    'const tick=()=>{if(!installed()&&mine()){try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}if(Date.now()<end)setTimeout(tick,1000);};',
    'setTimeout(tick,800);',
  ].join("");
}

function scheduleSourceCleanup() {
  // Start the detached janitor first so it survives a host restart, then also
  // retry in-process for the common case where the app stays up.
  try {
    const child = spawn(resolveBundledNode(), ["-e", cleanupWorkerCode()], {
      env: { ...process.env, PT_DIR: defaultPluginDir(), PT_PROFILE: profileDir() },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* in-process retries below still run */ }
  let tries = 0;
  const tick = () => {
    tries += 1;
    if (!dependsOnSelf()) { removeSourceClone(); return; }
    if (tries < 8) setTimeout(tick, Math.min(tries * 1500, 12000)).unref?.();
  };
  setTimeout(tick, 1500).unref?.();
}

function installedDir() {
  return path.join(profileDir(), "node_modules", "dsh-ponytail");
}

const UPSTREAM = "@dietrichgebert/ponytail";

function registryBase() {
  return (process.env.PONYTAIL_REGISTRY || process.env.npm_config_registry || "https://registry.npmmirror.com").replace(/\/+$/, "");
}

// Ask the npm registry for the latest published version. Returns null on any
// failure so the status page still renders (network is best-effort).
async function fetchLatestVersion(tag = "latest") {
  const url = `${registryBase()}/${UPSTREAM.replace("/", "%2F")}/${tag}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const meta = await res.json();
    return meta && typeof meta.version === "string" ? meta.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Numeric-segment version compare, pre-release tags ignored (X.Y.Z only).
function compareVersions(a, b) {
  const parse = (v) => String(v || "0").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

async function latestInfo(installedVersion) {
  const latestVersion = await fetchLatestVersion("latest");
  return {
    latestVersion,
    updateAvailable: Boolean(latestVersion && installedVersion && compareVersions(latestVersion, installedVersion) > 0),
  };
}

function syncSnapshot() {
  const sourceDir = resolveSourceDir();
  const installed = installedDir();
  const sourcePkg = sourceDir ? readPkg(sourceDir) : null;
  const installedPkg = readPkg(installed);
  const script = sourceDir ? path.join(sourceDir, "scripts", "sync-upstream.mjs") : null;
  const spec = installSpec();
  const isLocalSpec = Boolean(spec && (spec.startsWith("file:") || spec.startsWith("link:")));
  const hasLocalSource = Boolean(sourceDir && script && fs.existsSync(script));
  // "local" = checkout exists (edit + mirror); "clone" = provision/refresh the
  // checkout under DSH_HOME then sync; "none" = nothing we can do.
  const syncMode = hasLocalSource ? "local" : spec ? "clone" : "none";
  const sourceUpstream = sourcePkg && sourcePkg.upstream ? sourcePkg.upstream.version : null;
  const installedUpstream = installedPkg && installedPkg.upstream ? installedPkg.upstream.version : null;
  return {
    sourceDir,
    installedDir: installed,
    installedSpec: spec,
    sourceVersion: sourcePkg ? sourcePkg.version : null,
    upstreamVersion: sourceUpstream || installedUpstream,
    installedVersion: installedPkg ? installedPkg.version : null,
    node: resolveBundledNode(),
    pnpm: resolvePnpmCjs() || null,
    canSync: Boolean(hasLocalSource || spec),
    syncMode,
  };
}

function runNode(nodePath, args, cwd, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    let timer = null;
    let timedOut = false;
    const env = { ...process.env, ...(options.env || {}) };
    try {
      // stdin ignored so a child that reads input cannot block forever.
      child = spawn(nodePath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: errorMessage(error), timedOut });
      return;
    }
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, options.timeoutMs);
    }
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + errorMessage(error), timedOut }); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) stderr += `\n[timed out after ${Math.round((options.timeoutMs || 0) / 1000)}s]`;
      resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

function runPnpm(args, cwd, timeoutMs = 180000) {
  const pnpm = resolvePnpmCjs();
  if (!pnpm) return Promise.resolve({ code: -1, stdout: "", stderr: "pnpm runtime not found" });
  const extraPath = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => fs.existsSync(d)).join(path.delimiter);
  const PATH = [process.env.PATH || "", extraPath].filter(Boolean).join(path.delimiter);
  const override = Number(process.env.PONYTAIL_PNPM_TIMEOUT_MS) || timeoutMs;
  // Non-interactive git so a credential / first-run prompt can never hang the
  // pnpm child; PATH is widened so pnpm finds a real git, not the Xcode shim.
  return runNode(resolveBundledNode(), [pnpm, ...args], cwd, {
    timeoutMs: override,
    env: { PATH, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", CI: "1", NO_COLOR: "1" },
  });
}

// Snapshot the files `pnpm remove/add` rewrites, so a failed update can be
// rolled back to a working install instead of leaving the plugin uninstalled.
function backupProfile() {
  const profile = profileDir();
  const backup = path.join(profile, ".ponytail-backup");
  fs.rmSync(backup, { recursive: true, force: true });
  fs.mkdirSync(backup, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const src = path.join(profile, file);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(backup, file));
  }
  const inst = installedDir();
  if (fs.existsSync(inst)) fs.cpSync(inst, path.join(backup, "installed"), { recursive: true });
  return backup;
}

function restoreProfile(backup) {
  const profile = profileDir();
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const src = path.join(backup, file);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(profile, file), { force: true });
  }
  const inst = installedDir();
  const saved = path.join(backup, "installed");
  if (fs.existsSync(saved)) {
    fs.rmSync(inst, { recursive: true, force: true });
    fs.cpSync(saved, inst, { recursive: true });
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

// Reinstall a git/npm-installed plugin from its own dependency spec: this is
// how such an install picks up a newer commit. Backed up first and rolled back
// on any failure, so a broken network never leaves the plugin uninstalled.
async function reinstallFromSpec(spec, steps) {
  const profile = profileDir();
  const backup = backupProfile();
  try {
    const removed = await runPnpm(["remove", "dsh-ponytail"], profile, 60000);
    steps.push({ name: "pnpm remove dsh-ponytail", code: removed.code, output: (removed.stdout + removed.stderr).trim().slice(-2000) });
    if (removed.code !== 0) throw new Error("pnpm remove dsh-ponytail failed");

    const added = await runPnpm(["add", spec], profile, 240000);
    steps.push({ name: `pnpm add ${spec}`, code: added.code, output: (added.stdout + added.stderr).trim().slice(-2000) });
    if (added.code !== 0) throw new Error(added.timedOut ? `pnpm add ${spec} 超时（从 GitHub 拉取过慢或网络不通）` : `pnpm add ${spec} failed`);
    if (!fs.existsSync(path.join(installedDir(), "package.json"))) throw new Error("installed copy missing after reinstall");

    fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    restoreProfile(backup);
    steps.push({ name: "rollback", code: 0, output: `已恢复原安装 / restored previous install: ${errorMessage(error)}` });
    return { ok: false, error: errorMessage(error) };
  }
}

// `pnpm install` does NOT refresh a `file:` dependency whose version did not
// change (it reports "Already up to date"), so it cannot propagate the new
// skills. Instead we mirror the package whitelist into the installed copy and
// swap it in atomically. shortcut: this assumes the profile uses a real copy
// (file:), never a `link:` symlink; for link: the source IS the installed dir.
function refreshInstalled(sourceDir, installedDir) {
  const RUNTIME_FILES = ["index.js", "client.js", "cordis.patch.yml", "package.json", "README.md", "LICENSE"];
  const skillsSrc = path.join(sourceDir, "skills");
  if (!fs.existsSync(skillsSrc)) throw new Error(`source has no skills/ directory: ${sourceDir}`);

  const stage = `${installedDir}.syncing`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const file of RUNTIME_FILES) {
    const from = path.join(sourceDir, file);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, file));
  }
  fs.cpSync(skillsSrc, path.join(stage, "skills"), { recursive: true });

  const old = `${installedDir}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(installedDir)) fs.renameSync(installedDir, old);
  fs.renameSync(stage, installedDir);
  fs.rmSync(old, { recursive: true, force: true });
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isSameOriginMutation(req) {
  const origin = req.headers.origin;
  const secFetchSite = req.headers["sec-fetch-site"];
  // The desktop web UI runs under the Electron custom scheme (dsh-app://), so
  // its POSTs carry that Origin and never a loopback http one. The socket is
  // already known to be loopback before this is called.
  if (typeof origin === "string" && /^dsh-app:\/\//i.test(origin)) return true;
  // Browsers set this header themselves and a cross-site page gets
  // "cross-site", so "same-origin" cannot be forged by a remote page.
  if (secFetchSite === "same-origin") return true;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (typeof origin === "string") {
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host && loopbackHost;
    } catch {
      return false;
    }
  }
  return loopbackHost;
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const SECTION_ORDER = 15000;

export function apply(ctx) {
  const state = loadState();
  const defaultMode = readDefaultMode();

  function sessionRecord(sessionId) {
    if (!sessionId) return undefined;
    return state.sessions[sessionId];
  }

  function modeForSession(sessionId) {
    const record = sessionRecord(sessionId);
    if (record && normalizeMode(record.mode)) return normalizeMode(record.mode);
    return defaultMode;
  }

  function setMode(sessionId, mode) {
    if (!sessionId) return;
    const normalized = normalizeMode(mode);
    if (!normalized) return;
    state.sessions[sessionId] = { mode: normalized, updatedAt: new Date().toISOString() };
    saveState(state);
  }

  // 1. Skills -------------------------------------------------------------
  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(scanSkills()),
    async get(candidate) {
      const wanted = (candidate && candidate.name) || candidate;
      const found = scanSkills().find((entry) => entry.name === wanted);
      const skillName = found ? found.name : wanted;
      const dir = path.join(SKILLS_DIR, skillName);
      const file = path.join(dir, "SKILL.md");
      const raw = fs.readFileSync(file, "utf8");
      const { frontmatter, body } = stripFrontmatter(raw);
      const meta = parseFrontmatter(frontmatter);
      return {
        name: skillName,
        description: (meta.description || "").trim() || `The ${skillName} skill.`,
        source: "bundled",
        provider: PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: "directory", path: dir },
        path: file,
        content: body,
      };
    },
  };
  ctx.skills.registerProvider(() => provider);

  // 2. Always-on ruleset --------------------------------------------------
  ctx.systemPrompt.section({
    name: "ponytail:ruleset",
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      const sessionId = context && context.agent && context.agent.session
        ? context.agent.session.id
        : undefined;
      const mode = modeForSession(sessionId);
      return getPonytailInstructions(mode);
    },
  });

  // 3. /ponytail command --------------------------------------------------
  ctx.commands.register({
    name: "ponytail",
    description: "Set ponytail intensity for this session: lite, full, ultra, or off.",
    input: { hint: "[lite|full|ultra|off]" },
    recordInput: false,
    handler: ({ agent, rawInput } = {}) => {
      const arg = typeof rawInput === "string" ? rawInput.trim().toLowerCase() : "";
      const sessionId = agent && agent.session ? agent.session.id : undefined;

      if (arg === "") {
        setMode(sessionId, "full");
        return { kind: "success", text: "Ponytail mode: full." };
      }
      if (arg === "off" || arg === "stop" || arg === "normal" || arg === "stop ponytail" || arg === "normal mode") {
        setMode(sessionId, "off");
        return { kind: "success", text: "Ponytail mode: off." };
      }
      const mode = normalizeMode(arg);
      if (!mode) {
        // `/ponytail <question>` is not a mode: answer it in the chat like the
        // other skill commands, without changing the level.
        const question = typeof rawInput === "string" ? rawInput.trim() : "";
        if (question && startQuestionTurn(agent, question, createUserMessage)) {
          return { kind: "success" };
        }
        try {
          return { kind: "success", text: getSkillBody("ponytail") };
        } catch (error) {
          return { kind: "error", text: `Could not read the ponytail skill: ${error.message}` };
        }
      }
      setMode(sessionId, mode);
      return { kind: "success", text: `Ponytail mode: ${mode}.` };
    },
  });

  // 3b. Skill commands ----------------------------------------------------
  // The one-shot cards can be shown directly; the working skills need a model
  // turn, so they hand the model a user message via `agent.followup`.
  function registerCardCommand(commandName, skillName) {
    ctx.commands.register({
      name: commandName,
      description: `Show the ${skillName} card.`,
      handler: () => {
        try {
          return { kind: "success", text: getSkillBody(skillName) };
        } catch (error) {
          return { kind: "error", text: `Could not read the ${skillName} skill: ${error.message}` };
        }
      },
    });
  }

  function registerSkillCommand(commandName, skillName, kickoff) {
    ctx.commands.register({
      name: commandName,
      description: `Run the ${skillName} skill on the current work.`,
      handler: ({ agent } = {}) => {
        if (!createUserMessage || !agent || typeof agent.followup !== "function") {
          return {
            kind: "error",
            text: `This host cannot start a model turn from a command; ask the model to use the ${skillName} skill instead.`,
          };
        }
        try {
          agent.followup(createUserMessage({
            content: [{ type: "text", text: kickoff }],
            source: { kind: "user" },
          }));
          return { kind: "success", text: `Running ${skillName}…` };
        } catch (error) {
          return { kind: "error", text: `Could not start ${skillName}: ${error.message}` };
        }
      },
    });
  }

  registerSkillCommand("ponytail-review", "ponytail-review",
    "Use the `ponytail-review` skill to review the current changes.");
  registerSkillCommand("ponytail-audit", "ponytail-audit",
    "Use the `ponytail-audit` skill to audit this repository.");
  registerSkillCommand("ponytail-debt", "ponytail-debt",
    "Use the `ponytail-debt` skill to produce the shortcut debt ledger.");
  registerCardCommand("ponytail-help", "ponytail-help");
  registerCardCommand("ponytail-gain", "ponytail-gain");

  // 4. Natural-language deactivation --------------------------------------
  // `messages` is the batch entering this step, so a standalone "stop
  // ponytail" / "normal mode" flips the mode off for this session. Assembly
  // runs before this hook, so the change applies from the next step.
  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();
    if (!decision || decision.kind === "reject") return decision;
    const sessionId = agent && agent.session ? agent.session.id : undefined;
    if (!sessionId) return decision;
    for (const message of messages || []) {
      if (!message || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block && block.type === "text" && isDeactivationCommand(block.text)) {
          setMode(sessionId, "off");
          return decision;
        }
      }
    }
    return decision;
  });

  // 5. Sync-from-upstream web routes (the client half is ./client.js) -------
  const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  if (webServer && typeof webServer.register === "function") {
    const mount = (fn, label) => (typeof ctx.effect === "function" ? ctx.effect(fn, label) : fn());
    try {
      mount(() => webServer.register({
        kind: "exact",
        path: "/dsh-ponytail/status",
        async handler(req, res) {
          if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
            return sendJson(res, 403, { error: "loopback connections only" });
          }
          if (req.method !== "GET") {
            res.setHeader("allow", "GET");
            return sendJson(res, 405, { error: "method not allowed" });
          }
          try {
            const snapshot = syncSnapshot();
            const skipLatest = req.headers && req.headers["x-ponytail-latest"] === "0";
            if (!skipLatest) Object.assign(snapshot, await latestInfo(snapshot.installedVersion));
            return sendJson(res, 200, snapshot);
          } catch (error) {
            return sendJson(res, 500, { error: errorMessage(error) });
          }
        },
      }), "dsh-ponytail: status route");

      mount(() => webServer.register({
        kind: "exact",
        path: "/dsh-ponytail/sync",
        async handler(req, res) {
          if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
            return sendJson(res, 403, { error: "loopback connections only" });
          }
          if (req.method !== "POST") {
            res.setHeader("allow", "POST");
            return sendJson(res, 405, { error: "method not allowed" });
          }
          if (!isSameOriginMutation(req)) {
            return sendJson(res, 403, { error: "sync requires a same-origin browser request" });
          }
          const steps = [];
          try {
            let sourceDir = resolveSourceDir();
            const spec = installSpec();
            const isLocalSpec = Boolean(spec && (spec.startsWith("file:") || spec.startsWith("link:")));

            // git/npm install: materialize/refresh a checkout under DSH_HOME so
            // the source no longer depends on an external directory, sync the
            // upstream skills, then switch the install to that local checkout.
            if (!isLocalSpec && spec) {
              const dir = defaultPluginDir();
              const prov = await ensureSourceRepo(dir, steps);
              if (!prov.ok) {
                const result = await reinstallFromSpec(spec, steps);
                if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error, steps, ...syncSnapshot() });
                return sendJson(res, 200, { ok: true, mode: "reinstall", steps, ...syncSnapshot() });
              }
              const node = resolveBundledNode();
              const script = path.join(dir, "scripts", "sync-upstream.mjs");
              if (fs.existsSync(script)) {
                const s = await runNode(node, [script], dir, { timeoutMs: 180000 });
                steps.push({ name: "sync-upstream", code: s.code, output: (s.stdout + s.stderr).trim().slice(-4000) });
                if (s.code !== 0) return sendJson(res, 500, { ok: false, error: "sync-upstream failed", steps, ...syncSnapshot() });
              }
              if (!resolvePnpmCjs()) return sendJson(res, 500, { ok: false, error: "pnpm 运行时未找到。", steps, ...syncSnapshot() });
              const added = await runPnpm(["add", `file:${dir.replace(/\\/g, "/")}`], profileDir(), 240000);
              steps.push({ name: `pnpm add file:${dir}`, code: added.code, output: (added.stdout + added.stderr).trim().slice(-2000) });
              if (added.code !== 0) return sendJson(res, 500, { ok: false, error: "切换本地源码安装失败", steps, ...syncSnapshot() });
              nudgeReload();
              return sendJson(res, 200, { ok: true, mode: "clone", steps, ...syncSnapshot() });
            }

            if (!sourceDir) {
              return sendJson(res, 400, { ok: false, error: `此插件从 ${spec || "git/npm"} 安装，没有本地源码目录，无法同步。`, steps, ...syncSnapshot() });
            }

            // Local checkout: pull new plugin commits first, then upstream skills.
            if (path.resolve(sourceDir) === path.resolve(defaultPluginDir())) await ensureSourceRepo(sourceDir, steps);

            const node = resolveBundledNode();
            const script = path.join(sourceDir, "scripts", "sync-upstream.mjs");
            if (!fs.existsSync(script)) throw new Error(`sync script not found: ${script}`);

            const synced = await runNode(node, [script], sourceDir, { timeoutMs: 180000 });
            steps.push({ name: "sync-upstream", code: synced.code, output: (synced.stdout + synced.stderr).trim().slice(-4000) });
            if (synced.code !== 0) {
              return sendJson(res, 500, { ok: false, error: "sync-upstream failed", steps, ...syncSnapshot() });
            }

            const installed = installedDir();
            try {
              refreshInstalled(sourceDir, installed);
              steps.push({ name: "refresh installed copy", code: 0, output: `copied skills/ + runtime files into ${installed}` });
            } catch (copyError) {
              steps.push({ name: "refresh installed copy", code: 1, output: errorMessage(copyError) });
              return sendJson(res, 500, { ok: false, error: "refresh installed copy failed", steps, ...syncSnapshot() });
            }
            nudgeReload();
            return sendJson(res, 200, { ok: true, mode: "local", steps, ...syncSnapshot() });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: errorMessage(error), steps });
          }
        },
      }), "dsh-ponytail: sync route");
    } catch {
      /* routes already registered, or this host rejects the register call */
    }
  }

  // Removing this plugin should also drop the source checkout it cloned into
  // DSH_HOME; a disable/unload keeps it (package.json still lists us).
  const scheduleCleanup = () => scheduleSourceCleanup();
  if (typeof ctx.effect === "function") ctx.effect(() => () => scheduleCleanup(), "dsh-ponytail: source cleanup");
  else if (typeof ctx.on === "function") ctx.on("dispose", scheduleCleanup);
}

// Exposed for the cleanup/source self-tests only; not part of the plugin API.
export { dependsOnSelf, removeSourceClone, ensureSourceRepo, cleanupWorkerCode };

