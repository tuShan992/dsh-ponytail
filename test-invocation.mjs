// Verifies the /ponytail invocation path end to end, without a DSH install:
//   command keeps `/ponytail` in the started turn -> host gesture scanner sees
//   it -> the ponytail skill body exists to be injected. Run: node test-invocation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ponytail-invocation-"));
process.env.DSH_PROFILE_DIR = tmp;

const mod = await import("./index.js");

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// Exact copy of the host's gesture rule (@deepseek-ai/dsh-tool-skill).
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
function invokedSkillNames(messages) {
  const names = [];
  for (const message of messages) {
    if (message.source?.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        if (match[2] !== undefined && !names.includes(match[2])) names.push(match[2]);
      }
    }
  }
  return names;
}

// ---- skill bodies exist for every ponytail-* skill ------------------------
let provider;
mod.apply({
  skills: { registerProvider: (fn) => { provider = fn(); } },
  systemPrompt: { section: () => {} },
  commands: { register: () => {} },
  on: () => {},
});
const skills = await provider.list();
console.log("skills");
for (const name of ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"]) {
  const def = await provider.get({ name });
  check(`${name} body is non-empty`, typeof def?.content === "string" && def.content.length > 100);
}

// ---- the command turn keeps the gesture ----------------------------------
console.log("invocation");
const question = "帮我优化这个项目";
let steered;
const started = mod.startQuestionTurn(
  { steer: (m) => { steered = m; } },
  `/ponytail ${question}`,
  (input) => ({ role: "user", ...input }),
);
check("startQuestionTurn steers", started === true);
check("steered message keeps /ponytail", steered?.content?.[0]?.text === `/ponytail ${question}`);
check("steered message is user input", steered?.source?.kind === "user");
check("host scanner sees ponytail", invokedSkillNames([steered]).includes("ponytail"));

// ---- the other working skills are detectable too -------------------------
for (const name of ["ponytail-review", "ponytail-audit", "ponytail-debt"]) {
  const msg = { source: { kind: "user" }, content: [{ type: "text", text: `/${name} 当前改动` }] };
  check(`host scanner sees ${name}`, invokedSkillNames([msg]).includes(name));
}

// ---- no false positives ---------------------------------------------------
check("path /usr/bin is not a gesture", invokedSkillNames([{ source: { kind: "user" }, content: [{ type: "text", text: "/usr/bin/node" }] }]).length === 0);
check("fraction 5/8 is not a gesture", invokedSkillNames([{ source: { kind: "user" }, content: [{ type: "text", text: "5/8" }] }]).length === 0);

// ---- ponytail content carries the behavior marker -------------------------
const pony = await provider.get({ name: "ponytail" });
check("ponytail body carries the lazy rule", /lazy senior developer/i.test(pony.content));
check("ponytail body carries the closing risk line", /what you skipped/i.test(pony.content));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
