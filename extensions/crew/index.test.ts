import assert from "node:assert/strict";
import {
  buildRolePrompt,
  chooseSplitTarget,
  chooseAgentName,
  compactRoleOutput,
  findReusableRolePane,
  findReusableRolePaneInList,
  findReusableNamedRolePaneInList,
  parseCrewConfig,
  resolveRole,
  selectLaunchCommand,
} from "./index.ts";

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
  assert.match(buildRolePrompt("scout", role, "map files"), /You are scout\. Custom scout Authority: read-only\. Task: map files/);
});

test("compactRoleOutput keeps only output after the last prompt", () => {
  const prompt = "You are scout. Task: say hello";
  const output = `pi --model x\nstartup noise\n${prompt}\nThinking\nHello.\n${prompt}\nPreparing\nHello again.`;
  assert.equal(compactRoleOutput(output, prompt), "Preparing\nHello again.");
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

test("global role lookup finds idle named role outside current workspace", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(findReusableNamedRolePaneInList(agents, "scout"), "pane-scout");
  assert.equal(findReusableNamedRolePaneInList([{ ...agents[0], status: "Working" }], "scout"), undefined);
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

test("agent naming reuses scoped same-tab role", () => {
  const agents = [
    { name: "scout-w5-t6", pane_id: "pane-scoped", workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Idle" },
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
});

test("split decision creates below existing same-cwd crew pane", () => {
  const decision = chooseSplitTarget([
    { name: "scout", pane_id: "pane-scout", workspace_id: "ws", cwd: "/repo" },
  ], "ws", "/repo");
  assert.equal(decision.policy, "below-existing-crew");
  assert.deepEqual(decision.args, ["pane", "split", "pane-scout", "--direction", "down", "--cwd", "/repo", "--no-focus"]);
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
