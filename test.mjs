// Standalone smoke test for dsh-ponytail. Runs the plugin against a mock ctx,
// so it verifies wiring without a DSH install.  Run: node test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ponytail-test-"));
process.env.DSH_PROFILE_DIR = tmp;
delete process.env.PONYTAIL_DEFAULT_MODE;

const mod = await import("./index.js");

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---- mock ctx ------------------------------------------------------------
let provider, section, preStep;
const commands = {};
const ctx = {
  skills: { registerProvider: (fn) => { provider = fn(); } },
  systemPrompt: { section: (def) => { section = def; } },
  commands: { register: (def) => { commands[def.name] = def; } },
  on: (event, handler) => { if (event === "agent/pre-step") preStep = handler; },
};

mod.apply(ctx);
const command = commands["ponytail"];

// ---- metadata ------------------------------------------------------------
console.log("metadata");
check("name is dsh-ponytail", mod.name === "dsh-ponytail");
check("inject lists the four services", JSON.stringify(mod.inject) === JSON.stringify(["skills", "systemPrompt", "commands", "webServer"]));

// ---- skills --------------------------------------------------------------
console.log("skills");
const list = await provider.list();
check("provider lists six skills", list.length === 6, `got ${list.length}: ${list.map((s) => s.name).join(", ")}`);
const names = new Set(list.map((s) => s.name));
for (const want of ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"]) {
  check(`candidate ${want} present`, names.has(want));
}
const pony = list.find((s) => s.name === "ponytail");
check("candidate has invocation flags", pony?.invocation?.modelInvocable === true && pony?.invocation?.userInvocable === true);
check("candidate has resourceBase directory", pony?.resourceBase?.kind === "directory" && fs.existsSync(pony.resourceBase.path));
check("candidate rank is a number", typeof pony?.rank === "number");
check("candidate description parsed from folded YAML", typeof pony?.description === "string" && pony.description.length > 20 && !pony.description.startsWith(">"), pony?.description?.slice(0, 40));

const def = await provider.get({ name: "ponytail-review" });
check("get() returns content", typeof def.content === "string" && def.content.length > 100);
check("get() content has frontmatter stripped", !def.content.startsWith("---"));

// ---- commands ------------------------------------------------------------
console.log("commands");
for (const cmd of ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"]) {
  check(`command ${cmd} registered`, typeof commands[cmd]?.handler === "function");
}
const helpCard = commands["ponytail-help"].handler();
check("ponytail-help returns the card text", helpCard.kind === "success" && helpCard.text.includes("Ponytail Help"));
const reviewCmd = commands["ponytail-review"].handler({ agent: { session: { id: "s-r" } } });
check("ponytail-review without followup returns error (mock)", reviewCmd.kind === "error");
let steered;
const started = mod.startQuestionTurn({ steer: (m) => { steered = m; } }, "what is ponytail", (input) => input);
check("question starts a model turn", started === true && steered.content[0].text === "what is ponytail" && steered.source.kind === "user");
check("question turn needs steer()", mod.startQuestionTurn({}, "q", (input) => input) === false);

// ---- system prompt / levels ---------------------------------------------
console.log("system prompt");
const ctxFor = (sid) => ({ agent: { session: { id: sid } } });
check("section name/order/interpolate", section.name === "ponytail:ruleset" && section.order === 15000 && section.interpolate === false);

const full = section.text(ctxFor("s-full"));
check("default mode full injects ruleset", full.includes("PONYTAIL MODE ACTIVE — level: full"));
check("full keeps the full level row", full.includes("**full**"));
check("full drops the lite level row", !full.includes("| **lite** |"));
check("full keeps ladder rules", full.includes("Does it need to exist?"));

const textFor = (sid) => section.text(ctxFor(sid));

command.handler({ agent: { session: { id: "s-lite" } }, rawInput: "lite" });
check("command sets lite", textFor("s-lite").includes("level: lite"));
check("lite keeps the lite level row", textFor("s-lite").includes("**lite**"));
check("lite drops the full level row", !textFor("s-lite").includes("| **full** |"));

command.handler({ agent: { session: { id: "s-lite" } }, rawInput: "ultra" });
check("command switches ultra", textFor("s-lite").includes("level: ultra"));

command.handler({ agent: { session: { id: "s-lite" } }, rawInput: "off" });
check("command off yields empty section", textFor("s-lite") === "");

command.handler({ agent: { session: { id: "s-bad" } }, rawInput: "lite" });
const bad = command.handler({ agent: { session: { id: "s-bad" } }, rawInput: "banana" });
check("unknown input keeps mode without error", bad.kind === "success" && textFor("s-bad").includes("level: lite"));
check("unknown input shows the skill card", String(bad.text).includes("lazy senior developer"));

command.handler({ agent: { session: { id: "s-bare" } }, rawInput: "" });
check("bare /ponytail activates full", textFor("s-bare").includes("level: full"));

// ---- deactivation via pre-step ------------------------------------------
console.log("deactivation");
const enterAll = async (messages) => preStep({ agent: { session: { id: "s-stop" } }, messages }, async () => ({ kind: "enter", messages }));
command.handler({ agent: { session: { id: "s-stop" } }, rawInput: "full" });
check("s-stop starts full", textFor("s-stop").includes("level: full"));
await enterAll([{ role: "user", content: [{ type: "text", text: "Stop ponytail!" }] }]);
check("'Stop ponytail!' turns it off", textFor("s-stop") === "");

command.handler({ agent: { session: { id: "s-stop" } }, rawInput: "full" });
await enterAll([{ role: "user", content: [{ type: "text", text: "normal mode" }] }]);
check("'normal mode' turns it off", textFor("s-stop") === "");

command.handler({ agent: { session: { id: "s-stop2" } }, rawInput: "full" });
await enterAll([{ role: "user", content: [{ type: "text", text: "please stop ponytail and also fix the bug" }] }]);
check("mid-sentence phrase does not deactivate", textFor("s-stop2").includes("level: full"));

// ---- state persistence ---------------------------------------------------
console.log("persistence");
const statePath = path.join(tmp, "ponytail", "session-states.json");
check("state file written", fs.existsSync(statePath));
const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
check("saved lite mode for s-lite", saved.sessions?.["s-lite"]?.mode === "ultra" || saved.sessions?.["s-lite"]?.mode === "off", JSON.stringify(saved.sessions?.["s-lite"]));

// ---- done ----------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
