import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crewExtension, {
  buildRolePrompt,
  appendMarkerInstruction,
  buildCrewMarkers,
  buildRoleCommand,
  resolveQueueKey,
  runCrewPollingLoop,
  classifyDelegationResult,
  getOrCorroborateAgent,
  PROMPT_START_GRACE_MS,
  REUSED_IDLE_GRACE_MS,
  chooseSplitTarget,
  chooseAgentName,
  compactRoleOutput,
  configCandidates,
  modelTiersCandidates,
  loadModelTiers,
  resolveModelTier,
  resolveParallelReviewAgent,
  assertValidTierName,
  type ModelTiers,
  buildHandoff,
  selectHandoffEntries,
  serializeSessionEntries,
  findCheckpoint,
  findCurrentCrewLaunch,
  userBoundaryIndex,
  visibleMessageText,
  type SessionEntryLike,
  type ContextMode,
  type CheckpointFallback,
  extractMarkerOutput,
  updateMarkerOutput,
  findReusableRolePane,
  findReusableRolePaneInList,
  parseCrewConfig,
  resolveRole,
  selectLaunchCommand,
  scopedRoleName,
  normalizeTask,
  parseModelCatalog,
  modelMatch,
  classifyAgentStatus,
  functionalPreflight,
  isStartupBlockedOutput,
  prepareDurableLaunch,
  rememberOwnerAccess,
  resolveArtifactAccess,
  executeCrewLaunch,
  executeReadContext,
  redactCapabilitySecrets,
} from "./index.ts";
import {
  acknowledgeInbox,
  appendPublicationChunk,
  beginPublication,
  beginTaskReview,
  completeTaskReview,
  acquireWriterOwnership,
  discardCorruptArtifact,
  disposeTaskEvidence,
  markWriterRunning,
  recoverTaskAttempt,
  createRunState,
  createTaskAttempt,
  createTaskCapability,
  finalizePublication,
  readArtifact,
  readInbox,
  readTaskAttempt,
  resolveRepositoryIdentity,
  submitTaskAttempt,
  transitionTaskAttempt,
  MAX_SERIALIZED_PAGE_BYTES,
  createPhaseCheckpoint,
  finalizeArtifactCleanup,
  previewArtifactCleanup,
  publishPhaseContract,
  readCurrentPhase,
  readPhaseCheckpoint,
  readPlanIndex,
  writePlanIndex,
} from "./state.ts";
import { assessPayload, captureSourceSnapshot, contextWarningLevel, normalizeUsage } from "./workflow.ts";

test("unresolved delegation references are rejected conservatively", () => {
  assert.throws(() => normalizeTask("implement it"), /incomplete/i);
  assert.throws(() => normalizeTask("implement the plan above"), /incomplete/i);
  assert.throws(() => normalizeTask("fix it in auth.ts"), /incomplete/i);
  assert.doesNotThrow(() => normalizeTask("Review the authentication parser and report whether it handles expired tokens."));
  assert.doesNotThrow(() => normalizeTask("Review that", { context: "Assess the concrete Alpha Vantage and Trade212 API proposal, including command shape and failure handling." }));
  assert.doesNotThrow(() => normalizeTask("Review the previous API research and report implementation risks."));
});

test("model catalog requires exact IDs", () => {
  const catalog = parseModelCatalog("Provider          Model                 Context\nopenai-codex     gpt-5.6-luna          114k\nremote-ds4       deepseek-v4-flash     32k\nremote-ollama    qwen3.8:27b-mlx       32k");
  assert.deepEqual(catalog, ["openai-codex/gpt-5.6-luna", "remote-ds4/deepseek-v4-flash", "remote-ollama/qwen3.8:27b-mlx"]);
  assert.equal(modelMatch("openai-codex/gpt-5.6-luna", catalog), "exact");
  assert.equal(modelMatch("ds4-flash", catalog), "fuzzy");
  assert.equal(modelMatch("GML-5.3-flash", catalog), "none");
});

test("blocked and timeout statuses are not completion", () => {
  assert.equal(classifyAgentStatus("blocked"), "blocked");
  assert.equal(classifyAgentStatus("timed_out"), "timed_out");
  assert.equal(classifyAgentStatus("working"), "working");
});

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("selectLaunchCommand uses pi by default", () => {
  assert.equal(selectLaunchCommand({}), "pi");
});

test("selectLaunchCommand uses pic-proxy for bridge env", () => {
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE: "1" }), "pic-proxy");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE_HOST: "127.0.0.1" }), "pic-proxy");
});

test("role bootstrap approves the project before selecting the model and enforces read-only tools", () => {
  assert.equal(buildRoleCommand("pi", "provider/model"), "pi --approve --model provider/model");
  assert.equal(buildRoleCommand("pic-proxy", "provider/model"), "pic-proxy --approve --model provider/model");
  assert.equal(buildRoleCommand("pi"), "pi --approve");
  assert.equal(buildRoleCommand("pi", "provider/model", "read-only"), "pi --approve --tools read,grep,find,ls,crew_publish,crew_read,crew_read_context --model provider/model");
  assert.equal(buildRoleCommand("pi", undefined, "read-only"), "pi --approve --tools read,grep,find,ls,crew_publish,crew_read,crew_read_context");
  assert.equal(buildRoleCommand("pi", "provider/model", "can-edit"), "pi --approve --model provider/model");
  assert.equal(buildRoleCommand("pi", undefined, "can-edit", "/tmp/custom crew-state"), "env CREW_STATE_ROOT='/tmp/custom crew-state' pi --approve");
  assert.equal(buildRoleCommand("pi", undefined, "can-edit", "/tmp/$unsafe'root"), "env CREW_STATE_ROOT='/tmp/$unsafe'\"'\"'root' pi --approve");
});

test("durable mode is explicit and documents API-only authorization guardrails", () => {
  const tools: any[] = [];
  crewExtension({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), registerTool(tool) { tools.push(tool); } });
  const launch = tools.find(tool => tool.name === "crew_launch");
  const publish = tools.find(tool => tool.name === "crew_publish");
  const read = tools.find(tool => tool.name === "crew_read");
  assert.equal(launch.parameters.properties.durable.type, "boolean");
  assert.equal(launch.parameters.required.includes("durable"), false);
  assert.equal(publish.parameters.required.includes("token"), false);
  assert.equal(read.parameters.required.includes("token"), false);
  assert.equal(read.parameters.required.includes("artifactId"), false);
  assert.deepEqual(read.parameters.properties.action.enum, ["artifact", "inbox", "acknowledge", "recover-evidence"]);
  assert.deepEqual(publish.parameters.properties.verdict.enum, ["PASS", "REVISION_NEEDED", "BLOCKED"]);
  assert.match(publish.description, /API-level|filesystem confidentiality/);
  assert.match(read.description, /same-user filesystem confidentiality/);
  assert.doesNotMatch(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), /ownerCapabilityToken/);
});

test("resolveQueueKey derives authority from resolved config so overrides serialize as writers", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "crew-queue-test-"));
  try {
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "model-tiers.json"),
      JSON.stringify({ crewRoles: { scout: { authority: "can-edit" } } })
    );

    const scoutDetails = resolveQueueKey("scout", tempDir);
    assert.equal(scoutDetails.authority, "can-edit");
    assert.ok(scoutDetails.key.startsWith("writer:"));

    const reviewerDetails = resolveQueueKey("reviewer", tempDir);
    assert.equal(reviewerDetails.authority, "read-only");
    assert.ok(reviewerDetails.key.startsWith("readonly:"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("role config parsing and defaults preserve configured fields", () => {
  const config = parseCrewConfig(JSON.stringify({
    roles: {
      scout: { description: "Custom scout", model: "provider/model", authority: "read-only" },
    },
  }));
  const role = resolveRole("scout", config);
  assert.deepEqual(role, {
    name: "scout",
    description: "Custom scout",
    model: "provider/model",
    authority: "read-only",
  });
  const prompt = buildRolePrompt("scout", role, "map files", "/repo", { context: "source tree" });
  assert.match(prompt, /You are scout\. Custom scout Authority: read-only\. Task: map files/);
  assert.match(prompt, /## Working directory[\s\S]*\/repo/);
  assert.match(prompt, /## Context[\s\S]*source tree/);
});

test("compactRoleOutput keeps output after the last prompt without extra truncation", () => {
  const prompt = "You are scout. Task: say hello";
  const tail = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const output = `pi --model x\nstartup noise\n${prompt}\nThinking\nHello.\n${prompt}\n${tail}`;
  assert.equal(compactRoleOutput(output, prompt), tail);
  assert.equal(compactRoleOutput(output, prompt, 2), "line 59\nline 60");
});

test("marker helpers extract only the final answer between marker pair", () => {
  const markers = buildCrewMarkers("call:a/b");
  assert.match(markers.start, /^CREW_RESULT_START_/);
  assert.match(markers.end, /^CREW_RESULT_END_/);
  const prompt = appendMarkerInstruction("You are scout. Task: say hello", markers);
  assert.match(prompt, new RegExp(markers.start));
  assert.match(prompt, new RegExp(markers.end));
  const output = `startup\n${markers.start}\nold answer\n${markers.end}\nnoise\n${markers.start}\nFinal answer\nline 2\n${markers.end}\nfooter noise`;
  assert.deepEqual(extractMarkerOutput(output, markers), { text: "Final answer\nline 2", mode: "marker-pair" });
  assert.deepEqual(extractMarkerOutput(`${markers.start}\nFinal answer\nfooter`, markers), { text: "Final answer\nfooter", mode: "marker-start" });
  assert.deepEqual(extractMarkerOutput("missing", markers), { text: "", mode: "missing" });
});

test("marker capture survives the start marker scrolling out of later snapshots", () => {
  const markers = buildCrewMarkers("scrolled-marker");
  let capture = extractMarkerOutput("", markers);
  capture = updateMarkerOutput(capture, `${markers.start}\nline 1\nline 2`, markers);
  capture = updateMarkerOutput(capture, `line 2\nline 3\n${markers.end}\nfooter`, markers);
  assert.deepEqual(capture, { text: "line 1\nline 2\nline 3", mode: "marker-pair" });
});

test("marker stitching rejects non-overlapping snapshots and flags extraction as unreliable", () => {
  const markers = buildCrewMarkers("gap-marker");
  let capture = extractMarkerOutput("", markers);
  capture = updateMarkerOutput(capture, `${markers.start}\nline 1\nline 2`, markers);
  capture = updateMarkerOutput(capture, `unrelated content A\nunrelated content B\n${markers.end}\nfooter`, markers);
  assert.equal(capture.mode, "unreliable");
  assert.equal(capture.text, "line 1\nline 2");
  assert.doesNotMatch(capture.text, /unrelated/);
  assert.ok(capture.warning?.includes("Discontinuity"));
});

test("marker text embedded in the echoed prompt is not treated as role output", () => {
  const markers = buildCrewMarkers("embedded-marker");
  const echoedPrompt = `For your final answer, print ${markers.start} on its own line, then your answer, then ${markers.end} on its own line.`;
  assert.deepEqual(extractMarkerOutput(echoedPrompt, markers), { text: "", mode: "missing" });
});

test("interactive trust prompts are treated as blocked startup", () => {
  assert.equal(isStartupBlockedOutput("Trust project folder?\n→ Trust"), true);
  assert.equal(isStartupBlockedOutput("Pi can explain its own features."), false);
});

test("scoped role names preserve uppercase workspace characters without doubled separators", () => {
  assert.equal(scopedRoleName("scout", "wA", "wA:t1"), "scout-wa-t1");
});

test("role defaults supply built-in description and authority", () => {
  const role = resolveRole("executor", {});
  assert.equal(role.name, "executor");
  assert.equal(role.authority, "can-edit");
  assert.match(role.description ?? "", /Implements the approved plan/);
  assert.equal(role.model, undefined);
});

test("unknown roles are rejected", () => {
  assert.throws(() => resolveRole("invented", {}), /Unknown crew role/);
});

test("invalid configured authority and model are rejected", () => {
  assert.throws(() => resolveRole("scout", { roles: { scout: { authority: "write-all" as never } } }), /Invalid authority/);
  assert.throws(() => resolveRole("scout", { roles: { scout: { model: "bad/model with space" } } }), /Invalid model/);
});

test("role names must be Herdr-compatible", () => {
  assert.throws(() => resolveRole("Scout", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("1scout", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("scout.with.dot", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("a".repeat(33), {}), /Herdr agent names/);
});

test("config candidates prefer project config before global config", () => {
  assert.deepEqual(modelTiersCandidates("/repo", "/home/me"), [
    "/repo/.pi/model-tiers.json",
    "/repo/.pi/skills/crew/model-tiers.json",
    "/repo/skills/crew/model-tiers.json",
    "/.pi/model-tiers.json",
    "/home/me/.pi/agent/skills/crew/model-tiers.json",
    "/home/me/.pi/model-tiers.json",
  ]);
  assert.deepEqual(configCandidates("/repo", "/home/me"), modelTiersCandidates("/repo", "/home/me"));
});

test("reuse eligibility requires same role, idle or done, workspace, cwd, and pane", () => {
  const agent = { name: "reviewer", pane_id: "pane-1", workspace_id: "ws", foreground_cwd: "/repo", agent_status: "idle" };
  assert.equal(findReusableRolePane(agent, "reviewer", "ws", "/repo"), "pane-1");
  assert.equal(findReusableRolePane({ ...agent, agent_status: undefined, status: "Idle" }, "reviewer", "ws", "/repo"), "pane-1");
  assert.equal(findReusableRolePane({ ...agent, agent_status: "working" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, workspace_id: "other" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, foreground_cwd: "/else" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, name: "scout" }, "reviewer", "ws", "/repo"), undefined);
});

test("reuse lookup finds existing role from agent list", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "ws", cwd: "/repo", agent_status: "idle" },
    { name: "reviewer", pane_id: "pane-reviewer", workspace_id: "ws", cwd: "/repo", agent_status: "idle" },
  ];
  assert.equal(findReusableRolePaneInList(agents, "reviewer", "ws", "/repo"), "pane-reviewer");
});


test("agent naming scopes to workspace and tab when base role exists elsewhere", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
});

test("agent naming keeps base role for same tab reuse", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "w5", tab_id: "tab-test", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "tab-test"), "scout");
});

test("agent naming does not reuse an occupied name when its requested model is unknown", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "w5", tab_id: "tab-test", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "tab-test", "provider/model"), "scout-w5-tab-test");
});

test("agent naming reuses scoped same-tab role", () => {
  const agents = [
    { name: "scout-w5-t6", pane_id: "pane-scoped", workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Idle" },
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
});

test("agent naming avoids busy or wrong-cwd scoped collisions", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
    { name: "scout-w5-t6", pane_id: "pane-busy", workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Working" },
    { name: "scout-w5-t6-2", pane_id: "pane-other-cwd", workspace_id: "w5", tab_id: "w5:t6", cwd: "/other", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6-3");
});

test("agent naming keeps scoped names Herdr-compatible and length-safe", () => {
  const agents = [{ name: "averylongcustomrolename-that-exists", pane_id: "p", workspace_id: "other", cwd: "/repo", status: "Idle" }];
  const name = chooseAgentName(agents, "averylongcustomrolename", "workspace-with-long-name", "/repo", "workspace-with-long-name:t123456789");
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(name.length <= 32);
});

test("split decision creates below existing same-cwd crew pane", () => {
  const decision = chooseSplitTarget([
    { name: "scout", pane_id: "pane-scout", workspace_id: "ws", cwd: "/repo" },
  ], "ws", "/repo");
  assert.equal(decision.policy, "below-existing-crew");
  assert.deepEqual(decision.args, ["pane", "split", "pane-scout", "--direction", "down", "--cwd", "/repo", "--no-focus"]);
});

test("split decision recognizes configured custom crew roles", () => {
  const decision = chooseSplitTarget([
    { name: "analyst-ws-t1", pane_id: "pane-analyst", workspace_id: "ws", tab_id: "t1", cwd: "/repo" },
  ], "ws", "/repo", "t1", new Set(["analyst"]));
  assert.equal(decision.policy, "below-existing-crew");
});

test("split decision creates right of current when no crew pane matches", () => {
  const decision = chooseSplitTarget([
    { name: "scout", pane_id: "pane-scout", workspace_id: "other", cwd: "/repo" },
  ], "ws", "/repo");
  assert.equal(decision.policy, "right-of-current");
  assert.deepEqual(decision.args, ["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"]);

  const crossTab = chooseSplitTarget([
    { name: "scout-ws", pane_id: "pane-scout", workspace_id: "ws", tab_id: "other-tab", cwd: "/repo" },
  ], "ws", "/repo", "current-tab");
  assert.equal(crossTab.policy, "right-of-current");
});

async function regressionTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); process.exitCode = 1; throw error; }
}

void regressionTest("functional preflight uses direct Herdr despite login-shell PATH", async () => {
  const oldEnv = process.env.HERDR_ENV;
  const oldPath = process.env.PATH;
  process.env.HERDR_ENV = "1";
  process.env.PATH = "/usr/bin";
  const calls: string[][] = [];
  const result = await functionalPreflight({ exec: async (command, args = []) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: '{"result":{"pane":{"cwd":"/repo"}}}', stderr: "" };
  }, registerTool() {} });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [["herdr", "pane", "current", "--current"]]);
  if (oldEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldEnv;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
});

await regressionTest("polling loop: inactivity timeout fires when output stops changing and status is not working", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-inactivity");
  const result = await runCrewPollingLoop(
    {
      roleName: "scout",
      agentName: "scout-w",
      paneId: "p1",
      markers,
      reusedPane: false,
      submittedAt: virtualTime,
      timeoutMs: 10_000,
      hardCapMs: 50_000,
      readLines: 200,
    },
    {
      getAgent: async () => ({ agent_status: "unknown" }),
      readOutput: async () => "steady output without change",
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );

  assert.equal(result.status, "timed_out");
  const classification = classifyDelegationResult(result.status, result.markerOutput.mode);
  assert.equal(classification.agentContinues, true);
  assert.equal(classification.complete, false);
});

await regressionTest("polling loop: hard cap bounds runtime even when agent keeps reporting working", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-hard-cap");
  let tick = 0;
  const result = await runCrewPollingLoop(
    {
      roleName: "executor",
      agentName: "executor-w",
      paneId: "p1",
      markers,
      reusedPane: false,
      submittedAt: virtualTime,
      timeoutMs: 10_000,
      hardCapMs: 30_000,
      readLines: 200,
    },
    {
      getAgent: async () => ({ agent_status: "working" }),
      readOutput: async () => `progress ${tick++}`,
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );

  assert.equal(result.status, "timed_out");
  assert.equal(result.observedWorking, true);
  const classification = classifyDelegationResult(result.status, result.markerOutput.mode);
  assert.equal(classification.agentContinues, true);
  assert.equal(classification.complete, false);
});

await regressionTest("polling loop: transient agent get failure with agent in list keeps polling", async () => {
  let getCalls = 0;
  const mockPi = {
    async exec(_cmd: string, args: string[]) {
      if (args[0] === "agent" && args[1] === "get") {
        getCalls += 1;
        return { code: 1, stdout: "", stderr: "lookup failed" };
      }
      if (args[0] === "agent" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { agents: [{ name: "scout-w", agent_status: "working" }] } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
  };
  const agent = await getOrCorroborateAgent(mockPi as any, "scout-w");
  assert.ok(agent);
  assert.equal(agent?.name, "scout-w");
  assert.equal(getCalls, 1);
});

await regressionTest("polling loop: corroborated real disappearance reports failed without false done", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-exit");
  const result = await runCrewPollingLoop(
    {
      roleName: "scout",
      agentName: "scout-w",
      paneId: "p1",
      markers,
      reusedPane: false,
      submittedAt: virtualTime,
      timeoutMs: 30_000,
      hardCapMs: 60_000,
      readLines: 200,
    },
    {
      getAgent: async () => undefined,
      // Even if previous output contains markers, disappearance is NOT reported as done
      readOutput: async () => `${markers.start}\nresult\n${markers.end}`,
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );

  assert.equal(result.agentExited, true);
  assert.equal(result.status, "failed");
  const classification = classifyDelegationResult(result.status, result.markerOutput.mode);
  assert.equal(classification.complete, false);
});

await regressionTest("polling loop: reused idle pane does not complete on stale output at 5s and times out at 15s", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-reuse-stale");
  const result = await runCrewPollingLoop(
    {
      roleName: "scout",
      agentName: "scout-w",
      paneId: "p1",
      markers,
      reusedPane: true,
      submittedAt: virtualTime,
      timeoutMs: 60_000,
      hardCapMs: 120_000,
      readLines: 200,
    },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => "stale output from previous run without current markers",
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );

  assert.equal(result.status, "timed_out");
  assert.equal(result.observedWorking, false);
  assert.ok(virtualTime - 1_000_000 >= REUSED_IDLE_GRACE_MS, "must not exit before REUSED_IDLE_GRACE_MS");
  const classification = classifyDelegationResult(result.status, result.markerOutput.mode);
  assert.equal(classification.complete, false);
});

await regressionTest("polling loop: reused idle pane completes when current markers appear", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-reuse-fresh");
  let polled = 0;
  const result = await runCrewPollingLoop(
    {
      roleName: "scout",
      agentName: "scout-w",
      paneId: "p1",
      markers,
      reusedPane: true,
      submittedAt: virtualTime,
      timeoutMs: 60_000,
      hardCapMs: 120_000,
      readLines: 200,
    },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => {
        polled += 1;
        if (polled >= 2) {
          return `${markers.start}\nfresh answer\n${markers.end}`;
        }
        return "warming up";
      },
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );

  assert.equal(result.status, "idle");
  assert.equal(result.markerOutput.mode, "marker-pair");
  assert.equal(result.markerOutput.text, "fresh answer");
  const classification = classifyDelegationResult(result.status, result.markerOutput.mode);
  assert.equal(classification.complete, true);
});

await regressionTest("polling loop: heartbeats increment and emit onUpdate notifications", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("test-heartbeats");
  const heartbeats: number[] = [];
  let polled = 0;
  const result = await runCrewPollingLoop(
    {
      roleName: "scout",
      agentName: "scout-w",
      paneId: "p1",
      markers,
      reusedPane: false,
      submittedAt: virtualTime,
      timeoutMs: 60_000,
      hardCapMs: 120_000,
      readLines: 200,
    },
    {
      getAgent: async () => ({ agent_status: "working" }),
      readOutput: async () => {
        polled += 1;
        if (polled >= 4) {
          return `${markers.start}\ndone\n${markers.end}`;
        }
        return "working...";
      },
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
      onUpdate: (update) => {
        const hb = (update.details as any)?.heartbeat;
        if (typeof hb === "number") heartbeats.push(hb);
      },
    }
  );

  assert.ok(result.heartbeatCount >= 3);
  assert.deepEqual(heartbeats.slice(0, 3), [1, 2, 3]);
});

test("classifyDelegationResult maps statuses and marker modes accurately", () => {
  assert.deepEqual(classifyDelegationResult("done", "marker-pair"), { settled: true, complete: true, agentContinues: false });
  assert.deepEqual(classifyDelegationResult("idle", "marker-pair"), { settled: true, complete: true, agentContinues: false });
  assert.deepEqual(classifyDelegationResult("idle", "marker-start"), { settled: true, complete: false, agentContinues: false });
  assert.deepEqual(classifyDelegationResult("done", "missing"), { settled: true, complete: false, agentContinues: false });
  assert.deepEqual(classifyDelegationResult("working", "marker-pair"), { settled: false, complete: false, agentContinues: true });
  assert.deepEqual(classifyDelegationResult("timed_out", "marker-pair"), { settled: false, complete: false, agentContinues: true });
  assert.deepEqual(classifyDelegationResult("blocked", "missing"), { settled: false, complete: false, agentContinues: true });
  assert.deepEqual(classifyDelegationResult("unknown", "missing"), { settled: false, complete: false, agentContinues: true });
  assert.deepEqual(classifyDelegationResult("failed", "marker-pair"), { settled: false, complete: false, agentContinues: false });
});

await regressionTest("legacy launch preparation does not require Git or writable managed state", async () => {
  const nonGit = mkdtempSync(join(tmpdir(), "crew-legacy-nongit-"));
  const unavailableStateRoot = join(nonGit, "state-is-a-file");
  writeFileSync(unavailableStateRoot, "not a directory");
  try {
    const disabled = await prepareDurableLaunch({
      enabled: false,
      baseCommand: "pi",
      cwd: nonGit,
      role: "scout",
      taskId: "task-legacy",
      ownerSessionId: "session-legacy",
      stateRoot: unavailableStateRoot,
    });
    assert.equal(disabled, undefined);
    await assert.rejects(() => prepareDurableLaunch({
      enabled: true,
      baseCommand: "pi",
      cwd: nonGit,
      role: "scout",
      taskId: "task-managed",
      ownerSessionId: "session-managed",
      stateRoot: unavailableStateRoot,
    }), /Managed durable coordination setup failed.*Git\/state-root access/);
    await assert.rejects(() => prepareDurableLaunch({
      enabled: true,
      baseCommand: "pic-proxy",
      cwd: nonGit,
      role: "scout",
      taskId: "task-proxy",
      ownerSessionId: "session-proxy",
    }), /not supported through pic-proxy.*durable omitted\/false/);
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

await regressionTest("durable artifacts publish atomically, paginate, and verify integrity", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-state-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-state-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const identity = resolveRepositoryIdentity(repo);
    assert.equal(identity.repositoryId.length, 32);
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-test" });
    const token = await createTaskCapability(owner, { role: "executor", taskId: "task-a", attempt: 1 });
    const task = { ...owner, token };
    const publicationId = await beginPublication(task, {
      kind: "report",
      taskId: "task-a",
      attempt: 1,
      contractVersion: "v1",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      requiredSections: ["validation", "risks"],
    });
    await appendPublicationChunk(task, publicationId, 0, "alpha\n");
    await appendPublicationChunk(task, publicationId, 1, "beta\n");
    await assert.rejects(() => appendPublicationChunk(task, publicationId, 1, "replacement"), /EEXIST/);
    const finalized = await finalizePublication(task, publicationId, 2);
    assert.equal(finalized.bytes, 11);
    const first = await readArtifact(task, finalized.artifactId, { limit: 6 });
    assert.equal(first.content, "alpha\n");
    assert.equal(first.complete, false);
    assert.equal(first.nextOffset, 6);
    const second = await readArtifact(task, finalized.artifactId, { offset: first.nextOffset!, limit: 10 });
    assert.equal(second.content, "beta\n");
    assert.equal(second.complete, true);
    assert.equal(second.sha256, finalized.sha256);
    await assert.rejects(() => appendPublicationChunk(task, publicationId, 2, "late"), /ENOENT/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("task capabilities cannot impersonate roles or cross task boundaries", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-auth-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-auth-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-auth" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-a", attempt: 1 }) };
    const reviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "task-a", attempt: 1 }) };
    const crossTaskReviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "task-b", attempt: 1 }) };
    await assert.rejects(() => beginPublication(executor, { kind: "report", taskId: "task-b", attempt: 1 }), /assigned task/);
    const publicationId = await beginPublication(executor, { kind: "message", taskId: "task-a", attempt: 1, recipient: "reviewer", category: "finding" });
    await appendPublicationChunk(executor, publicationId, 0, "addressed evidence");
    await finalizePublication(executor, publicationId, 1);
    const addressed = await readArtifact(reviewer, publicationId);
    assert.equal(addressed.content, "addressed evidence");
    await assert.rejects(() => readArtifact(crossTaskReviewer, publicationId), /not authorized/);
    const outsider = { ...owner, token: "x".repeat(43) };
    await assert.rejects(() => readArtifact(outsider, publicationId), /not authorized/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("concurrent capability issuance preserves every manifest entry", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-manifest-lock-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-manifest-lock-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-manifest-lock" });
    const [firstToken, secondToken] = await Promise.all([
      createTaskCapability(owner, { role: "executor", taskId: "task-first", attempt: 1 }),
      createTaskCapability(owner, { role: "executor", taskId: "task-second", attempt: 1 }),
    ]);
    for (const [token, taskId] of [[firstToken, "task-first"], [secondToken, "task-second"]]) {
      const access = { ...owner, token };
      const publication = await beginPublication(access, { kind: "report", taskId, attempt: 1 });
      await appendPublicationChunk(access, publication, 0, taskId);
      await finalizePublication(access, publication, 1);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("finalization requires the exact contiguous chunk set while allowing out-of-order upload", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-chunks-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-chunks-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-chunks" });

    const sparse = await beginPublication(owner, { kind: "report" });
    await appendPublicationChunk(owner, sparse, 0, "zero");
    await appendPublicationChunk(owner, sparse, 2, "two");
    await assert.rejects(() => finalizePublication(owner, sparse, 1), /exactly the contiguous set/);

    const outOfOrder = await beginPublication(owner, { kind: "report" });
    await appendPublicationChunk(owner, outOfOrder, 1, "one");
    await appendPublicationChunk(owner, outOfOrder, 0, "zero");
    const finalized = await finalizePublication(owner, outOfOrder, 2);
    assert.equal((await readArtifact(owner, finalized.artifactId)).content, "zeroone");

    const highExtra = await beginPublication(owner, { kind: "report" });
    await appendPublicationChunk(owner, highExtra, 0, "zero");
    await appendPublicationChunk(owner, highExtra, 999, "high");
    await assert.rejects(() => finalizePublication(owner, highExtra, 1), /exactly the contiguous set/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("serialized pages stay within budget for escaped Unicode and metadata", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-budget-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-budget-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-budget" });
    const publicationId = await beginPublication(owner, {
      kind: "report",
      taskId: "task-budget",
      attempt: 7,
      requiredSections: Array.from({ length: 80 }, (_, index) => `section-${index}-${"m".repeat(32)}`),
    });
    const content = "\u0000😀\"\\\n".repeat(5_000);
    await appendPublicationChunk(owner, publicationId, 0, content);
    await finalizePublication(owner, publicationId, 1);
    const page = await readArtifact(owner, publicationId, { limit: 50_000 });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_SERIALIZED_PAGE_BYTES);
    assert.equal(page.complete, false);
    assert.ok(page.nextOffset && page.nextOffset < content.length);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("flat artifact index finds owner cross-attempt and capability-free task publications", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-index-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-index-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-index" });
    for (const metadata of [
      { kind: "report" as const, taskId: "task-no-capability", attempt: 1 },
      { kind: "review" as const, taskId: "task-cross-attempt", attempt: 23, verdict: "PASS" as const },
    ]) {
      const publicationId = await beginPublication(owner, metadata);
      await appendPublicationChunk(owner, publicationId, 0, `${metadata.taskId}/${metadata.attempt}`);
      await finalizePublication(owner, publicationId, 1);
      assert.equal((await readArtifact(owner, publicationId)).content, `${metadata.taskId}/${metadata.attempt}`);
    }
    rememberOwnerAccess("owner-index-session", owner);
    const ownerViaSession = resolveArtifactAccess(repo, owner.runId, owner.repositoryId, undefined, "owner-index-session");
    assert.equal(ownerViaSession.runDir, owner.runDir);
    await assert.rejects(async () => resolveArtifactAccess(repo, owner.runId, owner.repositoryId, undefined, "different-session"), /originating owner session/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("brain session reuses one managed run across independent task attempts", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-run-reuse-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-run-reuse-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const first = await prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "executor", taskId: "task-alpha", contractVersion: "v1", baseSha: "a".repeat(40), ownerSessionId: "reuse-owner", stateRoot });
    const retry = await prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "executor", taskId: "task-alpha", contractVersion: "v1", baseSha: "a".repeat(40), ownerSessionId: "reuse-owner", runId: first!.access.runId, stateRoot });
    assert.equal(retry!.taskToken, first!.taskToken, "a ready retry resumes the same scoped capability instead of creating concurrent credentials");
    const second = await prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "executor", taskId: "task-beta", contractVersion: "v1", baseSha: "a".repeat(40), ownerSessionId: "reuse-owner", runId: first!.access.runId, stateRoot });
    assert.equal(second!.access.runId, first!.access.runId);
    assert.equal((await readTaskAttempt(first!.access, "task-alpha", 1)).status, "ready");
    assert.equal((await readTaskAttempt(first!.access, "task-beta", 1)).status, "ready");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("managed multi-task lifecycle gates executor to reviewer handoff on complete exact artifacts", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-lifecycle-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-lifecycle-root-"));
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-lifecycle" });
    await createTaskAttempt(owner, { taskId: "task-one", attempt: 1, contractVersion: "contract-v1", baseSha });
    await transitionTaskAttempt(owner, "task-one", 1, "ready", { status: "running" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-one", attempt: 1 }) };

    const reportId = await beginPublication(executor, {
      kind: "report", taskId: "task-one", attempt: 1, contractVersion: "contract-v1", baseSha, headSha,
      requiredSections: ["Summary", "Validation", "Assumptions", "Risks"],
    });
    const largeReport = `# Summary\ncomplete\n## Validation\n${"line\n".repeat(3_000)}## Assumptions\nnone\n## Risks\nnone\n`;
    await appendPublicationChunk(executor, reportId, 0, largeReport.slice(0, 40_000));
    await appendPublicationChunk(executor, reportId, 1, largeReport.slice(40_000));
    await finalizePublication(executor, reportId, 2);
    const submitted = await submitTaskAttempt(owner, "task-one", 1);
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.reportArtifactId, reportId);

    await beginTaskReview(owner, "task-one", 1);
    const reviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "task-one", attempt: 1 }) };
    let offset = 0;
    let reconstructed = "";
    do {
      const page = await readArtifact(reviewer, reportId, { offset, limit: 50_000 });
      reconstructed += page.content;
      if (page.complete) break;
      offset = page.nextOffset!;
    } while (true);
    assert.equal(reconstructed, largeReport);

    const reviewId = await beginPublication(reviewer, {
      kind: "review", verdict: "PASS", taskId: "task-one", attempt: 1, contractVersion: "contract-v1", baseSha, headSha,
      requiredSections: ["Verdict", "Findings", "Validation"],
    });
    await appendPublicationChunk(reviewer, reviewId, 0, "# Verdict\nPASS\n## Findings\nnone\n## Validation\nreport fully read\n");
    await finalizePublication(reviewer, reviewId, 1);
    const approved = await completeTaskReview(owner, "task-one", 1);
    assert.equal(approved.status, "approved");
    assert.equal(approved.reviewArtifactId, reviewId);

    await createTaskAttempt(owner, { taskId: "task-two", attempt: 1, contractVersion: "contract-v2", baseSha });
    await transitionTaskAttempt(owner, "task-two", 1, "ready", { status: "running" });
    assert.equal((await readTaskAttempt(owner, "task-one", 1)).status, "approved");
    assert.equal((await readTaskAttempt(owner, "task-two", 1)).status, "running");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("managed lifecycle rejects missing, invalid, stale, and blocked submissions", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-rejections-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-rejections-root-"));
  const baseSha = "c".repeat(40);
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-rejections" });
    for (const taskId of ["missing", "invalid", "stale", "blocked"]) {
      await createTaskAttempt(owner, { taskId, attempt: 1, contractVersion: "v1", baseSha });
      await transitionTaskAttempt(owner, taskId, 1, "ready", { status: "running" });
    }
    await assert.rejects(() => submitTaskAttempt(owner, "missing", 1), /exactly one current/);

    for (const [taskId, contractVersion, content] of [
      ["invalid", "v1", "# Summary\nok\n## Validation\nok\n## Assumptions\nnone\n"],
      ["stale", "old-contract", "# Summary\nok\n## Validation\nok\n## Assumptions\nnone\n## Risks\nnone\n"],
    ] as const) {
      const capability = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId, attempt: 1 }) };
      const id = await beginPublication(capability, { kind: "report", taskId, attempt: 1, contractVersion, baseSha, headSha: "d".repeat(40), requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
      await appendPublicationChunk(capability, id, 0, content);
      await finalizePublication(capability, id, 1);
    }
    await assert.rejects(() => submitTaskAttempt(owner, "invalid", 1), /missing required section: Risks/);
    await assert.rejects(() => submitTaskAttempt(owner, "stale", 1), /exactly one current/);

    const blockedExecutor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "blocked", attempt: 1 }) };
    const blockedReport = await beginPublication(blockedExecutor, { kind: "report", taskId: "blocked", attempt: 1, contractVersion: "v1", baseSha, headSha: "e".repeat(40), requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(blockedExecutor, blockedReport, 0, "# Summary\nok\n## Validation\nok\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(blockedExecutor, blockedReport, 1);
    const blockerId = await beginPublication(owner, { kind: "message", taskId: "blocked", attempt: 1, recipient: "executor", category: "finding", blocking: true });
    await appendPublicationChunk(owner, blockerId, 0, "Must resolve exact contract concern");
    await finalizePublication(owner, blockerId, 1);
    const firstInbox = await readInbox(blockedExecutor);
    assert.equal(firstInbox.messages[0].acknowledged, false);
    assert.deepEqual(firstInbox.unresolvedBlockerIds, [blockerId]);
    const emptyDelta = await readInbox(blockedExecutor, { after: firstInbox.nextCursor! });
    assert.deepEqual(emptyDelta.messages, []);
    await acknowledgeInbox(blockedExecutor, [blockerId]);
    assert.equal((await readInbox(blockedExecutor)).messages[0].acknowledged, true);
    assert.deepEqual((await readInbox(blockedExecutor)).unresolvedBlockerIds, [blockerId]);

    await assert.rejects(() => beginPublication(blockedExecutor, { kind: "message", taskId: "blocked", attempt: 1, recipient: "brain", category: "answer", replyTo: blockerId }), /finding owner|run owner/);
    assert.deepEqual((await readInbox(blockedExecutor)).unresolvedBlockerIds, [blockerId]);
    await assert.rejects(() => submitTaskAttempt(owner, "blocked", 1), /blocked by unresolved messages/);
    const answerId = await beginPublication(owner, { kind: "message", taskId: "blocked", attempt: 1, recipient: "executor", category: "answer", replyTo: blockerId });
    await appendPublicationChunk(owner, answerId, 0, "Owner verified the fix against the current snapshot");
    await finalizePublication(owner, answerId, 1);
    const resolvedInbox = await readInbox(blockedExecutor);
    assert.deepEqual(resolvedInbox.unresolvedBlockerIds, []);
    assert.equal(resolvedInbox.messages.find(item => item.artifactId === blockerId)?.resolved, true);
    assert.equal((await submitTaskAttempt(owner, "blocked", 1)).status, "submitted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("stale reviewer verdict cannot approve a changed exact head", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-stale-review-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-stale-review-root-"));
  const baseSha = "e".repeat(40);
  const headSha = "f".repeat(40);
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-stale-review" });
    await createTaskAttempt(owner, { taskId: "task-review", attempt: 1, contractVersion: "v1", baseSha });
    await transitionTaskAttempt(owner, "task-review", 1, "ready", { status: "running" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-review", attempt: 1 }) };
    const report = await beginPublication(executor, { kind: "report", taskId: "task-review", attempt: 1, contractVersion: "v1", baseSha, headSha, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(executor, report, 0, "# Summary\nok\n## Validation\nok\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(executor, report, 1);
    await submitTaskAttempt(owner, "task-review", 1);
    await beginTaskReview(owner, "task-review", 1);
    const reviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "task-review", attempt: 1 }) };
    const review = await beginPublication(reviewer, { kind: "review", verdict: "PASS", taskId: "task-review", attempt: 1, contractVersion: "v1", baseSha, headSha: "1".repeat(40), requiredSections: ["Verdict", "Findings", "Validation"] });
    await appendPublicationChunk(reviewer, review, 0, "# Verdict\nPASS\n## Findings\nnone\n## Validation\nok\n");
    await finalizePublication(reviewer, review, 1);
    await assert.rejects(() => completeTaskReview(owner, "task-review", 1), /exactly one current/);
    assert.equal((await readTaskAttempt(owner, "task-review", 1)).status, "reviewing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("owner messages require exact routable destination scope", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-routing-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-routing-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-routing" });
    await createTaskCapability(owner, { role: "executor", taskId: "task-route", attempt: 1 });
    await assert.rejects(() => beginPublication(owner, { kind: "message", recipient: "executor", category: "finding", blocking: true }), /taskId.*attempt/);
    await assert.rejects(() => beginPublication(owner, { kind: "message", taskId: "other", attempt: 1, recipient: "executor", category: "finding", blocking: true }), /no routable capability/);
    await assert.rejects(() => beginPublication(owner, { kind: "message", taskId: "task-route", attempt: 1, recipient: "reviewer", category: "finding", blocking: true }), /no routable capability/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("review completion remains blocked until the finding owner resolves it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-review-blocker-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-review-blocker-root-"));
  const baseSha = "2".repeat(40);
  const headSha = "3".repeat(40);
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-review-blocker" });
    await createTaskAttempt(owner, { taskId: "task-review-blocker", attempt: 1, contractVersion: "v1", baseSha });
    await transitionTaskAttempt(owner, "task-review-blocker", 1, "ready", { status: "running" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-review-blocker", attempt: 1 }) };
    const report = await beginPublication(executor, { kind: "report", taskId: "task-review-blocker", attempt: 1, contractVersion: "v1", baseSha, headSha, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(executor, report, 0, "# Summary\nok\n## Validation\nok\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(executor, report, 1);
    await submitTaskAttempt(owner, "task-review-blocker", 1);
    await beginTaskReview(owner, "task-review-blocker", 1);
    const reviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "task-review-blocker", attempt: 1 }) };
    const review = await beginPublication(reviewer, { kind: "review", verdict: "PASS", taskId: "task-review-blocker", attempt: 1, contractVersion: "v1", baseSha, headSha, requiredSections: ["Verdict", "Findings", "Validation"] });
    await appendPublicationChunk(reviewer, review, 0, "# Verdict\nPASS\n## Findings\nnone\n## Validation\nok\n");
    await finalizePublication(reviewer, review, 1);
    const blocker = await beginPublication(owner, { kind: "message", taskId: "task-review-blocker", attempt: 1, recipient: "reviewer", category: "finding", blocking: true });
    await appendPublicationChunk(owner, blocker, 0, "Verify one more condition");
    await finalizePublication(owner, blocker, 1);
    await assert.rejects(() => completeTaskReview(owner, "task-review-blocker", 1), /blocked by unresolved messages/);
    const resolution = await beginPublication(owner, { kind: "message", taskId: "task-review-blocker", attempt: 1, recipient: "reviewer", category: "answer", replyTo: blocker });
    await appendPublicationChunk(owner, resolution, 0, "Condition independently verified");
    await finalizePublication(owner, resolution, 1);
    assert.equal((await completeTaskReview(owner, "task-review-blocker", 1)).status, "approved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("writer ownership excludes competing managed executors and recovery requires inactive liveness", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-writer-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-writer-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const first = await createRunState({ cwd: repo, stateRoot, runId: "run-writer-one" });
    const second = await createRunState({ cwd: repo, stateRoot, runId: "run-writer-two" });
    for (const [owner, taskId] of [[first, "task-first"], [second, "task-second"]] as const) await createTaskAttempt(owner, { taskId, attempt: 1, contractVersion: "v1", baseSha: "4".repeat(40) });
    await acquireWriterOwnership(first, "task-first", 1, "executor-one", "pane-one");
    await markWriterRunning(first, "task-first", 1);
    await assert.rejects(() => acquireWriterOwnership(second, "task-second", 1, "executor-two", "pane-two"), /already owned/);
    await assert.rejects(() => recoverTaskAttempt(first, "task-first", 1, false, "not proven"), /liveness has not been proven/);
    assert.equal((await recoverTaskAttempt(first, "task-first", 1, true, "agent absent after corroborated lookup")).status, "failed");
    assert.equal((await acquireWriterOwnership(second, "task-second", 1, "executor-two", "pane-two")).status, "starting");
    await recoverTaskAttempt(second, "task-second", 1, true, "test cleanup");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("inbox cursors are stable publication sequences and corrupt evidence fails closed until explicit recovery", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-inbox-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-inbox-root-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-inbox" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-inbox", attempt: 1 }) };
    for (let i = 0; i < 3; i += 1) {
      const id = await beginPublication(owner, { kind: "message", taskId: "task-inbox", attempt: 1, recipient: "executor", category: "notification" });
      await appendPublicationChunk(owner, id, 0, `message-${i}`);
      await finalizePublication(owner, id, 1);
    }
    const first = await readInbox(executor, { limit: 1 });
    assert.match(first.nextCursor!, /^1:message-/);
    const second = await readInbox(executor, { after: first.nextCursor!, limit: 1 });
    assert.match(second.nextCursor!, /^2:message-/);
    assert.notEqual(first.messages[0].artifactId, second.messages[0].artifactId);
    const corruptId = second.messages[0].artifactId;
    writeFileSync(join(owner.runDir, "artifacts", `${corruptId}.json`), "{damaged", "utf8");
    await assert.rejects(() => readInbox(executor), /Corrupt crew evidence.*explicit owner recovery/);
    await discardCorruptArtifact(owner, corruptId);
    assert.equal((await readInbox(executor)).messages.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("actual managed completion wiring refuses marker-only success and redacts task capability", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-wiring-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-wiring-root-"));
  const oldHerdr = process.env.HERDR_ENV;
  const oldRoot = process.env.CREW_STATE_ROOT;
  process.env.HERDR_ENV = "1";
  process.env.CREW_STATE_ROOT = stateRoot;
  const markers = buildCrewMarkers("managed-marker");
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "model-tiers.json"), JSON.stringify({ crewRoles: { executor: { authority: "can-edit" } } }));
    const agent = { name: "executor", pane_id: "pane-managed", workspace_id: "ws", tab_id: "tab", cwd: repo, agent_status: "idle" };
    let paneCreated = false;
    const mockPi = { registerTool() {}, async exec(command: string, args: string[] = []) {
      assert.equal(command, "herdr");
      if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "brain", workspace_id: "ws", tab_id: "tab", cwd: repo } } }), stderr: "" };
      if (args[0] === "pane" && args[1] === "split") { paneCreated = true; return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-managed" } } }), stderr: "" }; }
      if (args[0] === "pane" && args[1] === "run") { assert.match(args[3], /CREW_STATE_ROOT=/); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "pane" && args[1] === "read") return { code: 0, stdout: "ready", stderr: "" };
      if (args[0] === "agent" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ result: { agents: paneCreated ? [agent] : [] } }), stderr: "" };
      if (args[0] === "agent" && args[1] === "rename") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "agent" && args[1] === "get") return { code: 0, stdout: JSON.stringify({ result: { agent } }), stderr: "" };
      if (args[0] === "agent" && args[1] === "prompt") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "agent" && args[1] === "read") return { code: 0, stdout: `${markers.start}\nmarker-only\n${markers.end}`, stderr: "" };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    } };
    const result = await executeCrewLaunch(mockPi as any, { role: "executor", task: "Implement a bounded managed test task.", durable: true, taskId: "task-managed", contractVersion: "v1", baseSha: "5".repeat(40), toolCallId: "managed-marker", startupTimeoutMs: 4_000 } as any, undefined, undefined, "managed-owner") as any;
    assert.equal(result.details.complete, false);
    assert.match(result.details.managedCompletionError, /exactly one current/);
    assert.doesNotMatch(JSON.stringify(result), /capabilityToken:\s*(?!\[REDACTED\])/);
    assert.equal(redactCapabilitySecrets("capabilityToken: super-secret", ["super-secret"]), "capabilityToken: [REDACTED]");
    const access = resolveArtifactAccess(repo, result.details.runId, result.details.repositoryId, undefined, "managed-owner");
    await recoverTaskAttempt(access, "task-managed", 1, true, "test cleanup after idle marker-only role");
  } finally {
    if (oldHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldHerdr;
    if (oldRoot === undefined) delete process.env.CREW_STATE_ROOT; else process.env.CREW_STATE_ROOT = oldRoot;
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

await regressionTest("crew state rejects symlinked run paths and duplicate run identities", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-link-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-link-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "crew-link-elsewhere-"));
  try {
    await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "-q", repo]));
    const first = await createRunState({ cwd: repo, stateRoot, runId: "run-once" });
    await assert.rejects(() => createRunState({ cwd: repo, stateRoot, runId: "run-once" }), /EEXIST/);
    const malicious = join(stateRoot, first.repositoryId, "run-link");
    symlinkSync(elsewhere, malicious, "dir");
    await assert.rejects(() => createRunState({ cwd: repo, stateRoot, runId: "run-link" }), /symlink|EEXIST/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

await regressionTest("compact plan index, immutable contracts, and approved checkpoints restore without history", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-plan-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-plan-root-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const access = await createRunState({ cwd: repo, stateRoot });
    await publishPhaseContract(access, "r2", "v1", "# Scope\nImplement bounded context.\n# Required\nPreserve blockers.\n");
    await writePlanIndex(access, { revision: 1, currentPhaseId: "r2", phases: [{ id: "r2", summary: "Bound context", status: "current", contractVersion: "v1" }, { id: "r3", summary: "Models", status: "pending", contractVersion: "v1" }] });
    const current = await readCurrentPhase(access);
    assert.equal(current.index.phases.length, 2);
    assert.match(current.contract, /Preserve blockers/);
    await assert.rejects(() => publishPhaseContract(access, "r2", "v1", "overwrite"), /EEXIST/);
    const snapshot = "a".repeat(64);
    const checkpoint = await createPhaseCheckpoint(access, { phaseId: "r2", contractVersion: "v1", sourceSnapshotId: snapshot, summary: "R2 passed", decisions: ["fresh sessions"], remainingPhaseIds: ["r3"], unresolvedBlockerIds: ["finding-1"], approvalState: "approved", evidenceArtifactIds: [] });
    assert.equal((await readPhaseCheckpoint(access, "r2")).unresolvedBlockerIds[0], "finding-1");
    assert.equal(checkpoint.approvalState, "approved");
    assert.equal((await readPlanIndex(access)).revision, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); }
});

await regressionTest("section-selective artifact reads paginate selected escaped Unicode without hiding integrity", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-select-repo-")); const stateRoot = mkdtempSync(join(tmpdir(), "crew-select-root-"));
  try {
    execFileSync("git", ["init", "-q", repo]); const access = await createRunState({ cwd: repo, stateRoot });
    const publication = await beginPublication(access, { kind: "checkpoint", phaseId: "r2" });
    await appendPublicationChunk(access, publication, 0, `# Summary\nshort\n# Required\n${"🧪\\\"".repeat(6000)}\n# Optional\nignore\n`);
    const finalized = await finalizePublication(access, publication, 1);
    let offset = 0; let rebuilt = ""; let page;
    do { page = await readArtifact(access, finalized.artifactId, { section: "Required", offset, limit: 50000 }); rebuilt += page.content; offset = page.nextOffset ?? offset; assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_SERIALIZED_PAGE_BYTES); } while (!page.complete);
    assert.match(rebuilt, /^# Required/m); assert.doesNotMatch(rebuilt, /Optional/); assert.equal(page.sha256, finalized.sha256);
    const search = await readArtifact(access, finalized.artifactId, { query: "short" }); assert.match(search.content, /short/);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); }
});

await regressionTest("uncommitted source snapshots are scoped, content-sensitive, and include untracked files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-snapshot-repo-"));
  try {
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n"); execFileSync("git", ["-C", repo, "add", "tracked.txt"]); execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    const clean = captureSourceSnapshot(repo, ["tracked.txt", "new.txt"]); writeFileSync(join(repo, "new.txt"), "new\n"); const dirty = captureSourceSnapshot(repo, ["tracked.txt", "new.txt"]);
    assert.notEqual(clean.id, dirty.id); assert.ok(dirty.dirtyPaths.includes("new.txt")); assert.equal(dirty.paths.length, 2);
    writeFileSync(join(repo, "unrelated.txt"), "ignored\n"); assert.equal(captureSourceSnapshot(repo, ["tracked.txt", "new.txt"]).id, dirty.id);
    rmSync(join(repo, "new.txt")); writeFileSync(join(repo, "tracked.txt"), "staged\n"); execFileSync("git", ["-C", repo, "add", "tracked.txt"]); writeFileSync(join(repo, "tracked.txt"), "one\n");
    const stagedOnly = captureSourceSnapshot(repo, ["tracked.txt"]); execFileSync("git", ["-C", repo, "reset", "-q", "HEAD", "--", "tracked.txt"]); assert.notEqual(stagedOnly.id, captureSourceSnapshot(repo, ["tracked.txt"]).id, "index bytes must affect the snapshot even when worktree equals HEAD");
    rmSync(join(repo, "tracked.txt")); const deleted = captureSourceSnapshot(repo, ["tracked.txt"]); assert.notEqual(deleted.id, clean.id); execFileSync("git", ["-C", repo, "add", "-u"]); assert.doesNotThrow(() => captureSourceSnapshot(repo, ["tracked.txt"]));
    assert.throws(() => captureSourceSnapshot(repo, ["../escape"]), /escapes/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

await regressionTest("optional frozen parent context lookup is source-bound, paginated without gaps, and budgeted", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "crew-native-session-"));
  try {
    const longText = `needle-${"x".repeat(7_500)}-end`;
    const records = [
      { type: "session", id: "parent-session" },
      { type: "message", id: "p1", parentId: null, message: { role: "user", content: [{ type: "text", text: "visible fact apiKey=do-not-return\nAuthorization: Bearer supersecret\n\"api_key\"  :  \"json secret with spaces\"\naccess_token \t=\t whitespace-secret" }] } },
      { type: "message", id: "p2", parentId: "p1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: longText }] } },
    ];
    writeFileSync(join(sessionDir, "2026-01-01_parent-session.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const prompt = buildRolePrompt("scout", { authority: "read-only" }, "Find one fact", "/repo", { contextSource: { version: 1, parentSessionId: "parent-session", upperBoundEntryId: "p2" } });
    const roleBranch: any[] = [{ type: "message", id: "child-prompt", parentId: null, message: { role: "user", content: [{ type: "text", text: prompt }] } }];
    const ctx = { cwd: "/repo", sessionManager: { getBranch: () => roleBranch, getSessionDir: () => sessionDir } } as any;
    const first: any = await executeReadContext({ mode: "search", query: "needle" }, ctx); assert.equal(first.details.returnedChars, 6000); assert.equal(first.details.truncated, true);
    roleBranch.push({ type: "message", id: "read-1", parentId: "child-prompt", message: { role: "toolResult", toolName: "crew_read_context", details: first.details, content: first.content } });
    const second: any = await executeReadContext({ mode: "search", query: "needle", cursor: first.details.nextCursor }, ctx);
    assert.equal(first.content[0].text + second.content[0].text, `[assistant entryId=p2]\n${longText}`, "cursor must consume the remaining entry exactly once");
    await assert.rejects(() => executeReadContext({ mode: "search", query: "different", cursor: first.details.nextCursor }, ctx), /does not match/);
    const parsedCursor = JSON.parse(Buffer.from(first.details.nextCursor, "base64url").toString("utf8"));
    const { mac: _originalMac, ...forgedBody } = parsedCursor; forgedBody.offset = forgedBody.offset + 1;
    const forgedCursor = Buffer.from(JSON.stringify({ ...forgedBody, mac: createHash("sha256").update(JSON.stringify(forgedBody)).digest("hex") })).toString("base64url");
    await assert.rejects(() => executeReadContext({ mode: "search", query: "needle", cursor: forgedCursor }, ctx), /Invalid or tampered/);
    const credential: any = await executeReadContext({ mode: "search", query: "visible fact", maxChars: 1000 }, ctx);
    assert.doesNotMatch(credential.content[0].text, /do-not-return|supersecret|json secret|whitespace-secret/); assert.match(credential.content[0].text, /redacted/);
    const bearer: any = await executeReadContext({ mode: "search", query: "Authorization", maxChars: 1000 }, ctx); assert.match(bearer.content[0].text, /Authorization: \[redacted\]/); assert.doesNotMatch(bearer.content[0].text, /Bearer|supersecret/);
    const quotedJson: any = await executeReadContext({ mode: "search", query: "api_key", maxChars: 1000 }, ctx); assert.match(quotedJson.content[0].text, /\"api_key\"\s*:\s*\[redacted\]/); assert.doesNotMatch(quotedJson.content[0].text, /json secret with spaces/);
    const whitespace: any = await executeReadContext({ mode: "search", query: "access_token", maxChars: 1000 }, ctx); assert.match(whitespace.content[0].text, /access_token\s*=\s*\[redacted\]/); assert.doesNotMatch(whitespace.content[0].text, /whitespace-secret/);
    roleBranch.push({ type: "message", id: "new-delegation", parentId: "read-1", message: { role: "user", content: [{ type: "text", text: buildRolePrompt("scout", { authority: "read-only" }, "Explicit new work") }] } });
    await assert.rejects(() => executeReadContext({ mode: "search", query: "needle" }, ctx), /invalidate older locators/);
  } finally { rmSync(sessionDir, { recursive: true, force: true }); }
});

await regressionTest("cleanup preview retains live blockers and finalization is ownership-scoped and idempotent", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-cleanup-repo-")); const stateRoot = mkdtempSync(join(tmpdir(), "crew-cleanup-root-"));
  try {
    execFileSync("git", ["init", "-q", repo]); const owner = await createRunState({ cwd: repo, stateRoot });
    const taskToken = await createTaskCapability(owner, { role: "executor", taskId: "task-clean", attempt: 1 }); const executor = { ...owner, token: taskToken };
    const message = await beginPublication(executor, { kind: "message", taskId: "task-clean", attempt: 1, recipient: "brain", category: "question", blocking: true }); await appendPublicationChunk(executor, message, 0, "still needed"); const blocker = await finalizePublication(executor, message, 1);
    const old = await beginPublication(owner, { kind: "checkpoint", phaseId: "old" }); await appendPublicationChunk(owner, old, 0, "obsolete"); const obsolete = await finalizePublication(owner, old, 1);
    const preview = await previewArtifactCleanup(owner, [blocker.artifactId, obsolete.artifactId]); assert.deepEqual(preview.retainedArtifactIds, [blocker.artifactId]);
    const first = await finalizeArtifactCleanup(owner, preview.previewId); const second = await finalizeArtifactCleanup(owner, preview.previewId); assert.deepEqual(first.deletedArtifactIds, second.deletedArtifactIds);
    await assert.rejects(() => readArtifact(owner, obsolete.artifactId), /Unknown artifact/); assert.equal((await readArtifact(owner, blocker.artifactId)).content, "still needed");
    const terminalDraft = await beginPublication(owner, { kind: "checkpoint", phaseId: "terminal-evidence" }); await appendPublicationChunk(owner, terminalDraft, 0, "sole terminal evidence"); const terminalEvidence = await finalizePublication(owner, terminalDraft, 1);
    await createTaskAttempt(owner, { taskId: "terminal", attempt: 1, contractVersion: "v1", baseSha: "a".repeat(40) });
    await transitionTaskAttempt(owner, "terminal", 1, "ready", { status: "approved", reportArtifactId: terminalEvidence.artifactId });
    const protectedTerminal = await previewArtifactCleanup(owner, [terminalEvidence.artifactId]); assert.deepEqual(protectedTerminal.retainedArtifactIds, [terminalEvidence.artifactId], "terminal status must not silently drop sole evidence");
    await assert.rejects(() => disposeTaskEvidence(owner, "terminal", 1, "abandoned", "wrong disposition"), /only be disposed by explicit finalization/);
    await disposeTaskEvidence(owner, "terminal", 1, "finalized", "run accepted and explicitly finalized");
    const disposed = await previewArtifactCleanup(owner, [terminalEvidence.artifactId]); assert.deepEqual(disposed.artifactIds, [terminalEvidence.artifactId]);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("model effort, advisory budgets, and normalized current-context warnings are explicit", () => {
  const permanent = JSON.parse(readFileSync(join(process.cwd(), "skills", "crew", "model-tiers.json"), "utf8"));
  assert.deepEqual(permanent.models, {
    frontier: "anthropic/claude-opus-5",
    medium: "anthropic/claude-opus-4-8",
    small: "google/gemini-3.8-flash",
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(permanent.crewRoles).map(([name, value]: [string, any]) => [
        name,
        [value.model, value.reasoning, value.authority],
      ])
    ),
    {
      scout: ["medium", "medium", "read-only"],
      oracle: ["frontier", "xhigh", "read-only"],
      executor: ["small", "medium", "can-edit"],
      "executor-escalation": ["medium", "medium", "can-edit"],
      reviewer: ["frontier", "xhigh", "read-only"],
    }
  );

  // resolveRole resolves tiers to concrete Opus5/Opus4.8/Gemini + correct reasoning:
  const scoutRole = resolveRole("scout", permanent);
  assert.equal(scoutRole.model, "anthropic/claude-opus-4-8");
  assert.equal(scoutRole.reasoning, "medium");
  assert.equal(scoutRole.effort, "medium");
  assert.equal(scoutRole.tier, "medium");

  const oracleRole = resolveRole("oracle", permanent);
  assert.equal(oracleRole.model, "anthropic/claude-opus-5");
  assert.equal(oracleRole.reasoning, "xhigh");

  const executorRole = resolveRole("executor", permanent);
  assert.equal(executorRole.model, "google/gemini-3.8-flash");
  assert.equal(executorRole.reasoning, "medium");

  const reviewerRole = resolveRole("reviewer", permanent);
  assert.equal(reviewerRole.model, "anthropic/claude-opus-5");
  assert.equal(reviewerRole.reasoning, "xhigh");

  // Parallel review agent resolution:
  const reviewTiers = permanent.parallelCodeReview;
  assert.deepEqual(reviewTiers.synthesis, { model: "medium", reasoning: "medium" });
  assert.equal(reviewTiers.testRunner.reasoning, "low");
  const resolvedSynthesis = resolveParallelReviewAgent("synthesis", permanent);
  assert.equal(resolvedSynthesis.model, "anthropic/claude-opus-4-8");
  assert.equal(resolvedSynthesis.reasoning, "medium");
  const resolvedTestRunner = resolveParallelReviewAgent("testRunner", permanent);
  assert.equal(resolvedTestRunner.model, "google/gemini-3.8-flash");
  assert.equal(resolvedTestRunner.reasoning, "low");

  // Legacy parallelCodeReview inline concrete form:
  const legacyReviewConfig: ModelTiers = {
    parallelCodeReview: {
      synthesis: { model: "anthropic/claude-opus-4-8", effort: "medium" },
    },
  };
  const resolvedLegacy = resolveParallelReviewAgent("synthesis", legacyReviewConfig);
  assert.equal(resolvedLegacy.model, "anthropic/claude-opus-4-8");
  assert.equal(resolvedLegacy.reasoning, "medium");

  // Inline concrete model override beats tier:
  const overrideConfig: ModelTiers = {
    models: { medium: "anthropic/claude-opus-4-8" },
    crewRoles: {
      scout: { model: "custom-provider/custom-model", reasoning: "high", authority: "read-only" },
    },
  };
  const overriddenRole = resolveRole("scout", overrideConfig);
  assert.equal(overriddenRole.model, "custom-provider/custom-model");
  assert.equal(overriddenRole.reasoning, "high");
  assert.equal(overriddenRole.tier, undefined);

  // Unknown model tier throws:
  assert.throws(
    () => resolveRole("scout", { models: { small: "google/gemini-3.8-flash" }, crewRoles: { scout: { model: "frontier" } } }),
    /Unknown model tier/
  );
  assert.throws(
    () => resolveModelTier("nonexistent", { models: { small: "google/gemini-3.8-flash" } }),
    /Unknown model tier/
  );

  // Reasoning must be a valid THINKING_LEVELS value:
  assert.throws(
    () => resolveRole("scout", { crewRoles: { scout: { reasoning: "turbo" as any } } }),
    /Invalid effort/
  );
  assert.throws(
    () => resolveRole("scout", { crewRoles: { scout: { effort: "turbo" as any } } }),
    /Invalid effort/
  );

  // Missing config file / empty config -> undefined model (env default), no throw:
  const emptyRole = resolveRole("executor", {});
  assert.equal(emptyRole.model, undefined);
  assert.equal(emptyRole.reasoning, undefined);
  assert.equal(emptyRole.authority, "can-edit");

  assert.equal(buildRoleCommand("pi", "provider/model", "can-edit", undefined, "medium"), "pi --approve --model provider/model --thinking medium");
  assert.equal(assessPayload("x".repeat(9000), "delegation").overBudget, true);
  assert.deepEqual(normalizeUsage({ input: 10, cacheRead: 20, cacheWrite: 30, output: 5, reasoning: 999, cost: { total: 1.25 } }), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30, currentContextTokens: 60, cost: 1.25 });
  assert.equal(contextWarningLevel(74999), "none"); assert.equal(contextWarningLevel(75000), "warn"); assert.equal(contextWarningLevel(70000, "warn"), "warn"); assert.equal(contextWarningLevel(64999, "warn"), "none"); assert.equal(contextWarningLevel(125000), "checkpoint"); assert.equal(contextWarningLevel(116000, "checkpoint"), "checkpoint");
});

await regressionTest("snapshot-bound submission rejects stale reviewer launch before entering review", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-bound-review-repo-")); const stateRoot = mkdtempSync(join(tmpdir(), "crew-bound-review-root-"));
  try {
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "source.ts"), "one\n"); execFileSync("git", ["-C", repo, "add", "source.ts"]); execFileSync("git", ["-C", repo, "commit", "-qm", "base"]); const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const owner = await createRunState({ cwd: repo, stateRoot, ownerSessionId: "snapshot-owner" }); rememberOwnerAccess("snapshot-owner", owner);
    await createTaskAttempt(owner, { taskId: "task-snapshot", attempt: 1, contractVersion: "v1", baseSha, sourcePaths: ["source.ts"], executorSessionGeneration: "generation-one" }); await transitionTaskAttempt(owner, "task-snapshot", 1, "ready", { status: "running" });
    const snapshot = captureSourceSnapshot(repo, ["source.ts"]); const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "task-snapshot", attempt: 1 }) };
    const report = await beginPublication(executor, { kind: "report", taskId: "task-snapshot", attempt: 1, contractVersion: "v1", baseSha, headSha: baseSha, sourceSnapshotId: snapshot.id, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(executor, report, 0, "# Summary\nok\n# Validation\nok\n# Assumptions\nnone\n# Risks\nnone\n"); await finalizePublication(executor, report, 1); await submitTaskAttempt(owner, "task-snapshot", 1, undefined, snapshot.id);
    writeFileSync(join(repo, "source.ts"), "changed\n");
    await assert.rejects(() => prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "reviewer", taskId: "task-snapshot", runId: owner.runId, ownerSessionId: "snapshot-owner" }), /snapshot is stale/);
    assert.equal((await readTaskAttempt(owner, "task-snapshot", 1)).status, "submitted");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("handoff boundary uses last completed crew_launch checkpoint, recent-turns fallback when none", () => {
  const currentToolCallId = "call-current-123";
  const branch: SessionEntryLike[] = [
    { id: "e1", type: "message", message: { role: "user", content: "Initial user instruction" } },
    { id: "e2", type: "message", message: { role: "assistant", content: "Starting initial scout..." } },
    {
      id: "e3",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "crew_launch",
        toolCallId: "call-scout-1",
        isError: false,
        content: "Scout complete: mapped files.",
        details: { complete: true, role: "scout" },
      },
    },
    { id: "e4", type: "message", message: { role: "user", content: "Great, now implement phase 1." } },
    { id: "e5", type: "message", message: { role: "assistant", content: "Starting executor..." } },
    {
      id: "e6",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Launching executor delegation" },
          { type: "toolCall", id: currentToolCallId, name: "crew_launch" },
        ],
      },
    },
  ];

  // Case 1: Checkpoint found
  const handoffWithCheckpoint = buildHandoff(branch, currentToolCallId, "since-last-crew");
  assert.equal(handoffWithCheckpoint.fallbackUsed, false);
  assert.equal(handoffWithCheckpoint.checkpointEntryId, "e3");
  assert.ok(handoffWithCheckpoint.text.includes("Scout complete: mapped files."));
  assert.ok(handoffWithCheckpoint.text.includes("Great, now implement phase 1."));
  assert.ok(handoffWithCheckpoint.text.includes("Starting executor..."));
  assert.ok(!handoffWithCheckpoint.text.includes("Initial user instruction"));

  // Case 2: No checkpoint on branch -> fallback to recent user turns
  const branchNoCheckpoint: SessionEntryLike[] = [
    { id: "e1", type: "message", message: { role: "user", content: "Turn 1: hello" } },
    { id: "e2", type: "message", message: { role: "assistant", content: "Reply 1" } },
    { id: "e3", type: "message", message: { role: "user", content: "Turn 2: do research" } },
    { id: "e4", type: "message", message: { role: "assistant", content: "Reply 2" } },
    { id: "e5", type: "message", message: { role: "user", content: "Turn 3: launch now" } },
    {
      id: "e6",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: currentToolCallId, name: "crew_launch" },
        ],
      },
    },
  ];

  const handoffFallback = buildHandoff(branchNoCheckpoint, currentToolCallId, "since-last-crew", "recent", 2);
  assert.equal(handoffFallback.fallbackUsed, true);
  assert.equal(handoffFallback.checkpointEntryId, undefined);
  assert.ok(handoffFallback.text.includes("Turn 2: do research"));
  assert.ok(handoffFallback.text.includes("Reply 2"));
  assert.ok(handoffFallback.text.includes("Turn 3: launch now"));
  assert.ok(!handoffFallback.text.includes("Turn 1: hello"));

  // Case 3: No checkpoint and fallback="error" -> throws
  assert.throws(
    () => buildHandoff(branchNoCheckpoint, currentToolCallId, "since-last-crew", "error"),
    /no successful complete crew_launch checkpoint/
  );

  // Case 4: No checkpoint and fallback="explicit" -> returns explicit text
  const handoffExplicitFallback = buildHandoff(branchNoCheckpoint, currentToolCallId, "since-last-crew", "explicit", 2, 24000, "fallback explicit text");
  assert.equal(handoffExplicitFallback.fallbackUsed, true);
  assert.equal(handoffExplicitFallback.text, "fallback explicit text");
});

test("noise filtering drops thinking, compacts toolCall, placeholders images, and drops orphan tool results", () => {
  // Test entry with thinking, toolCall, image, and text
  const mixedEntry: SessionEntryLike = {
    id: "m1",
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Internal reasoning chain that should be stripped." },
        { type: "thinkingSignature", signature: "sig123" },
        { type: "text", text: "Visible assistant explanation." },
        { type: "toolCall", id: "tc-grep-1", name: "grep" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ],
    },
  };

  const text = visibleMessageText(mixedEntry);
  assert.ok(!text.includes("Internal reasoning chain"));
  assert.ok(!text.includes("sig123"));
  assert.ok(text.includes("Visible assistant explanation."));
  assert.ok(text.includes("[tool call: grep id=tc-grep-1]"));
  assert.ok(text.includes("[image]"));

  // Test dropping orphan tool results
  const entriesWithOrphan: SessionEntryLike[] = [
    {
      id: "orphan-1",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "tc-missing-call",
        content: "Orphan output that has no matching tool call in this slice",
      },
    },
    {
      id: "parent-call-msg",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-valid-1", name: "read" }],
      },
    },
    {
      id: "valid-tool-result",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "tc-valid-1",
        content: "Valid tool output",
      },
    },
  ];

  const filtered = selectHandoffEntries(entriesWithOrphan);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].id, "parent-call-msg");
  assert.equal(filtered[1].id, "valid-tool-result");
  const serialized = serializeSessionEntries(filtered);
  assert.ok(!serialized.includes("Orphan output"));
  assert.ok(serialized.includes("Valid tool output"));
});

test("redaction applied to pushed handoff", () => {
  const branchWithSecrets: SessionEntryLike[] = [
    {
      id: "s1",
      type: "message",
      message: {
        role: "user",
        content: [
          "Connect with credentials:",
          "apiKey: 'sk-super-secret-key-12345'",
          "Authorization: Bearer super-secret-bearer-token-abc",
          "-----BEGIN RSA PRIVATE KEY-----",
          "MIIEowIBAAKCAQEA0m4secretbytes...",
          "-----END RSA PRIVATE KEY-----",
        ].join("\n"),
      },
    },
  ];

  const handoff = buildHandoff(branchWithSecrets, undefined, "since-last-crew");
  assert.ok(!handoff.text.includes("sk-super-secret-key-12345"));
  assert.ok(!handoff.text.includes("super-secret-bearer-token-abc"));
  assert.ok(!handoff.text.includes("MIIEowIBAAKCAQEA0m4secretbytes..."));
  assert.ok(handoff.text.includes("apiKey: [redacted]"));
  assert.ok(handoff.text.includes("Authorization: [redacted]"));
  assert.ok(handoff.text.includes("[credential redacted]"));
});

test("maxHandoffChars cap enforced (oversized handoff truncated)", () => {
  const largeBranch: SessionEntryLike[] = [
    {
      id: "l1",
      type: "message",
      message: {
        role: "user",
        content: "A".repeat(500),
      },
    },
  ];

  const handoffCapped = buildHandoff(largeBranch, undefined, "since-last-crew", "recent", 6, 120);
  assert.equal(handoffCapped.text.length, 120);
});

test("default explicit mode injects no parent context", () => {
  const branch: SessionEntryLike[] = [
    { id: "e1", type: "message", message: { role: "user", content: "Secret parent conversation" } },
  ];

  // buildHandoff in explicit mode returns explicit text only
  const explicitHandoff = buildHandoff(branch, undefined, "explicit", "recent", 6, 24000, "user-supplied explicit context");
  assert.equal(explicitHandoff.text, "user-supplied explicit context");
  assert.deepEqual(explicitHandoff.entries, []);
  assert.equal(explicitHandoff.fallbackUsed, false);

  // buildRolePrompt default (no contextMode or explicit mode)
  const role = resolveRole("scout", {});
  const prompt = buildRolePrompt("scout", role, "Investigate bug", "/repo", { context: "user-supplied explicit context" });
  assert.ok(!prompt.includes("## Brain handoff (verbatim)"));
  assert.ok(!prompt.includes("Secret parent conversation"));
  assert.ok(prompt.includes("## Context\nuser-supplied explicit context"));
  assert.ok(prompt.includes("You do not have access to the parent agent's conversation."));

  // buildRolePrompt with since-last-crew produces ## Brain handoff (verbatim)
  const handoffPrompt = buildRolePrompt("scout", role, "Investigate bug", "/repo", {
    contextMode: "since-last-crew",
    handoffText: "Serialized brain entries here",
  });
  assert.ok(handoffPrompt.includes("## Brain handoff (verbatim)\n~~~text\nSerialized brain entries here\n~~~\n## End brain handoff"));

  // since-last-crew without handoffText falls back to normal explicit context rendering without brain handoff block
  const noHandoffPrompt = buildRolePrompt("scout", role, "Investigate bug", "/repo", {
    contextMode: "since-last-crew",
    context: "explicit only",
  });
  assert.ok(!noHandoffPrompt.includes("## Brain handoff (verbatim)"));
  assert.ok(noHandoffPrompt.includes("## Context\nexplicit only"));
});

test("maxHandoffChars boundary truncation cannot re-expose secrets", () => {
  const secret = "super-secret-api-token-value-12345";
  const branchWithSecret: SessionEntryLike[] = [
    {
      id: "sec-1",
      type: "message",
      message: {
        role: "user",
        content: `Prefix text before secret token. apiKey: '${secret}' and trailing notes.`,
      },
    },
  ];

  const unbudgeted = buildHandoff(branchWithSecret, undefined, "since-last-crew");
  assert.ok(unbudgeted.text.includes("apiKey: [redacted]"));
  assert.ok(!unbudgeted.text.includes(secret));

  const marker = "[redacted]";
  const markerIndex = unbudgeted.text.indexOf(marker);
  assert.ok(markerIndex > 0);

  for (const offset of [0, 4, marker.length, marker.length + 3]) {
    const cutLimit = markerIndex + offset;
    const truncatedHandoff = buildHandoff(branchWithSecret, undefined, "since-last-crew", "recent", 6, cutLimit);
    assert.equal(truncatedHandoff.text.length, cutLimit);
    assert.ok(!truncatedHandoff.text.includes(secret));
    assert.ok(!truncatedHandoff.text.includes("super-secret"));
  }
});

test("crew_launch parameter validation enforces valid contextMode, checkpointFallback, and positive numbers", async () => {
  const mockPi = { registerTool() {}, async exec() { return { code: 0, stdout: "", stderr: "" }; } };
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", contextMode: "invalid" as any } as any),
    /contextMode must be explicit or since-last-crew/
  );
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", checkpointFallback: "invalid" as any } as any),
    /checkpointFallback must be recent, explicit, or error/
  );
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", recentTurns: -1 } as any),
    /recentTurns must be a positive integer/
  );
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", maxHandoffChars: 0 } as any),
    /maxHandoffChars must be a positive integer/
  );
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", teardownGraceMs: -1 } as any),
    /teardownGraceMs must be a positive integer/
  );
  await assert.rejects(
    () => executeCrewLaunch(mockPi as any, { role: "scout", task: "task", teardownGraceMs: 0 } as any),
    /teardownGraceMs must be a positive integer/
  );
});

function createMockHerdr(options: {
  repo: string;
  markers: { start: string; end: string };
  initialAgents?: any[];
  markerOutputText?: string;
  pollStatus?: string;
  closeFails?: boolean;
}) {
  let createdPaneId: string | undefined;
  let promptCalled = false;
  const closedPanes: string[] = [];
  const agents = [...(options.initialAgents ?? [])];

  const mockPi = {
    registerTool() {},
    appendEntry() {},
    async exec(command: string, args: string[] = []) {
      if (command === "pi" && args[0] === "--list-models") {
        return { code: 0, stdout: "anthropic/claude-opus-4-8\nanthropic/claude-opus-5\ngoogle/gemini-3.8-flash", stderr: "" };
      }
      assert.equal(command, "herdr");
      if (args[0] === "pane" && args[1] === "current") {
        return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "brain", workspace_id: "ws", tab_id: "tab", cwd: options.repo } } }), stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "split") {
        createdPaneId = "pane-eph-1";
        return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: createdPaneId } } }), stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "run") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "pane" && args[1] === "read") return { code: 0, stdout: "ready", stderr: "" };
      if (args[0] === "agent" && args[1] === "list") {
        const curStatus = promptCalled ? (options.pollStatus ?? "idle") : "idle";
        const list = createdPaneId
          ? [...agents, { name: "scout", pane_id: createdPaneId, workspace_id: "ws", tab_id: "tab", cwd: options.repo, agent_status: curStatus, status: curStatus }]
          : agents;
        return { code: 0, stdout: JSON.stringify({ result: { agents: list } }), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "rename") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "agent" && args[1] === "get") {
        const curStatus = promptCalled ? (options.pollStatus ?? "idle") : "idle";
        return { code: 0, stdout: JSON.stringify({ result: { agent: { name: args[2], pane_id: createdPaneId ?? agents[0]?.pane_id, agent_status: curStatus, status: curStatus } } }), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        promptCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "read") {
        const text = options.markerOutputText !== undefined
          ? `${options.markers.start}\n${options.markerOutputText}\n${options.markers.end}`
          : "working without markers";
        return { code: 0, stdout: text, stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "close") {
        closedPanes.push(args[2]);
        return options.closeFails ? { code: 1, stdout: "", stderr: "pane close failed" } : { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    }
  };

  return { mockPi, closedPanes };
}

test("successful ephemeral run emits spawn log + summary, waits teardownGraceMs, calls pane close exactly once, emits removal log, details.tornDown=true", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-success-"));
  try {
    const markers = buildCrewMarkers("call-eph-success");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: "All checks passed." });
    const updates: any[] = [];
    const delays: number[] = [];

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Check research items",
        ephemeral: true,
        teardownGraceMs: 5000,
        toolCallId: "call-eph-success",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      (u) => updates.push(u),
      undefined,
      async (ms) => { delays.push(ms); }
    );

    assert.equal(result.details.complete, true);
    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.tornDown, true);
    assert.equal(result.details.teardownGraceMs, 5000);
    assert.equal(result.details.removalLogged, true);
    assert.deepEqual(closedPanes, ["pane-eph-1"]);
    assert.ok(delays.includes(5000));

    // Spawn log
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: spawned scout in pane pane-eph-1")));
    // Summary
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: scout completed in pane pane-eph-1. Summary:\nAll checks passed.")));
    // Removal log
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: removed scout pane pane-eph-1 after successful run")));
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ephemeral run where pane close fails retains pane, tornDown=false, warns, and result stays successful", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-closefail-"));
  try {
    const markers = buildCrewMarkers("call-eph-closefail");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: "All checks passed.", closeFails: true });
    const updates: any[] = [];

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Check research items",
        ephemeral: true,
        teardownGraceMs: 5000,
        toolCallId: "call-eph-closefail",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      (u) => updates.push(u),
      undefined,
      async () => {}
    );

    // Teardown failure must not corrupt the successful result
    assert.equal(result.details.complete, true);
    assert.ok(result.content?.[0]?.text?.includes("All checks passed."));
    // Close was attempted but did not succeed
    assert.deepEqual(closedPanes, ["pane-eph-1"]);
    assert.equal(result.details.tornDown, false);
    assert.equal(result.details.removalLogged, false);
    // A teardown-failure warning was logged
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: warning - failed to close pane pane-eph-1")));
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("failure/timeout ephemeral run does NOT close the pane, details.tornDown=false, retention logged", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-fail-"));
  try {
    const markers = buildCrewMarkers("call-eph-fail");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: undefined, pollStatus: "failed" });
    const updates: any[] = [];
    const delays: number[] = [];

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Check research items",
        ephemeral: true,
        timeoutMs: 100,
        toolCallId: "call-eph-fail",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      (u) => updates.push(u),
      undefined,
      async (ms) => { delays.push(ms); }
    );

    assert.equal(result.details.complete, false);
    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.tornDown, false);
    assert.equal(result.details.removalLogged, false);
    assert.deepEqual(closedPanes, []); // Pane close was NEVER called
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: retained scout pane pane-eph-1")));
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ephemeral mode does not reuse an existing pane", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-noreuse-"));
  try {
    const markers = buildCrewMarkers("call-eph-noreuse");
    const initialAgents = [{
      name: "scout",
      pane_id: "pane-existing-scout",
      workspace_id: "ws",
      tab_id: "tab",
      cwd: repo,
      agent_status: "idle",
      status: "idle",
    }];
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, initialAgents, markerOutputText: "OK" });

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Run one-off check",
        ephemeral: true,
        toolCallId: "call-eph-noreuse",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      undefined,
      undefined,
      async () => {}
    );

    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.createdPane, "pane-eph-1");
    assert.equal(result.details.reusedPane, false);
    assert.deepEqual(closedPanes, ["pane-eph-1"]); // closed the created pane, not existing
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("non-ephemeral default is unchanged (no close)", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-noneph-default-"));
  try {
    const markers = buildCrewMarkers("call-noneph-default");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: "Normal output" });

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Normal scout task",
        toolCallId: "call-noneph-default",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      undefined,
      undefined,
      async () => {}
    );

    assert.equal(result.details.complete, true);
    assert.equal(result.details.ephemeral, false);
    assert.equal(result.details.tornDown, false);
    assert.deepEqual(closedPanes, []); // pane close never called
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("teardown of a reused/writer pane is refused/never attempted", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-writer-refused-"));
  try {
    const markers = buildCrewMarkers("call-writer-refused");
    let createdPaneId: string | undefined;
    const closedPanes: string[] = [];

    const mockPi = {
      registerTool() {},
      appendEntry() {},
      async exec(command: string, args: string[] = []) {
        if (command === "pi" && args[0] === "--list-models") {
          return { code: 0, stdout: "anthropic/claude-opus-4-8\nanthropic/claude-opus-5\ngoogle/gemini-3.8-flash", stderr: "" };
        }
        assert.equal(command, "herdr");
        if (args[0] === "pane" && args[1] === "current") {
          return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "brain", workspace_id: "ws", tab_id: "tab", cwd: repo } } }), stderr: "" };
        }
        if (args[0] === "pane" && args[1] === "split") {
          createdPaneId = "pane-writer-1";
          return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: createdPaneId } } }), stderr: "" };
        }
        if (args[0] === "pane" && args[1] === "run") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "pane" && args[1] === "read") return { code: 0, stdout: "ready", stderr: "" };
        if (args[0] === "agent" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify({ result: { agents: [{ name: "executor", pane_id: createdPaneId, workspace_id: "ws", tab_id: "tab", cwd: repo, agent_status: "idle", status: "idle" }] } }), stderr: "" };
        }
        if (args[0] === "agent" && args[1] === "rename") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "agent" && args[1] === "get") {
          return { code: 0, stdout: JSON.stringify({ result: { agent: { name: "executor", pane_id: createdPaneId, agent_status: "idle", status: "idle" } } }), stderr: "" };
        }
        if (args[0] === "agent" && args[1] === "prompt") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: `${markers.start}\nImplemented\n${markers.end}`, stderr: "" };
        }
        if (args[0] === "pane" && args[1] === "close") {
          closedPanes.push(args[2]);
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected herdr call: ${args.join(" ")}`);
      }
    };

    const updates: any[] = [];
    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "executor",
        task: "Implement phase",
        ephemeral: true,
        toolCallId: "call-writer-refused",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      (u) => updates.push(u),
      undefined,
      async () => {}
    );

    assert.equal(result.details.complete, true);
    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.tornDown, false);
    assert.deepEqual(closedPanes, []); // close was NEVER called for writer pane
    assert.ok(updates.some(u => u.content?.[0]?.text?.includes("crew: retained writer pane")));
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ephemeral teardown respects abort signal during grace wait", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-abort-"));
  try {
    const markers = buildCrewMarkers("call-eph-abort");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: "All done" });
    const ac = new AbortController();

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Check research items",
        ephemeral: true,
        teardownGraceMs: 10000,
        toolCallId: "call-eph-abort",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      ac.signal,
      undefined,
      undefined,
      async (_ms, sig) => {
        ac.abort();
        if (sig?.aborted) throw new Error("cancelled");
      }
    );

    assert.equal(result.details.tornDown, true);
    assert.deepEqual(closedPanes, ["pane-eph-1"]); // Teardown still happened cleanly
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ephemeral lifecycle config defaults are respected", async () => {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-eph-config-"));
  try {
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(
      join(repo, ".pi", "model-tiers.json"),
      JSON.stringify({
        lifecycle: { ephemeral: true, teardownGraceMs: 3500 },
      })
    );
    const markers = buildCrewMarkers("call-eph-config");
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, markerOutputText: "Config result" });
    const delays: number[] = [];

    const result = await executeCrewLaunch(
      mockPi as any,
      {
        role: "scout",
        task: "Check research",
        toolCallId: "call-eph-config",
        startupTimeoutMs: 1000,
        startupReadyStableMs: 0,
        configCwd: repo,
      } as any,
      undefined,
      undefined,
      undefined,
      async (ms) => { delays.push(ms); }
    );

    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.teardownGraceMs, 3500);
    assert.equal(result.details.tornDown, true);
    assert.ok(delays.includes(3500));
    assert.deepEqual(closedPanes, ["pane-eph-1"]);
  } finally {
    process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
});
