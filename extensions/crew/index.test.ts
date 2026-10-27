/**
 * @notice Verifies crew launch, completion capture, pane lifecycle, durable coordination, and context-compaction behavior.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  crewLifecycleTimings,
  readCompactionInfo,
  compactionStatusText,
  closeChildPane,
  chooseSplitTarget,
  chooseAgentName,
  observeAgent,
  withSpawnLock,
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
  readSessionCompletion,
  capAnswerText,
  SESSION_ERROR_FINAL_GRACE_MS,
  PROMPT_PICKUP_TIMEOUT_MS,
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
  bindTaskChildSession,
  createReviewBatch,
  deferTaskAttempt,
  discardCorruptArtifact,
  disposeTaskEvidence,
  markWriterRunning,
  recoverTaskAttempt,
  recoverTaskReview,
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
  promoteTaskAttempt,
  publishPhaseContract,
  readCurrentPhase,
  readPhaseCheckpoint,
  readPlanIndex,
  writePlanIndex,
} from "./state.ts";
import { assessPayload, captureSourceSnapshot, contextWarningLevel, normalizeUsage } from "./workflow.ts";
import { herdrObservation, isActiveChild, reconcileChildLaunch } from "./herdr-session.ts";

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

test("Herdr child reconciliation binds sessions monotonically and detects replacement", () => {
  const agent = {
    name: "executor",
    pane_id: "w1:p2",
    workspace_id: "w1",
    tab_id: "w1:t1",
    agent_status: "working",
    state_change_seq: 12,
    revision: 3,
    agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/sessions/2026_session-a.jsonl" },
  };
  const observation = herdrObservation(agent);
  const first = reconcileChildLaunch(undefined, { launchId: "launch-a", role: "executor", ...observation }, "2026-01-01T00:00:00.000Z").record;
  assert.equal(first.controllerStatus, "running");
  assert.equal(first.stateChangeSeq, 12);
  assert.equal(isActiveChild(first), true);
  const stale = reconcileChildLaunch(first, { launchId: "launch-a", role: "executor", status: "idle", stateChangeSeq: 11 }).record;
  assert.equal(stale.controllerStatus, "running");
  const replaced = reconcileChildLaunch(first, {
    launchId: "launch-a", role: "executor", status: "working", paneId: "w1:p2", stateChangeSeq: 13,
    sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: "/sessions/2026_session-b.jsonl" },
  }).record;
  assert.equal(replaced.controllerStatus, "replaced");
  assert.match(replaced.recoveryHint, /Do not attribute/);
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

test("selectLaunchCommand inherits the brain proxy mode", () => {
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE: "1" }), "pic-proxy");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE_HOST: "127.0.0.1" }), "pic-proxy");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE: "1", PIC_PROXY_MODE: "1" }), "pic-proxy");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE: "1", PIC_PROXY_MODE: "0" }), "pic");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE_HOST: "h", PIC_PROXY_MODE: "0" }), "pic");
  assert.equal(selectLaunchCommand({ PIC_PROXY_MODE: "0" }), "pi");
  assert.equal(selectLaunchCommand({ PIC_PROXY_MODE: "1" }), "pi");
  assert.equal(buildRoleCommand("pic", "provider/model"), "pic --approve --model provider/model");
});

test("role bootstrap approves the project before selecting the model and enforces read-only tools", () => {
  assert.equal(buildRoleCommand("pi", "provider/model"), "pi --approve --model provider/model");
  assert.equal(buildRoleCommand("pic-proxy", "provider/model"), "pic-proxy --approve --model provider/model");
  assert.equal(buildRoleCommand("pi"), "pi --approve");
  assert.equal(buildRoleCommand("pi", "provider/model", "read-only"), "pi --approve --tools read,grep,find,ls,crew_publish,crew_read,crew_read_context,self_compact --model provider/model");
  assert.equal(buildRoleCommand("pi", undefined, "read-only"), "pi --approve --tools read,grep,find,ls,crew_publish,crew_read,crew_read_context,self_compact");
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
  assert.match(markers.start, /^CREW_RESULT_START_[0-9a-f]{12}$/);
  assert.match(markers.end, /^CREW_RESULT_END_[0-9a-f]{12}$/);
  assert.deepEqual(buildCrewMarkers("call:a/b"), markers);
  assert.notDeepEqual(buildCrewMarkers("call:a/c"), markers);
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

test("agent naming never reuses a pane: role, then scoped name, then -N suffix", () => {
  const idle = (name: string) => ({ name, pane_id: `pane-${name}`, workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Idle" });
  assert.equal(chooseAgentName([], "scout", "w5", "/repo", "w5:t6"), "scout");
  assert.equal(chooseAgentName([idle("scout")], "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
  assert.equal(chooseAgentName([idle("scout"), idle("scout-w5-t6")], "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6-2");
});

test("agent naming scopes to workspace and tab when base role exists elsewhere", () => {
  const agents = [
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

await regressionTest("polling loop yields to brain on a managed child context request without closing the live pane", async () => {
  let checks = 0;
  const result = await runCrewPollingLoop(
    { roleName: "executor", agentName: "executor-w", paneId: "p1", markers: buildCrewMarkers("context-request"), reusedPane: false, submittedAt: 1000, timeoutMs: 10000, hardCapMs: 30000, readLines: 200 },
    { getAgent: async () => ({ agent_status: "working" }), readOutput: async () => "working", now: () => 1000, delay: async () => {}, shouldYield: async () => { checks++; return true; } }
  );
  assert.equal(checks, 1);
  assert.equal(result.status, "timed_out");
  assert.equal(classifyDelegationResult(result.status, result.markerOutput.mode).agentContinues, true);
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
    await prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "executor", taskId: "task-policy", contractVersion: "v1", baseSha: "a".repeat(40), ownerSessionId: "reuse-owner", runId: first!.access.runId, stateRoot, riskClass: "standard", reviewTiming: "final" });
    await assert.rejects(() => prepareDurableLaunch({ enabled: true, baseCommand: "pi", cwd: repo, role: "executor", taskId: "task-policy", contractVersion: "v1", baseSha: "a".repeat(40), ownerSessionId: "reuse-owner", runId: first!.access.runId, stateRoot }), /risk\/review policy/);
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

await regressionTest("standard attempts defer into one exact review batch and share its verdict", async () => {
  const repo = mkdtempSync(join(tmpdir(), "crew-review-batch-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "crew-review-batch-root-"));
  const baseSha = "1".repeat(40); const headSha = "2".repeat(40); const snapshot = "3".repeat(64);
  try {
    execFileSync("git", ["init", "-q", repo]);
    const owner = await createRunState({ cwd: repo, stateRoot, runId: "run-review-batch" });
    await createTaskAttempt(owner, { taskId: "standard-one", attempt: 1, contractVersion: "v1", baseSha, riskClass: "standard", reviewTiming: "final" });
    await transitionTaskAttempt(owner, "standard-one", 1, "ready", { status: "running" });
    const executor = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "standard-one", attempt: 1 }) };
    const reportId = await beginPublication(executor, { kind: "report", taskId: "standard-one", attempt: 1, contractVersion: "v1", baseSha, headSha, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(executor, reportId, 0, "# Summary\ndone\n## Validation\npass\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(executor, reportId, 1);
    await submitTaskAttempt(owner, "standard-one", 1);
    assert.equal((await deferTaskAttempt(owner, "standard-one", 1)).status, "deferred");

    await createTaskAttempt(owner, { taskId: "standard-two", attempt: 1, contractVersion: "v1", baseSha, riskClass: "standard", reviewTiming: "final" });
    await transitionTaskAttempt(owner, "standard-two", 1, "ready", { status: "running" });
    const executorTwo = { ...owner, token: await createTaskCapability(owner, { role: "executor", taskId: "standard-two", attempt: 1 }) };
    const reportTwo = await beginPublication(executorTwo, { kind: "report", taskId: "standard-two", attempt: 1, contractVersion: "v1", baseSha, headSha, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(executorTwo, reportTwo, 0, "# Summary\ndone two\n## Validation\npass\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(executorTwo, reportTwo, 1);
    await submitTaskAttempt(owner, "standard-two", 1); await deferTaskAttempt(owner, "standard-two", 1);

    await createTaskAttempt(owner, { taskId: "major-one", attempt: 1, contractVersion: "v1", baseSha });
    await transitionTaskAttempt(owner, "major-one", 1, "ready", { status: "submitted" });
    await assert.rejects(() => deferTaskAttempt(owner, "major-one", 1), /Only standard tasks/);
    await createTaskAttempt(owner, { taskId: "promoted-one", attempt: 1, contractVersion: "v1", baseSha, riskClass: "standard", reviewTiming: "final" });
    await transitionTaskAttempt(owner, "promoted-one", 1, "ready", { status: "submitted" });
    const promoted = await promoteTaskAttempt(owner, "promoted-one", 1);
    assert.equal(promoted.riskClass, "major"); assert.equal(promoted.reviewTiming, "immediate");
    await assert.rejects(() => deferTaskAttempt(owner, "promoted-one", 1), /Only standard tasks/);
    await bindTaskChildSession(owner, "major-one", 1, { launchId: "launch-major", agentName: "executor", paneId: "w1:p2", stateChangeSeq: 4, herdrStatus: "working", observedAt: new Date().toISOString() });
    await assert.rejects(() => bindTaskChildSession(owner, "major-one", 1, { launchId: "launch-major", agentName: "executor", paneId: "w1:p2", stateChangeSeq: 3, observedAt: new Date().toISOString() }), /sequence regressed/);
    await assert.rejects(() => bindTaskChildSession(owner, "major-one", 1, { launchId: "launch-major", agentName: "executor", paneId: "w1:p3", stateChangeSeq: 5, observedAt: new Date().toISOString() }), /identity changed/);
    await transitionTaskAttempt(owner, "major-one", 1, "submitted", { status: "reviewing" });
    await assert.rejects(() => recoverTaskReview(owner, "major-one", 1, false, "not proven"), /not been proven inactive/);
    const resetReview = await recoverTaskReview(owner, "major-one", 1, true, "reviewer pane disappeared");
    assert.equal(resetReview.status, "submitted"); assert.equal(resetReview.childSession, undefined);

    const manifestId = await beginPublication(owner, { kind: "report", taskId: "final-batch", attempt: 1, contractVersion: "batch-v1", baseSha, headSha, sourceSnapshotId: snapshot, requiredSections: ["Summary", "Validation", "Assumptions", "Risks"] });
    await appendPublicationChunk(owner, manifestId, 0, "# Summary\nstandard-one\nstandard-two\n## Validation\nmember reports linked\n## Assumptions\nnone\n## Risks\nnone\n");
    await finalizePublication(owner, manifestId, 1);
    await assert.rejects(() => createReviewBatch(owner, { taskId: "duplicate-batch", contractVersion: "batch-v1", baseSha, headSha, sourcePaths: ["source.ts"], sourceSnapshotId: snapshot, reportArtifactId: manifestId, members: [{ taskId: "standard-one", attempt: 1 }, { taskId: "standard-one", attempt: 1 }] }), /Duplicate review batch member/);
    const batch = await createReviewBatch(owner, { taskId: "final-batch", contractVersion: "batch-v1", baseSha, headSha, sourcePaths: ["source.ts"], sourceSnapshotId: snapshot, reportArtifactId: manifestId, members: [{ taskId: "standard-one", attempt: 1 }, { taskId: "standard-two", attempt: 1 }] });
    assert.equal(batch.status, "submitted"); assert.equal(batch.taskKind, "review-batch");
    await beginTaskReview(owner, "final-batch", 1);
    const reviewer = { ...owner, token: await createTaskCapability(owner, { role: "reviewer", taskId: "final-batch", attempt: 1 }) };
    const reviewId = await beginPublication(reviewer, { kind: "review", verdict: "PASS", taskId: "final-batch", attempt: 1, contractVersion: "batch-v1", baseSha, headSha, sourceSnapshotId: snapshot, requiredSections: ["Verdict", "Findings", "Validation"] });
    await appendPublicationChunk(reviewer, reviewId, 0, "# Verdict\nPASS\n## Findings\nnone\n## Validation\nbatch reviewed\n");
    await finalizePublication(reviewer, reviewId, 1);
    // Simulate a stopped process after one member write but before the batch write.
    await transitionTaskAttempt(owner, "standard-one", 1, "deferred", { status: "approved", reviewArtifactId: reviewId });
    assert.equal((await completeTaskReview(owner, "final-batch", 1)).status, "approved");
    const approvedMember = await readTaskAttempt(owner, "standard-one", 1);
    const approvedMemberTwo = await readTaskAttempt(owner, "standard-two", 1);
    assert.equal(approvedMember.status, "approved"); assert.equal(approvedMember.reviewArtifactId, reviewId);
    assert.equal(approvedMemberTwo.status, "approved"); assert.equal(approvedMemberTwo.reviewArtifactId, reviewId);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); }
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
    assert.equal(current.index.phases[0].riskClass, "major", "legacy plan entries default to immediate major review");
    assert.match(current.contract, /Preserve blockers/);
    await assert.rejects(() => writePlanIndex(access, { revision: 2, currentPhaseId: "r3", phases: [{ id: "r2", summary: "Bound context", status: "implemented", contractVersion: "v1", riskClass: "standard", reviewTiming: "immediate" }, { id: "r3", summary: "Models", status: "current", contractVersion: "v1" }] }), /inconsistent risk/);
    await writePlanIndex(access, { revision: 2, currentPhaseId: "r3", phases: [{ id: "r2", summary: "Bound context", status: "implemented", contractVersion: "v1", riskClass: "standard", reviewTiming: "final" }, { id: "r3", summary: "Models", status: "current", contractVersion: "v1", riskClass: "major", reviewTiming: "immediate" }] });
    await assert.rejects(() => publishPhaseContract(access, "r2", "v1", "overwrite"), /EEXIST/);
    const snapshot = "a".repeat(64);
    const checkpoint = await createPhaseCheckpoint(access, { phaseId: "r2", contractVersion: "v1", sourceSnapshotId: snapshot, summary: "R2 passed", decisions: ["fresh sessions"], remainingPhaseIds: ["r3"], unresolvedBlockerIds: ["finding-1"], approvalState: "approved", evidenceArtifactIds: [] });
    assert.equal((await readPhaseCheckpoint(access, "r2")).unresolvedBlockerIds[0], "finding-1");
    assert.equal(checkpoint.approvalState, "approved");
    assert.equal((await readPlanIndex(access)).revision, 2);
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
    frontier: "anthropic/claude-opus-5-5",
    medium: "anthropic/claude-sonnet-5-5",
    small: "anthropic/claude-sonnet-5-5",
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
      reviewer: ["frontier", "xhigh", "read-only"],
    }
  );

  // resolveRole resolves tiers to concrete Opus5.5/Sonnet5.5 + correct reasoning:
  const scoutRole = resolveRole("scout", permanent);
  assert.equal(scoutRole.model, "anthropic/claude-sonnet-5-5");
  assert.equal(scoutRole.reasoning, "medium");
  assert.equal(scoutRole.effort, "medium");
  assert.equal(scoutRole.tier, "medium");

  const oracleRole = resolveRole("oracle", permanent);
  assert.equal(oracleRole.model, "anthropic/claude-opus-5-5");
  assert.equal(oracleRole.reasoning, "xhigh");

  const executorRole = resolveRole("executor", permanent);
  assert.equal(executorRole.model, "anthropic/claude-sonnet-5-5");
  assert.equal(executorRole.reasoning, "medium");
  assert.throws(() => resolveRole("executor-escalation", permanent), /Unknown crew role/);

  const reviewerRole = resolveRole("reviewer", permanent);
  assert.equal(reviewerRole.model, "anthropic/claude-opus-5-5");
  assert.equal(reviewerRole.reasoning, "xhigh");

  // Parallel review agent resolution:
  const reviewTiers = permanent.parallelCodeReview;
  assert.deepEqual(reviewTiers.synthesis, { model: "medium", reasoning: "medium" });
  assert.equal(reviewTiers.testRunner.reasoning, "low");
  const resolvedSynthesis = resolveParallelReviewAgent("synthesis", permanent);
  assert.equal(resolvedSynthesis.model, "anthropic/claude-sonnet-5-5");
  assert.equal(resolvedSynthesis.reasoning, "medium");
  const resolvedTestRunner = resolveParallelReviewAgent("testRunner", permanent);
  assert.equal(resolvedTestRunner.model, "anthropic/claude-sonnet-5-5");
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
  assert.equal(contextWarningLevel(199999), "none"); assert.equal(contextWarningLevel(200000), "warn"); assert.equal(contextWarningLevel(170000, "warn"), "warn"); assert.equal(contextWarningLevel(149999, "warn"), "none"); assert.equal(contextWarningLevel(500000), "checkpoint"); assert.equal(contextWarningLevel(460000, "checkpoint"), "checkpoint"); assert.equal(contextWarningLevel(40000, "none", 200000), "warn"); assert.equal(contextWarningLevel(100000, "none", 200000), "checkpoint");
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
  sessionPath?: string;
  agentReadText?: string;
  agentExitsAfterPrompt?: boolean;
}) {
  let createdPaneId: string | undefined;
  let promptCalled = false;
  const closedPanes: string[] = [];
  const agents = [...(options.initialAgents ?? [])];
  const sessionField = options.sessionPath ? { agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: options.sessionPath } } : {};
  const exited = () => !!options.agentExitsAfterPrompt && promptCalled;

  const mockPi = {
    registerTool() {},
    appendEntry() {},
    async exec(command: string, args: string[] = []) {
      if (command === "pi" && args[0] === "--list-models") {
        return { code: 0, stdout: "anthropic/claude-sonnet-5-5\nanthropic/claude-opus-5-5\ngoogle/gemini-3.8-flash", stderr: "" };
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
      if (args[0] === "pane" && args[1] === "read") return exited() ? { code: 1, stdout: "", stderr: "pane_not_found" } : { code: 0, stdout: "ready", stderr: "" };
      if (args[0] === "agent" && args[1] === "list") {
        const curStatus = promptCalled ? (options.pollStatus ?? "idle") : "idle";
        const list = createdPaneId && !exited()
          ? [...agents, { name: "scout", pane_id: createdPaneId, workspace_id: "ws", tab_id: "tab", cwd: options.repo, agent_status: curStatus, status: curStatus, ...sessionField }]
          : agents;
        return { code: 0, stdout: JSON.stringify({ result: { agents: list } }), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "rename") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "agent" && args[1] === "wait") return { code: 1, stdout: "", stderr: "unsupported" };
      if (args[0] === "agent" && args[1] === "get") {
        if (exited()) return { code: 1, stdout: "", stderr: "agent_not_found" };
        const curStatus = promptCalled ? (options.pollStatus ?? "idle") : "idle";
        return { code: 0, stdout: JSON.stringify({ result: { agent: { name: args[2], pane_id: createdPaneId ?? agents[0]?.pane_id, agent_status: curStatus, status: curStatus, ...sessionField } } }), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        promptCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "read") {
        if (exited()) return { code: 1, stdout: "", stderr: "pane_not_found" };
        if (options.agentReadText !== undefined) return { code: 0, stdout: options.agentReadText, stderr: "" };
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

// ---- Phase C: child pane lifecycle -------------------------------------------------------------

type FakePane = { name: string; status: string; session: string; terminal?: string; workingLeft?: number; gone?: boolean; answer?: string; markers?: { start: string; end: string } };

/** In-memory Herdr fake: panes, renames (with injectable collisions), prompts, /quit, and pane close. */
function createFakeHerdr(options: { repo: string; panes?: Record<string, Partial<FakePane>>; collideRenames?: number; renameError?: string; startupStatus?: string; noMarkers?: boolean; quitNeverExits?: boolean; sessionDir?: string; workingPolls?: number; onRun?: () => void }) {
  const panes = new Map<string, FakePane>();
  for (const [id, pane] of Object.entries(options.panes ?? {})) panes.set(id, { name: id, status: "idle", session: `/sessions/${id}.jsonl`, terminal: `term-${id}`, ...pane });
  const calls: string[][] = [];
  const closed: string[] = [];
  const quits: string[] = [];
  const prompts: string[] = [];
  const entries: { type: string; data: any }[] = [];
  const splits: string[][] = [];
  const realRepo = realpathSync(options.repo);
  let counter = 0;
  let collisions = options.collideRenames ?? 0;
  const agentList = () => [...panes.entries()].filter(([, pane]) => !pane.gone).map(([id, pane]) => ({
    name: pane.name, pane_id: id, terminal_id: pane.terminal, workspace_id: "ws", tab_id: "tab", cwd: realRepo, foreground_cwd: realRepo,
    agent_status: pane.status, status: pane.status, agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: pane.session },
  }));
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const pi = {
    registerTool() {},
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
    async exec(command: string, args: string[] = []) {
      if (command === "pi" && args[0] === "--list-models") return ok("anthropic/claude-sonnet-5-5");
      assert.equal(command, "herdr");
      calls.push(args);
      await tick();
      const [a, b] = args;
      if (a === "pane" && b === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "brain", workspace_id: "ws", tab_id: "tab", cwd: options.repo } } }));
      if (a === "pane" && b === "split") {
        splits.push(args);
        counter += 1;
        const id = `pane-new-${counter}`;
        panes.set(id, { name: `pi-${counter}`, status: options.startupStatus ?? "idle", session: `${options.sessionDir ?? "/sessions"}/${id}.jsonl`, terminal: `term-${id}`, workingLeft: 0 });
        return ok(JSON.stringify({ result: { pane: { pane_id: id } } }));
      }
      if (a === "pane" && b === "get") {
        const pane = panes.get(args[2]);
        return pane ? ok(JSON.stringify({ result: { pane: { pane_id: args[2], terminal_id: pane.terminal } } })) : fail('{"error":{"code":"pane_not_found"}}');
      }
      if (a === "pane" && b === "run") { options.onRun?.(); return ok(); }
      if (a === "pane" && b === "read") return ok("ready");
      if (a === "pane" && b === "close") {
        if (!panes.has(args[2])) return fail('{"error":{"code":"pane_not_found"}}');
        closed.push(args[2]); panes.delete(args[2]); return ok();
      }
      if (a === "agent" && b === "list") return ok(JSON.stringify({ result: { agents: agentList() } }));
      if (a === "agent" && b === "get") {
        const found = agentList().find(agent => agent.name === args[2]);
        const holder = panes.get(found?.pane_id ?? "");
        if (found && holder?.workingLeft) { holder.workingLeft -= 1; found.agent_status = "working"; found.status = "working"; }
        return found ? ok(JSON.stringify({ result: { agent: found } })) : fail('{"error":{"code":"agent_not_found"}}');
      }
      if (a === "agent" && b === "wait") return fail("unsupported");
      if (a === "agent" && b === "rename") {
        if (options.renameError) return fail(options.renameError);
        const [, , paneId, name] = args;
        if (collisions > 0 || [...panes.values()].some(pane => pane.name === name && !pane.gone)) {
          if (collisions > 0) { collisions -= 1; panes.set(`foreign-${name}`, { name, status: "idle", session: `/sessions/foreign-${name}.jsonl` }); }
          return fail('{"error":{"code":"agent_name_taken"}}');
        }
        panes.get(paneId)!.name = name;
        return ok();
      }
      if (a === "agent" && b === "prompt") {
        const entry = [...panes.entries()].find(([, pane]) => pane.name === args[2] && !pane.gone);
        if (!entry) return fail('{"error":{"code":"agent_not_found"}}');
        if (args[3] === "/quit") { quits.push(args[2]); if (!options.quitNeverExits) entry[1].gone = true; return ok(); }
        prompts.push(args[2]);
        entry[1].workingLeft = options.workingPolls ?? 0;
        if (options.sessionDir) writeFileSync(entry[1].session, `${JSON.stringify({ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: args[3] }] } })}\n`);
        const start = /CREW_RESULT_START_[0-9a-f]+/.exec(args[3])?.[0]; const end = /CREW_RESULT_END_[0-9a-f]+/.exec(args[3])?.[0];
        entry[1].markers = start && end ? { start, end } : undefined;
        entry[1].answer = `answer from ${args[2]}`;
        entry[1].status = options.noMarkers ? "failed" : "idle";
        return ok();
      }
      if (a === "agent" && b === "read") {
        const pane = [...panes.values()].find(item => item.name === args[2] && !item.gone);
        if (!pane) return fail("agent_not_found");
        return ok(pane.markers && !options.noMarkers ? `${pane.markers.start}\n${pane.answer}\n${pane.markers.end}` : "working without markers");
      }
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    },
  };
  return { pi, panes, calls, closed, quits, prompts, entries, splits };
}

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
};
const settleMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withHerdrRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-lifecycle-"));
  try { return await fn(repo); }
  finally {
    if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
    rmSync(repo, { recursive: true, force: true });
  }
}

const launchParams = (repo: string, extra: Record<string, unknown> = {}) => ({
  role: "scout", task: "Check the research items thoroughly and report the findings", startupTimeoutMs: 1000, startupReadyStableMs: 0, configCwd: repo, ...extra,
});

/** Boots the extension against a fake Herdr and returns handlers to drive tool calls and events. */
async function bootExtension(fake: ReturnType<typeof createFakeHerdr>, repo: string, branch: any[] = []) {
  const tools = new Map<string, any>();
  const events = new Map<string, any[]>();
  crewExtension({
    exec: fake.pi.exec, appendEntry: fake.pi.appendEntry,
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
  } as any);
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => "brain-session", getBranch: () => branch }, ui: { setStatus() {} } };
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
  const emit = async (name: string, event: any) => { for (const handler of events.get(name) ?? []) await handler(event, ctx); };
  const launch = (toolCallId: string, extra: Record<string, unknown> = {}) => tools.get("crew_launch").execute(toolCallId, launchParams(repo, extra), undefined, undefined, ctx);
  return { tools, emit, launch, ctx };
}

await regressionTest("no pane reuse: an idle same-role agent is never reused and names are unique", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo, panes: { "pane-old": { name: "scout", status: "idle" } } });
    const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "nr-1" } as any);
    assert.equal(result.details.reusedPane, false);
    assert.equal(result.details.createdPane, "pane-new-1");
    assert.equal(result.details.agentName, "scout-ws-tab");
    assert.deepEqual(fake.prompts, ["scout-ws-tab"]);
    assert.equal(fake.panes.get("pane-old")!.name, "scout");
  });
});

await regressionTest("concurrent launches are serialized per tab: second splits below the first's renamed pane with a distinct name", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo });
    const [first, second] = await Promise.all([
      executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "cc-1" } as any),
      executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "cc-2" } as any),
    ]);
    assert.notEqual(first.details.agentName, second.details.agentName);
    assert.equal(fake.splits.length, 2);
    assert.ok(fake.splits[0].includes("--current"));
    assert.deepEqual(fake.splits[1].slice(0, 5), ["pane", "split", "pane-new-1", "--direction", "down"]);
    assert.equal(first.details.complete, true);
    assert.equal(second.details.complete, true);
    // Prompting is outside the lock: both prompts happened and neither pane was closed by the tool call.
    assert.equal(fake.prompts.length, 2);
    assert.deepEqual(fake.closed, []);
  });
});

await regressionTest("rename collisions re-list and re-choose a free name (up to 5 attempts)", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo, collideRenames: 2 });
    const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "rc-1" } as any);
    assert.equal(result.details.agentName, "scout-ws-tab-2");
    assert.equal(result.details.renameConflictRecovered, true);
    assert.equal(result.details.complete, true);
    assert.deepEqual(fake.closed, []);
  });
});

await regressionTest("final rename failure and post-split spawn errors close the never-prompted pane", async () => {
  await withHerdrRepo(async (repo) => {
    const exhausted = createFakeHerdr({ repo, collideRenames: 99 });
    await assert.rejects(() => executeCrewLaunch(exhausted.pi as any, { ...launchParams(repo), toolCallId: "rf-1" } as any), /agent rename failed/);
    assert.deepEqual(exhausted.closed, ["pane-new-1"]);
    assert.deepEqual(exhausted.prompts, []);
    assert.equal(exhausted.calls.filter(c => c[0] === "agent" && c[1] === "rename").length, 5);

    const broken = createFakeHerdr({ repo, renameError: "boom" });
    await assert.rejects(() => executeCrewLaunch(broken.pi as any, { ...launchParams(repo), toolCallId: "rf-2" } as any), /agent rename failed/);
    assert.deepEqual(broken.closed, ["pane-new-1"]);
  });
});

await regressionTest("startup timeout keeps the pane for inspection", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo, startupStatus: "working" });
    await assert.rejects(() => executeCrewLaunch(fake.pi as any, { ...launchParams(repo, { startupTimeoutMs: 150 }), toolCallId: "st-1" } as any), /not ready/);
    assert.deepEqual(fake.closed, []);
  });
});

await regressionTest("ephemeral defaults to true; result carries a pending close but the tool call itself never delays or closes", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo });
    const delays: number[] = [];
    const updates: any[] = [];
    const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "pd-1" } as any, undefined, u => updates.push(u), undefined, async (ms) => { delays.push(ms); });
    assert.equal(result.details.ephemeral, true);
    assert.equal(result.details.tornDown, false);
    assert.equal(result.details.teardownGraceMs, 5000);
    assert.ok(!delays.includes(5000));
    assert.deepEqual(fake.closed, []);
    assert.deepEqual(fake.quits, []);
    assert.equal(result.details.pendingClose.paneId, "pane-new-1");
    assert.equal(result.details.pendingClose.agentName, "scout");
    assert.equal(result.details.pendingClose.delayMs, 5000);
    assert.equal(result.details.pendingClose.sessionValue, "/sessions/pane-new-1.jsonl");
    const optOut = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo, { ephemeral: false }), toolCallId: "pd-2" } as any);
    assert.equal(optOut.details.pendingClose, null);
  });
});

await regressionTest("deferred close: nothing closes until the toolResult message_end, then /quit precedes pane close; duplicate events are deduplicated", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo });
    const ext = await bootExtension(fake, repo);
    const result = await ext.launch("tc-deferred", { teardownGraceMs: 30 });
    assert.equal(result.details.complete, true);
    await settleMs(80);
    assert.deepEqual(fake.closed, []);
    assert.deepEqual(fake.quits, []);
    await ext.emit("message_end", { message: { role: "toolResult", toolCallId: "other-call", toolName: "crew_launch" } });
    await settleMs(60);
    assert.deepEqual(fake.closed, []);
    await ext.emit("message_end", { message: { role: "toolResult", toolCallId: "tc-deferred", toolName: "crew_launch" } });
    await ext.emit("tool_execution_end", { toolCallId: "tc-deferred", toolName: "crew_launch", isError: false });
    await waitFor(() => fake.closed.length > 0);
    await settleMs(80);
    assert.deepEqual(fake.quits, ["scout"]);
    assert.deepEqual(fake.closed, ["pane-new-1"]);
    const order = fake.calls.filter(c => (c[0] === "agent" && c[1] === "prompt" && c[3] === "/quit") || (c[0] === "pane" && c[1] === "close")).map(c => c[1]);
    assert.deepEqual(order, ["prompt", "close"]);
    const removal = fake.entries.find(e => e.type === "crew-lifecycle" && e.data.action === "remove");
    assert.ok(removal);
    const record = [...fake.entries].reverse().find(e => e.type === "crew-child-lifecycle" && e.data.paneClosedAt);
    assert.ok(record, "child record is updated with paneClosedAt");
  });
});

await regressionTest("deferred close: tool_execution_end is only a fallback after the delivery window, and is deduplicated against message_end", async () => {
  await withHerdrRepo(async (repo) => {
    const savedFallback = crewLifecycleTimings.deliveryFallbackMs;
    crewLifecycleTimings.deliveryFallbackMs = 120;
    try {
      const fake = createFakeHerdr({ repo });
      const ext = await bootExtension(fake, repo);
      await ext.launch("tc-fallback", { teardownGraceMs: 10 });
      await ext.emit("tool_execution_end", { toolCallId: "tc-fallback", toolName: "crew_launch", isError: false });
      await settleMs(60);
      assert.deepEqual(fake.closed, [], "no close before the fallback window elapses");
      await waitFor(() => fake.closed.length > 0);
      assert.deepEqual(fake.closed, ["pane-new-1"]);

      // message_end after tool_execution_end preempts the fallback and closes exactly once.
      const second = createFakeHerdr({ repo });
      const ext2 = await bootExtension(second, repo);
      await ext2.launch("tc-fallback-2", { teardownGraceMs: 10 });
      await ext2.emit("tool_execution_end", { toolCallId: "tc-fallback-2", toolName: "crew_launch", isError: false });
      await ext2.emit("message_end", { message: { role: "toolResult", toolCallId: "tc-fallback-2" } });
      await waitFor(() => second.closed.length > 0);
      await settleMs(200);
      assert.deepEqual(second.closed, ["pane-new-1"]);
      assert.deepEqual(second.quits, ["scout"]);
    } finally { crewLifecycleTimings.deliveryFallbackMs = savedFallback; }
  });
});

await regressionTest("deferred close: identity checks skip a replaced session, a working agent, or a different agent", async () => {
  await withHerdrRepo(async (repo) => {
    const cases: [string, (fake: ReturnType<typeof createFakeHerdr>) => void, string][] = [
      ["session", fake => { fake.panes.get("pane-new-1")!.session = "/sessions/other.jsonl"; }, "session-mismatch"],
      ["working", fake => { fake.panes.get("pane-new-1")!.status = "working"; }, "status-working"],
      ["agent", fake => { fake.panes.get("pane-new-1")!.name = "someone-else"; }, "different-agent-in-pane"],
    ];
    for (const [label, mutate, reason] of cases) {
      const fake = createFakeHerdr({ repo });
      const ext = await bootExtension(fake, repo);
      await ext.launch(`tc-skip-${label}`, { teardownGraceMs: 10 });
      mutate(fake);
      await ext.emit("message_end", { message: { role: "toolResult", toolCallId: `tc-skip-${label}` } });
      await waitFor(() => fake.entries.some(e => e.data?.action === "close-skipped"));
      assert.deepEqual(fake.closed, [], label);
      assert.deepEqual(fake.quits, [], label);
      assert.equal(fake.entries.find(e => e.data?.action === "close-skipped")!.data.reason, reason);
    }
  });
});

await regressionTest("deferred close: a writer (executor) pane is closed too, and an exited-but-present pane tolerates pane_not_found", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo });
    const ext = await bootExtension(fake, repo);
    const result = await ext.launch("tc-writer", { role: "executor", teardownGraceMs: 10 });
    assert.equal(result.details.authority, "can-edit");
    assert.equal(result.details.complete, true);
    await ext.emit("message_end", { message: { role: "toolResult", toolCallId: "tc-writer" } });
    await waitFor(() => fake.closed.length > 0);
    assert.deepEqual(fake.closed, ["pane-new-1"]);

    // Agent already gone and pane already closed: close tolerates pane_not_found.
    const gone = createFakeHerdr({ repo, panes: {} });
    const outcome = await closeChildPane(gone.pi as any, { agentName: "scout", paneId: "pane-missing", terminalId: "term-pane-missing" });
    assert.deepEqual(outcome, { closed: true });
    // Without a recorded terminal_id an absent agent can never be proven: never close.
    assert.deepEqual(await closeChildPane(gone.pi as any, { agentName: "scout", paneId: "pane-missing" }), { closed: false, skipped: "agent-absent-identity-unproven" });
  });
});

await regressionTest("deferred close: an incomplete launch is retained and never scheduled", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo, noMarkers: true });
    const ext = await bootExtension(fake, repo);
    const result = await ext.launch("tc-incomplete", { teardownGraceMs: 10, timeoutMs: 100 });
    assert.equal(result.details.complete, false);
    assert.equal(result.details.pendingClose, null);
    await ext.emit("message_end", { message: { role: "toolResult", toolCallId: "tc-incomplete" } });
    await settleMs(80);
    assert.deepEqual(fake.closed, []);
    assert.deepEqual(fake.quits, []);
    assert.ok(fake.entries.some(e => e.data?.action === "retain"));
  });
});

await regressionTest("close that cannot quit gracefully keeps the pane and logs", async () => {
  await withHerdrRepo(async (repo) => {
    const saved = { ...crewLifecycleTimings };
    crewLifecycleTimings.quitTimeoutMs = 60; crewLifecycleTimings.quitPollMs = 10;
    try {
      const fake = createFakeHerdr({ repo, quitNeverExits: true, panes: { "pane-x": { name: "scout" } } });
      const outcome = await closeChildPane(fake.pi as any, { agentName: "scout", paneId: "pane-x" });
      assert.deepEqual(outcome, { closed: false, skipped: "quit-timeout" });
      assert.deepEqual(fake.closed, []);
    } finally { Object.assign(crewLifecycleTimings, saved); }
  });
});

await regressionTest("stale sweep closes only recorded, completed, ephemeral, unclosed children with matching identity", async () => {
  await withHerdrRepo(async (repo) => {
    const saved = { ...crewLifecycleTimings };
    crewLifecycleTimings.sweepDelayMs = 20;
    try {
      const base = { role: "scout", controllerStatus: "settled", herdrStatus: "idle", complete: true, agentContinues: false, ephemeral: true, startedAt: new Date().toISOString(), observedAt: new Date().toISOString(), lastProgressAt: new Date().toISOString(), recoveryHint: "" };
      const rec = (id: string, extra: Record<string, unknown>) => ({ type: "custom", customType: "crew-child-lifecycle", data: { ...base, launchId: id, agentName: `agent-${id}`, paneId: `pane-${id}`, terminalId: `term-pane-${id}`, sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: `/sessions/pane-${id}.jsonl` }, ...extra } });
      const branch = [
        rec("stale", {}),
        rec("closed", { paneClosedAt: "2026-01-01T00:00:02.000Z" }),
        rec("legacy", { ephemeral: undefined }),
        rec("incomplete", { complete: false }),
        rec("nopane", { paneId: undefined }),
        rec("replaced", { sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: "/sessions/older.jsonl" } }),
      ];
      const panes: Record<string, Partial<FakePane>> = {};
      for (const id of ["stale", "closed", "legacy", "incomplete", "replaced"]) panes[`pane-${id}`] = { name: `agent-${id}`, session: `/sessions/pane-${id}.jsonl` };
      panes["pane-user"] = { name: "user-agent" };
      const fake = createFakeHerdr({ repo, panes });
      await bootExtension(fake, repo, branch);
      await waitFor(() => fake.closed.length > 0);
      await settleMs(150);
      assert.deepEqual(fake.closed, ["pane-stale"]);
      assert.deepEqual(fake.quits, ["agent-stale"]);
      assert.ok(fake.entries.some(e => e.data?.action === "close-skipped" && e.data.launchId === "replaced"));
    } finally { Object.assign(crewLifecycleTimings, saved); }
  });
});

await regressionTest("sweep with the agent absent: foreign pane under the same pane id is never closed; proven terminal_id is closed without /quit", async () => {
  await withHerdrRepo(async (repo) => {
    const saved = { ...crewLifecycleTimings };
    crewLifecycleTimings.sweepDelayMs = 20;
    try {
      const base = { role: "scout", controllerStatus: "settled", herdrStatus: "idle", complete: true, agentContinues: false, ephemeral: true, startedAt: new Date().toISOString(), observedAt: new Date().toISOString(), lastProgressAt: new Date().toISOString(), recoveryHint: "" };
      const rec = (id: string, extra: Record<string, unknown>) => ({ type: "custom", customType: "crew-child-lifecycle", data: { ...base, launchId: id, agentName: `agent-${id}`, paneId: `pane-${id}`, ...extra } });
      const branch = [
        rec("foreign", { terminalId: "term-original" }),
        rec("proven", { terminalId: "term-pane-proven" }),
        rec("noterm", {}),
        rec("old", { terminalId: "term-pane-old", startedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }),
      ];
      // Agents are absent: the panes hold no named agent (agent list is empty via gone), only a shell terminal.
      const fake = createFakeHerdr({ repo, panes: {
        "pane-foreign": { name: "shell", gone: true, terminal: "term-reused-by-user" },
        "pane-proven": { name: "shell", gone: true },
        "pane-noterm": { name: "shell", gone: true },
        "pane-old": { name: "shell", gone: true },
      } });
      await bootExtension(fake, repo, branch);
      await waitFor(() => fake.closed.length > 0);
      await settleMs(150);
      assert.deepEqual(fake.closed, ["pane-proven"]);
      assert.deepEqual(fake.quits, []);
      const skips = fake.entries.filter(e => e.data?.action === "close-skipped").map(e => `${e.data.launchId}:${e.data.reason}`).sort();
      assert.deepEqual(skips, ["foreign:agent-absent-identity-unproven", "noterm:agent-absent-identity-unproven"]);
      // The skip is recorded so later sweeps do not retry it.
      assert.ok(fake.entries.some(e => e.type === "crew-child-lifecycle" && e.data.launchId === "foreign" && e.data.closeSkippedReason === "agent-absent-identity-unproven"));
    } finally { Object.assign(crewLifecycleTimings, saved); }
  });
});

await regressionTest("sweep skips records whose last close was skipped for identity reasons", async () => {
  await withHerdrRepo(async (repo) => {
    const saved = { ...crewLifecycleTimings };
    crewLifecycleTimings.sweepDelayMs = 20;
    try {
      const now = new Date().toISOString();
      const data = { launchId: "skipped", role: "scout", agentName: "agent-skipped", paneId: "pane-skipped", terminalId: "term-pane-skipped", closeSkippedReason: "status-working", controllerStatus: "settled", herdrStatus: "idle", complete: true, agentContinues: false, ephemeral: true, startedAt: now, observedAt: now, lastProgressAt: now, recoveryHint: "" };
      const fake = createFakeHerdr({ repo, panes: { "pane-skipped": { name: "agent-skipped", session: "/sessions/x.jsonl" } } });
      await bootExtension(fake, repo, [{ type: "custom", customType: "crew-child-lifecycle", data }]);
      await settleMs(200);
      assert.deepEqual(fake.closed, []);
      assert.deepEqual(fake.quits, []);
    } finally { Object.assign(crewLifecycleTimings, saved); }
  });
});

await regressionTest("closeChildPane refuses an agent whose terminal_id differs from the recorded one", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo, panes: { "pane-x": { name: "scout", terminal: "term-other" } } });
    assert.deepEqual(await closeChildPane(fake.pi as any, { agentName: "scout", paneId: "pane-x", terminalId: "term-mine" }), { closed: false, skipped: "terminal-mismatch" });
    assert.deepEqual(fake.closed, []);
  });
});

await regressionTest("a launch records the spawned pane's terminal_id and it reaches the pending close", async () => {
  await withHerdrRepo(async (repo) => {
    const fake = createFakeHerdr({ repo });
    const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "term-1" } as any);
    assert.equal(result.details.terminalId, "term-pane-new-1");
    assert.equal(result.details.pendingClose?.terminalId, "term-pane-new-1");
  });
});

await regressionTest("polling 6a: a transient agent lookup error is unknown, not an exit; only not-found means missing", async () => {
  const m = buildCrewMarkers("poll-6a-get");
  let t = 1_000_000;
  let gets = 0;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => { gets += 1; if (gets < 6) throw new Error("bridge hiccup"); return { agent_status: "idle" }; },
      readOutput: async () => `${m.start}\nok\n${m.end}`,
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.agentExited, false);
  // observeAgent classification with a fake bridge.
  const exec = (get: { code: number; stderr: string }, list: { code: number; stderr: string; stdout?: string }) => ({
    async exec(_c: string, args: string[]) {
      if (args[1] === "get") return { code: get.code, stdout: "", stderr: get.stderr };
      return { code: list.code, stdout: list.stdout ?? JSON.stringify({ result: { agents: [] } }), stderr: list.stderr };
    },
  });
  assert.equal((await observeAgent(exec({ code: 1, stderr: "socket timeout" }, { code: 1, stderr: "socket timeout" }) as any, "a")).state, "unknown");
  assert.equal((await observeAgent(exec({ code: 1, stderr: "socket timeout" }, { code: 0, stderr: "" }) as any, "a")).state, "missing");
  assert.equal((await observeAgent(exec({ code: 1, stderr: "agent_not_found" }, { code: 1, stderr: "boom" }) as any, "a")).state, "unknown");
  assert.equal((await observeAgent(exec({ code: 1, stderr: "agent_not_found" }, { code: 0, stderr: "" }) as any, "a")).state, "missing");
});

await regressionTest("post-loop session veto: settled loop exit with an unfinished session is incomplete and the agent continues", async () => {
  await withHerdrRepo(async (repo) => {
    const dir = mkdtempSync(join(tmpdir(), "crew-veto-"));
    try {
      const fake = createFakeHerdr({ repo, sessionDir: dir, workingPolls: 1 });
      const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "veto-1", timeoutMs: 5000 } as any, undefined, undefined, undefined, async () => {});
      assert.equal(result.details.complete, false);
      assert.equal(result.details.agentContinues, true);
      assert.equal(result.details.pendingClose, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

await regressionTest("cancellation: a launch waiting for the spawn lock releases it promptly and never prompts or spawns", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = withSpawnLock("k", () => new Promise<void>(resolve => { releaseFirst = resolve; order.push("first"); }));
  await settleMs(5);
  const controller = new AbortController();
  const second = withSpawnLock("k", async () => { order.push("second"); }, controller.signal);
  const secondResult = second.then(() => "ran", (e: Error) => e.message);
  const third = withSpawnLock("k", async () => { order.push("third"); });
  controller.abort();
  assert.equal(await secondResult, "crew_launch was cancelled");
  releaseFirst();
  await first; await third;
  assert.deepEqual(order, ["first", "third"]);
});

await regressionTest("cancellation mid-spawn: the created pane is quit and closed and the child is never prompted", async () => {
  await withHerdrRepo(async (repo) => {
    const controller = new AbortController();
    const fake = createFakeHerdr({ repo, onRun: () => controller.abort() });
    await assert.rejects(() => executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "cancel-1" } as any, controller.signal), /cancelled/);
    assert.deepEqual(fake.prompts, []);
    assert.deepEqual(fake.closed, ["pane-new-1"]);
    assert.deepEqual(fake.quits, ["pi-1"]);
  });
});

test("agent naming: numbered candidates truncate the base so the suffix always fits and stays distinct", () => {
  const long = "a".repeat(32);
  const agents = [{ name: long, pane_id: "p", workspace_id: "w", cwd: "/r", status: "idle" }, { name: `${"a".repeat(30)}-2`, pane_id: "p2", workspace_id: "w", cwd: "/r", status: "idle" }];
  const name = chooseAgentName(agents as any, long, "w", "/r", "w:t");
  assert.ok(name.length <= 32, name);
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(!agents.some(a => a.name === name));
});

await regressionTest("durable mode is refused for pic and pic-proxy", async () => {
  for (const baseCommand of ["pic", "pic-proxy"] as const) {
    await assert.rejects(() => prepareDurableLaunch({ enabled: true, baseCommand, cwd: process.cwd(), role: "executor", taskId: "t", ownerSessionId: "o" }), new RegExp(`not supported through ${baseCommand}.*durable omitted/false`));
  }
});

await regressionTest("polling hardening 6a: non-not-found read errors keep the agent observation", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-transient");
  let reads = 0;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: reads < 5 ? "working" : "idle" }),
      readOutput: async () => { reads += 1; if (reads < 5) throw new Error("herdr agent read a failed with code 1: socket timeout"); return `${m.start}\nrecovered\n${m.end}`; },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.agentExited, false);
  assert.equal(result.markerOutput.text, "recovered");
  const missing = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "working" }),
      readOutput: async () => { throw new Error('herdr agent read a failed with code 1: {"error":{"code":"agent_not_found"}}'); },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(missing.agentExited, true);
});

test("polling hardening 6b: readSessionCompletion does not block on a FIFO", () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-fifo-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, "s.jsonl");
  try { execFileSync("mkfifo", [fifo]); } catch { return; }
  const r = readSessionCompletion(fifo, buildCrewMarkers("fifo"));
  assert.equal(r.promptSeen, false);
});

await regressionTest("polling hardening 6c: an unfinished readable session overrides a terminal marker pair until it agrees", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-6c");
  let sessionReads = 0;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => `${m.start}\nterminal\n${m.end}`,
      readSessionResult: async () => {
        sessionReads += 1;
        return sessionReads < 4
          ? { promptSeen: true, finalSeen: false, mode: "missing" as const, text: "", source: "session" as const }
          : { promptSeen: true, finalSeen: true, mode: "marker-pair" as const, text: "session", source: "session" as const };
      },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.ok(sessionReads >= 4, `expected to wait for the session, got ${sessionReads} reads`);
  assert.equal(result.sessionFinal, true);
  // Session unavailable (never promptSeen): the terminal pair still completes immediately.
  let reads2 = 0;
  const unavailable = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => `${m.start}\nterminal\n${m.end}`,
      readSessionResult: async () => { reads2 += 1; return { promptSeen: false, finalSeen: false, mode: "missing" as const, text: "", source: "session" as const }; },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(reads2, 1);
  assert.equal(unavailable.markerOutput.mode, "marker-pair");
});

const sessionFixtureDirs: string[] = [];
process.on("exit", () => { for (const d of sessionFixtureDirs) rmSync(d, { recursive: true, force: true }); });
function sessionFixture(lines: unknown[], tail = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-session-"));
  sessionFixtureDirs.push(dir);
  const file = join(dir, "s.jsonl");
  writeFileSync(file, lines.map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + tail);
  return file;
}
const sMsg = (role: string, content: unknown, stopReason?: string) => ({ type: "message", id: "x", message: { role, content, ...(stopReason ? { stopReason } : {}) } });
const sText = (text: string) => [{ type: "text", text }];

test("readSessionCompletion extracts the final answer and ignores thinking, toolCall, and other entries", () => {
  const m = buildCrewMarkers("sess-1");
  const file = sessionFixture([
    { type: "session", id: "h" },
    sMsg("user", sText(appendMarkerInstruction("task", m))),
    { type: "custom", message: { role: "assistant", content: sText(`${m.start}\nBAD\n${m.end}`) } },
    sMsg("assistant", [{ type: "thinking", thinking: `${m.start}\nTHINK\n${m.end}` }, { type: "toolCall", name: "x", arguments: { a: `${m.start} ARG ${m.end}` } }], "toolUse"),
    sMsg("toolResult", sText("tool output")),
    sMsg("assistant", sText(`working\n${m.start}\nold\n${m.end}`), "toolUse"),
    sMsg("assistant", sText(`${m.start}\nFinal answer\nline 2\n${m.end}`), "stop"),
  ]);
  const r = readSessionCompletion(file, m);
  assert.deepEqual(r, { promptSeen: true, finalSeen: true, mode: "marker-pair", text: "Final answer\nline 2", source: "session" });
});

test("readSessionCompletion tolerates wrapped markers, missing END, and unseen prompts", () => {
  const m = buildCrewMarkers("sess-2");
  const prompt = sMsg("user", sText(appendMarkerInstruction("task", m)));
  const half = Math.floor(m.end.length / 2);
  const wrapped = sessionFixture([prompt, sMsg("assistant", sText(`${m.start}\nAnswer\n${m.end.slice(0, half)}\n${m.end.slice(half)}`), "stop")]);
  assert.equal(readSessionCompletion(wrapped, m).text, "Answer");
  assert.equal(readSessionCompletion(wrapped, m).mode, "marker-pair");

  const noEnd = sessionFixture([prompt, sMsg("assistant", sText(`${m.start}\nPartial`))]);
  assert.deepEqual(readSessionCompletion(noEnd, m), { promptSeen: true, finalSeen: false, mode: "marker-start", text: "Partial", source: "session" });

  const noPrompt = sessionFixture([sMsg("user", sText("other")), sMsg("assistant", sText(`${m.start}\nX\n${m.end}`), "stop")]);
  assert.equal(readSessionCompletion(noPrompt, m).promptSeen, false);
  assert.equal(readSessionCompletion(noPrompt, m).mode, "missing");

  const onlyPrompt = sessionFixture([prompt]);
  assert.deepEqual(readSessionCompletion(onlyPrompt, m), { promptSeen: true, finalSeen: false, mode: "missing", text: "", source: "session" });

  const partial = sessionFixture([prompt, sMsg("assistant", sText(`${m.start}\nA\n${m.end}`), "stop")], '\n{"type":"message","message":{"role":"assis');
  assert.equal(readSessionCompletion(partial, m).text, "A");

  for (const bad of [undefined, "relative.jsonl", "/nonexistent/x.jsonl", wrapped.replace(/\.jsonl$/, ".txt")]) {
    assert.equal(readSessionCompletion(bad, m).promptSeen, false);
  }
  assert.equal(readSessionCompletion(wrapped, m, { maxBytes: 10 }).promptSeen, false);
});

test("readSessionCompletion uses the last prompt so an earlier answer is not reused", () => {
  const m = buildCrewMarkers("sess-3");
  const file = sessionFixture([
    sMsg("user", sText(appendMarkerInstruction("first", m))),
    sMsg("assistant", sText(`${m.start}\nOld\n${m.end}`), "stop"),
    sMsg("user", sText(appendMarkerInstruction("second", m))),
  ]);
  assert.equal(readSessionCompletion(file, m).mode, "missing");
  assert.equal(readSessionCompletion(file, m).promptSeen, true);
});

test("terminal extraction tolerates wrapped markers but never matches the echoed prompt", () => {
  const m = buildCrewMarkers("wrap-1");
  const cut = 20;
  const wrapped = `${m.start.slice(0, cut)}\n${m.start.slice(cut)}\nAnswer text\n${m.end.slice(0, cut)}\n${m.end.slice(cut)}`;
  assert.deepEqual(extractMarkerOutput(wrapped, m), { text: "Answer text", mode: "marker-pair" });
  assert.equal(extractMarkerOutput(`x\n  ${m.start.slice(0, cut)}\n  ${m.start.slice(cut)}\nAns\n${m.end}`, m).text, "Ans");
  const echoed = appendMarkerInstruction("Do things", m);
  assert.equal(extractMarkerOutput(echoed, m).mode, "missing");
  const narrow = echoed.replace(/(.{24})/g, "$1\n");
  assert.equal(extractMarkerOutput(narrow, m).mode, "missing");
  assert.equal(extractMarkerOutput(`${echoed}\nthinking...`, m).mode, "missing");
});

await regressionTest("polling loop: session marker-pair with settled status completes even when terminal has no markers", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-a");
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 10_000, hardCapMs: 50_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => "garbled",
      readSessionResult: async () => ({ promptSeen: true, finalSeen: true, mode: "marker-pair", text: "A", source: "session" }),
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.status, "idle");
  assert.equal(result.sessionCompletion?.text, "A");
  assert.equal(t, 1_000_000);
});

await regressionTest("polling loop: settled-without-working keeps waiting while session shows prompt but no final, and during pickup window", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-b");
  let polls = 0;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => "same",
      readSessionResult: async () => {
        polls += 1;
        const elapsed = t - 1_000_000;
        if (elapsed < 8_000) return { promptSeen: false, finalSeen: false, mode: "missing", text: "", source: "session" };
        if (elapsed < 20_000) return { promptSeen: true, finalSeen: false, mode: "missing", text: "", source: "session" };
        return { promptSeen: true, finalSeen: true, mode: "marker-pair", text: "late", source: "session" };
      },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.ok(t - 1_000_000 >= 20_000, `waited past grace, got ${t - 1_000_000}`);
  assert.equal(result.sessionCompletion?.mode, "marker-pair");
  assert.ok(polls > 5);
});

await regressionTest("polling loop: unseen prompt gives up after PROMPT_PICKUP_TIMEOUT_MS", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-c");
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "idle" }),
      readOutput: async () => "same",
      readSessionResult: async () => ({ promptSeen: false, finalSeen: false, mode: "missing", text: "", source: "session" }),
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.status, "idle");
  assert.ok(t - 1_000_000 >= PROMPT_PICKUP_TIMEOUT_MS && t - 1_000_000 < PROMPT_PICKUP_TIMEOUT_MS + 5_000);
});

await regressionTest("polling loop: readOutput errors (pane_not_found) become empty snapshot plus missing agent", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-d");
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "working" }),
      readOutput: async () => { throw new Error("pane_not_found"); },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.agentExited, true);
  assert.equal(result.status, "failed");
  assert.equal(result.output, "");
});

// ---- Fix round 1 tests ----

/** Simulates a terminal that hard word-wraps text to the given width (breaks long tokens). */
function wrapToWidth(text: string, width: number): string {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let cur = "";
    for (const word of line.split(" ")) {
      let w = word;
      while (w.length > width) {
        if (cur) { rows.push(cur); cur = ""; }
        rows.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
      else { rows.push(cur); cur = w; }
    }
    rows.push(cur);
  }
  return rows.join("\n");
}

test("echoed marker instruction never yields a pair at any wrap width (new and legacy wording)", () => {
  const m = buildCrewMarkers("wrap-widths");
  const legacy = `For your final answer, print ${m.start} on its own line, then your answer, then ${m.end} on its own line.`;
  for (const instruction of [appendMarkerInstruction("Do the thing", m), legacy]) {
    for (let width = 28; width <= 34; width += 1) {
      const echo = wrapToWidth(instruction, width);
      assert.notEqual(extractMarkerOutput(echo, m).mode, "marker-pair", `echo alone, width ${width}`);
      const withEnd = `${echo}\nthinking...\n${m.end}\n`;
      assert.notEqual(extractMarkerOutput(withEnd, m).mode, "marker-pair", `echo + real END, width ${width}`);
      assert.notEqual(updateMarkerOutput({ text: "", mode: "missing" }, withEnd, m).mode, "marker-pair", `updateMarkerOutput, width ${width}`);
    }
  }
});

test("capAnswerText keeps head and tail and points to the session file", () => {
  assert.equal(capAnswerText("short", "/x.jsonl"), "short");
  const long = "H".repeat(40_000) + "T".repeat(40_000);
  const capped = capAnswerText(long, "/tmp/s.jsonl");
  assert.ok(capped.length < 60_500);
  assert.ok(capped.startsWith("HHH") && capped.endsWith("TTT"));
  assert.match(capped, /details\.childSessionPath \(\/tmp\/s\.jsonl\)/);
});

test("readSessionCompletion reads only the tail of large files and classifies stop reasons", () => {
  const m = buildCrewMarkers("tail-1");
  const prompt = sMsg("user", sText(appendMarkerInstruction("task", m)));
  const big = sessionFixture([prompt, sMsg("assistant", sText("x".repeat(5_000)), "toolUse"), sMsg("assistant", sText(`${m.start}\nA\n${m.end}`), "stop")]);
  assert.equal(readSessionCompletion(big, m, { maxBytes: 2_000 }).promptSeen, false); // prompt outside tail
  assert.equal(readSessionCompletion(big, m, { maxBytes: 100_000 }).text, "A");
  const aborted = sessionFixture([prompt, sMsg("assistant", sText("partial"), "aborted")]);
  assert.equal(readSessionCompletion(aborted, m).finalSeen, true);
  const errored = sessionFixture([prompt, sMsg("assistant", sText("oops"), "error")]);
  const e = readSessionCompletion(errored, m);
  assert.equal(e.finalSeen, false);
  assert.equal(e.errorFinal, true);
});

await regressionTest("polling loop: error stopReason is final only after settled grace", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-err");
  let statusNow = "working";
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: statusNow }),
      readOutput: async () => "last good",
      readSessionResult: async () => ({ promptSeen: true, finalSeen: false, errorFinal: true, mode: "missing", text: "", source: "session" }),
      now: () => t,
      delay: async (ms) => { t += ms; if (t - 1_000_000 >= 3_000) statusNow = "idle"; },
    }
  );
  assert.equal(result.status, "idle");
  assert.equal(result.sessionFinal, true);
  assert.ok(t - 1_000_000 >= SESSION_ERROR_FINAL_GRACE_MS, `waited grace, got ${t - 1_000_000}`);
});

await regressionTest("polling loop: does not read the session while the agent is working", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-nowork");
  let sessionReads = 0;
  let statusNow = "working";
  await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: statusNow }),
      readOutput: async () => "x",
      readSessionResult: async () => { sessionReads += 1; return { promptSeen: true, finalSeen: true, mode: "marker-pair", text: "A", source: "session" }; },
      now: () => t,
      delay: async (ms) => { t += ms; if (t - 1_000_000 >= 60_000) statusNow = "idle"; },
    }
  );
  assert.equal(sessionReads, 1);
});

async function runSessionLaunch(name: string, setup: (markers: { start: string; end: string }) => { sessionLines: unknown[]; mock: Record<string, unknown>; launch?: Record<string, unknown> }, check: (result: any, ctx: { file: string; updates: any[]; closedPanes: string[] }) => void, withFakeClock = false) {
  const previousHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const repo = mkdtempSync(join(tmpdir(), "crew-sess-launch-"));
  const realNow = Date.now;
  let offset = 0;
  const dirs: string[] = [repo];
  try {
    const markers = buildCrewMarkers(name);
    const { sessionLines, mock, launch } = setup(markers);
    const file = sessionFixture(sessionLines);
    dirs.push(dirname(file));
    const { mockPi, closedPanes } = createMockHerdr({ repo, markers, sessionPath: file, ...mock } as any);
    const updates: any[] = [];
    if (withFakeClock) Date.now = () => realNow() + offset;
    const result = await executeCrewLaunch(
      mockPi as any,
      { role: "scout", task: "Check research items", startupTimeoutMs: 1000, startupReadyStableMs: 0, toolCallId: name, configCwd: repo, ...launch } as any,
      undefined,
      (u) => updates.push(u),
      undefined,
      async (ms) => { offset += ms; }
    );
    check(result, { file, updates, closedPanes });
  } finally {
    Date.now = realNow;
    process.env.HERDR_ENV = previousHerdr;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

await regressionTest("executeCrewLaunch prefers the session pair over a terminal pair and reports extraction details", async () => {
  await runSessionLaunch("sess-prefer", m => ({
    sessionLines: [sMsg("user", sText(appendMarkerInstruction("task", m))), sMsg("assistant", sText(`${m.start}\nSession answer\ncapabilityToken: abc\n${m.end}`), "stop")],
    mock: { markerOutputText: "Terminal answer" },
  }), (result, { file }) => {
    assert.equal(result.details.complete, true);
    assert.equal(result.details.extractionSource, "session");
    assert.equal(result.details.childSessionPath, file);
    assert.match(result.content[0].text, /Session answer/);
    assert.doesNotMatch(result.content[0].text, /Terminal answer/);
    assert.doesNotMatch(result.content[0].text, /capabilityToken: abc/);
    assert.match(result.content[0].text, /\[REDACTED\]/);
  });
});

await regressionTest("executeCrewLaunch is complete when the agent exited but the session has a marker pair", async () => {
  await runSessionLaunch("sess-exited", m => ({
    sessionLines: [sMsg("user", sText(appendMarkerInstruction("task", m))), sMsg("assistant", sText(`${m.start}\nExited answer\n${m.end}`), "stop")],
    mock: { agentExitsAfterPrompt: true, markerOutputText: "unused" },
    launch: { ephemeral: true, teardownGraceMs: 10 },
  }), (result, { updates, closedPanes }) => {
    assert.equal(result.details.agentExited, true);
    assert.equal(result.details.complete, true);
    assert.equal(result.details.extractionSource, "session");
    assert.match(result.content[0].text, /Exited answer/);
    assert.deepEqual(closedPanes, []);
    assert.ok(!updates.some(u => String(u.content?.[0]?.text).includes("failed to close pane")));
  }, true);
});

await regressionTest("executeCrewLaunch rejects a terminal pair when the session shows a final reply without a marker pair", async () => {
  await runSessionLaunch("sess-nopair", m => ({
    sessionLines: [sMsg("user", sText(appendMarkerInstruction("task", m))), sMsg("assistant", sText("I finished but forgot the markers."), "stop")],
    mock: { markerOutputText: "Echoed junk" },
  }), (result) => {
    assert.equal(result.details.complete, false);
    assert.equal(result.details.extractionSource, null);
    assert.equal(result.details.extractionMode, "prompt-fallback");
    assert.match(result.content[0].text, /complete: false/);
  });
});

await regressionTest("polling loop: a readOutput error keeps the last good snapshot", async () => {
  let t = 1_000_000;
  const m = buildCrewMarkers("poll-keep");
  let reads = 0;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "a", paneId: "p", markers: m, reusedPane: false, submittedAt: t, timeoutMs: 100_000, hardCapMs: 200_000, readLines: 200 },
    {
      getAgent: async () => ({ agent_status: "working" }),
      readOutput: async () => { reads += 1; if (reads > 1) throw new Error("pane_not_found"); return `${m.start}\nlast good`; },
      now: () => t,
      delay: async (ms) => { t += ms; },
    }
  );
  assert.equal(result.agentExited, true);
  assert.equal(result.output, `${m.start}\nlast good`);
  assert.equal(result.markerOutput.text, "last good");
});

await regressionTest("withSpawnLock: a cancelled waiter does not delete the lock key while the holder is still running", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = withSpawnLock("k2", () => new Promise<void>(resolve => { releaseFirst = resolve; order.push("first"); }));
  await settleMs(5);
  const controller = new AbortController();
  const cancelled = withSpawnLock("k2", async () => { order.push("cancelled"); }, controller.signal).catch((e: Error) => e.message);
  controller.abort();
  assert.equal(await cancelled, "crew_launch was cancelled");
  await settleMs(5);
  // The holder is still inside its critical section: a new entrant must still wait.
  const late = withSpawnLock("k2", async () => { order.push("late"); });
  await settleMs(20);
  assert.deepEqual(order, ["first"]);
  releaseFirst();
  await first; await late;
  assert.deepEqual(order, ["first", "late"]);
});

await regressionTest("polling loop: lastKnownAgent is seeded from the post-spawn agent so transient lookup errors are not a missing agent", async () => {
  let virtualTime = 1_000_000;
  const markers = buildCrewMarkers("seed-test");
  let polled = 0;
  const seed = { agent_status: "working", name: "scout-w" } as any;
  const result = await runCrewPollingLoop(
    { roleName: "scout", agentName: "scout-w", paneId: "p1", markers, submittedAt: virtualTime, timeoutMs: 60_000, hardCapMs: 120_000, readLines: 200, initialAgent: seed },
    {
      getAgent: async () => { throw new Error("transient bridge error"); },
      readOutput: async () => { polled += 1; return polled >= 3 ? `${markers.start}\ndone\n${markers.end}` : "working..."; },
      now: () => virtualTime,
      delay: async (ms) => { virtualTime += ms; },
    }
  );
  assert.equal(result.agentExited, false);
  assert.equal(result.lastKnownAgent, seed);
});

await regressionTest("config lifecycle.teardownGraceMs reaches pendingClose.delayMs", async () => {
  await withHerdrRepo(async (repo) => {
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "model-tiers.json"), JSON.stringify({ lifecycle: { teardownGraceMs: 3500 } }));
    const fake = createFakeHerdr({ repo });
    const result = await executeCrewLaunch(fake.pi as any, { ...launchParams(repo), toolCallId: "cfg-grace" } as any);
    assert.equal(result.details.teardownGraceMs, 3500);
    assert.equal(result.details.pendingClose.delayMs, 3500);
  });
});

await regressionTest("compaction info: merges global/project settings, per-model override, and never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-compaction-info-"));
  try {
    const agentDir = join(dir, "agent"); const project = join(dir, "proj");
    mkdirSync(agentDir, { recursive: true }); mkdirSync(join(project, ".pi"), { recursive: true });
    const model = { provider: "anthropic", id: "claude-opus-5-5" };
    // Missing files: defaults.
    assert.deepEqual(readCompactionInfo(project, model, 1_000_000, agentDir), { enabled: true, reserveTokens: 16_384, triggerTokens: 983_616 });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1000, modelOverrides: { "anthropic/claude-opus-5-5": { reserveTokens: 500_000 } } } }));
    assert.deepEqual(readCompactionInfo(project, model, 1_000_000, agentDir), { enabled: true, reserveTokens: 500_000, triggerTokens: 500_000 });
    assert.equal(readCompactionInfo(project, { provider: "x", id: "y" }, 200_000, agentDir).reserveTokens, 1000);
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
    const disabled = readCompactionInfo(project, model, 1_000_000, agentDir);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.reserveTokens, 500_000);
    assert.match(compactionStatusText(disabled, 1_000_000), /DISABLED.*overflow recovery is also off/);
    assert.equal(compactionStatusText({ enabled: true, reserveTokens: 500_000, triggerTokens: 500_000 }, 1_000_000), "Native Pi auto-compaction is enabled and triggers near 500000 tokens (50%).");
    writeFileSync(join(agentDir, "settings.json"), "{not json");
    writeFileSync(join(project, ".pi", "settings.json"), "[]");
    assert.equal(readCompactionInfo(project, model, 1_000_000, agentDir).reserveTokens, 16_384);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await regressionTest("message_end context warning reports the real compaction settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-warning-compaction-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
    const events = new Map<string, any[]>(); const messages: any[] = [];
    crewExtension({ appendEntry() {}, sendMessage: (m: any) => messages.push(m), registerTool() {}, registerCommand() {}, on(n: string, h: any) { events.set(n, [...(events.get(n) ?? []), h]); } } as any);
    const ctx = { cwd: dir, model: { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 }, getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "s", getBranch: () => [] }, ui: { notify() {}, setStatus() {} } };
    for (const h of events.get("message_end") ?? []) await h({ message: { role: "assistant", usage: { input: 250_000, output: 1 } } }, ctx);
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /DISABLED in settings \(compaction\.enabled=false\)/);
    assert.doesNotMatch(messages[0].content, /remains enabled/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await regressionTest("self_compact resumes the aborted run after compaction completes or fails", async () => {
  for (const outcome of ["complete", "error"] as const) {
    const tools = new Map<string, any>(); const sent: any[] = []; const entries: any[] = [];
    crewExtension({ appendEntry: (t: string, d: any) => entries.push({ t, d }), sendMessage: (m: any, o: any) => sent.push({ m, o }), registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, on() {} } as any);
    let handlers: any;
    const ctx = {
      cwd: tmpdir(), model: { contextWindow: 200_000 }, getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000 }),
      sessionManager: { getSessionId: () => `sc-${outcome}`, getBranch: () => [] },
      compact: (options: any) => { handlers = options; },
    };
    const result = await tools.get("self_compact").execute("c1", { reason: "context is large" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /interrupted for compaction and resumed automatically/);
    assert.deepEqual(sent, [], "no resume before compaction ends");
    if (outcome === "complete") handlers.onComplete(); else handlers.onError(new Error("boom"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].m.customType, "crew-compaction-resume");
    assert.equal(sent[0].m.display, false);
    assert.deepEqual(sent[0].o, { triggerTurn: true });
    if (outcome === "complete") assert.match(sent[0].m.content, /Compaction finished; continue the task you were working on from the summary; do not redo completed work\./);
    else assert.match(sent[0].m.content, /boom.*[Cc]ontinue/);
  }
});
