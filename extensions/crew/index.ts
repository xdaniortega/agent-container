import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };
type ExtensionAPI = {
  exec(command: string, args?: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute(toolCallId: string, params: unknown): Promise<unknown>;
  }): void;
};

type Role = {
  description?: string;
  model?: string;
  authority?: "read-only" | "can-edit" | string;
};

type CrewConfig = { roles?: Record<string, Role> };
type AgentLike = {
  name?: string;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  foreground_cwd?: string;
  cwd?: string;
  agent_status?: string;
  status?: string;
};

const VERSION = "0.1.0";
const DETECTION_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINES = 200;
const FAILURE_READ_LINES = 160;
const KNOWN_ROLES = new Set(["scout", "oracle", "executor", "reviewer"]);

const DEFAULT_ROLES: Record<string, Required<Pick<Role, "description" | "authority">>> = {
  scout: {
    description: "Finds local and online context. Reports relevant facts, files, sources, risks, and suggested next steps.",
    authority: "read-only",
  },
  oracle: {
    description: "Advises on plans, architecture, sequencing, tradeoffs, alternatives, and risks.",
    authority: "read-only",
  },
  executor: {
    description: "Implements the approved plan with minimal pragmatic changes and reports changed files, validation, and risks.",
    authority: "can-edit",
  },
  reviewer: {
    description: "Reviews plans or diffs for correctness, missed requirements, test gaps, maintainability risks, and actionable findings.",
    authority: "read-only",
  },
};

export function selectLaunchCommand(env: NodeJS.ProcessEnv = process.env): "pic-proxy" | "pi" {
  return env.PIC_HERDR_BRIDGE === "1" || !!env.PIC_HERDR_BRIDGE_HOST ? "pic-proxy" : "pi";
}

export function parseCrewConfig(raw: string): CrewConfig {
  const parsed = JSON.parse(raw) as CrewConfig;
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function configCandidates(cwd = process.cwd(), home = homedir()): string[] {
  return [
    join(home, ".pi", "crew.config.json"),
    join(cwd, ".pi", "crew.config.json"),
    resolve(cwd, "skills", "crew", "crew.config.json"),
  ];
}

export function loadCrewConfig(cwd = process.cwd(), home = homedir()): { config: CrewConfig; path?: string } {
  for (const path of configCandidates(cwd, home)) {
    if (!existsSync(path)) continue;
    return { config: parseCrewConfig(readFileSync(path, "utf8")), path };
  }
  return { config: {}, path: undefined };
}

export function resolveRole(roleName: string, config: CrewConfig): Role & { name: string } {
  const configured = config.roles?.[roleName];
  const fallback = DEFAULT_ROLES[roleName];
  if (!configured && !fallback) {
    throw new Error(`Unknown crew role: ${roleName}`);
  }
  return {
    name: roleName,
    description: configured?.description ?? fallback?.description,
    authority: configured?.authority ?? fallback?.authority,
    model: configured?.model,
  };
}

export function buildRolePrompt(roleName: string, role: Role, task: string): string {
  let prompt = `You are ${roleName}.`;
  if (role.description) prompt += ` ${role.description}`;
  if (role.authority) prompt += ` Authority: ${role.authority}.`;
  return `${prompt} Task: ${task}`;
}

export function compactRoleOutput(output: string, prompt: string, maxLines = 40): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const promptIndex = normalized.lastIndexOf(prompt);
  const relevant = promptIndex >= 0 ? normalized.slice(promptIndex + prompt.length) : normalized;
  const lines = relevant
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines.slice(-maxLines).join("\n").trim() || normalized.split("\n").slice(-maxLines).join("\n").trim();
}

function normalizedAgentStatus(agent: AgentLike): string {
  return String(agent.agent_status ?? agent.status ?? "").toLowerCase();
}

function scopedRoleName(role: string, workspaceId: string, tabId?: string): string {
  const safeWorkspace = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-") || "workspace";
  const tabSuffix = tabId?.includes(":") ? tabId.split(":").pop() : tabId;
  const safeTab = (tabSuffix || "tab").replace(/[^A-Za-z0-9._-]/g, "-");
  return `${role}-${safeWorkspace}-${safeTab}`;
}

export function isReusableRoleAgent(agent: AgentLike, role: string, workspaceId: string, cwd: string, tabId?: string): boolean {
  const status = normalizedAgentStatus(agent);
  return (
    agent.name === role &&
    (status === "idle" || status === "done") &&
    agent.workspace_id === workspaceId &&
    (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
    (agent.foreground_cwd === cwd || agent.cwd === cwd) &&
    typeof agent.pane_id === "string" &&
    agent.pane_id.length > 0
  );
}

export function findReusableRolePane(agent: AgentLike | undefined, role: string, workspaceId: string, cwd: string, tabId?: string): string | undefined {
  return agent && isReusableRoleAgent(agent, role, workspaceId, cwd, tabId) ? agent.pane_id : undefined;
}

export function findReusableRolePaneInList(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string): string | undefined {
  return agents.find((agent) => isReusableRoleAgent(agent, role, workspaceId, cwd, tabId))?.pane_id;
}

export function findReusableNamedRolePaneInList(agents: AgentLike[], role: string): string | undefined {
  return agents.find((agent) => {
    const status = normalizedAgentStatus(agent);
    return agent.name === role && (status === "idle" || status === "done") && !!agent.pane_id;
  })?.pane_id;
}

export function chooseAgentName(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string): string {
  if (findReusableRolePaneInList(agents, role, workspaceId, cwd, tabId)) return role;
  const scoped = scopedRoleName(role, workspaceId, tabId);
  if (findReusableRolePaneInList(agents, scoped, workspaceId, cwd, tabId)) return scoped;
  if (agents.some((agent) => agent.name === role)) return scoped;
  return role;
}

export function chooseSplitTarget(
  agents: AgentLike[],
  workspaceId: string,
  cwd: string,
  tabId?: string,
): { args: string[]; policy: "below-existing-crew" | "right-of-current" } {
  const crew = agents.find(
    (agent) =>
      !!agent.pane_id &&
      !!agent.name &&
      KNOWN_ROLES.has(agent.name.split("-")[0]) &&
      agent.workspace_id === workspaceId &&
      (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
      (agent.foreground_cwd === cwd || agent.cwd === cwd),
  );
  if (crew?.pane_id) {
    return { args: ["pane", "split", crew.pane_id, "--direction", "down", "--cwd", cwd, "--no-focus"], policy: "below-existing-crew" };
  }
  return { args: ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"], policy: "right-of-current" };
}

function parseJson(stdout: string, context: string): any {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse ${context} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectOk(result: ExecResult, context: string): void {
  if (result.code !== 0) {
    throw new Error(`${context} failed with code ${result.code}: ${result.stderr || result.stdout}`);
  }
}

async function herdr(pi: ExtensionAPI, args: string[], timeout = PROMPT_TIMEOUT_MS): Promise<ExecResult> {
  return pi.exec("herdr", args, { timeout });
}

async function readAgent(pi: ExtensionAPI, role: string, lines: number): Promise<string> {
  const result = await herdr(pi, ["agent", "read", role, "--source", "recent-unwrapped", "--lines", String(lines)]);
  return result.stdout || result.stderr;
}

async function readPane(pi: ExtensionAPI, paneId: string, lines: number): Promise<string> {
  const result = await herdr(pi, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  return result.stdout || result.stderr;
}

async function waitForAgent(pi: ExtensionAPI, paneId: string): Promise<ExecResult> {
  const first = await herdr(pi, ["agent", "wait", paneId, "--timeout", String(DETECTION_TIMEOUT_MS)], DETECTION_TIMEOUT_MS + 5_000);
  if (first.code === 0) return first;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return herdr(pi, ["agent", "wait", paneId, "--timeout", String(DETECTION_TIMEOUT_MS)], DETECTION_TIMEOUT_MS + 5_000);
}

async function maybeGetAgent(pi: ExtensionAPI, role: string): Promise<AgentLike | undefined> {
  const result = await herdr(pi, ["agent", "get", role]);
  if (result.code !== 0) return undefined;
  return parseJson(result.stdout, "herdr agent get").result?.agent;
}

async function listAgents(pi: ExtensionAPI): Promise<AgentLike[]> {
  const result = await herdr(pi, ["agent", "list"]);
  expectOk(result, "herdr agent list");
  return parseJson(result.stdout, "herdr agent list").result?.agents ?? [];
}

type CrewRoleParams = {
  role?: string;
  task?: string;
  wait?: boolean;
  timeoutMs?: number;
  readLines?: number;
  configCwd?: string;
};

async function executeCrewRole(pi: ExtensionAPI, params: CrewRoleParams) {
  const roleName = params.role ?? "scout";
  if (!params.task || typeof params.task !== "string") throw new Error("crew_role requires a task string");

  const configCwd = params.configCwd ?? process.cwd();
  const { config, path: configPath } = loadCrewConfig(configCwd);
  const role = resolveRole(roleName, config);
  const prompt = buildRolePrompt(roleName, role, params.task);
  const baseCommand = selectLaunchCommand();
  const roleCommand = role.model ? `${baseCommand} --model ${role.model}` : baseCommand;

  const current = await herdr(pi, ["pane", "current", "--current"]);
  expectOk(current, "herdr pane current");
  const currentPane = parseJson(current.stdout, "herdr pane current").result?.pane;
  const roleCwd = currentPane?.foreground_cwd || currentPane?.cwd;
  const workspaceId = currentPane?.workspace_id || "";
  const tabId = currentPane?.tab_id || "";
  if (!roleCwd) throw new Error("herdr pane current did not report a cwd");

  let agents = await listAgents(pi);
  const agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId);
  let paneId = findReusableRolePaneInList(agents, agentName, workspaceId, roleCwd, tabId);
  let reusedOutsideWorkspace = false;
  let createdPane: string | undefined;
  let splitPolicy: string | undefined;
  let renameConflictRecovered = false;

  if (!paneId) {
    const split = chooseSplitTarget(agents, workspaceId, roleCwd, tabId);
    splitPolicy = split.policy;
    const splitResult = await herdr(pi, split.args);
    expectOk(splitResult, "herdr pane split");
    paneId = parseJson(splitResult.stdout, "herdr pane split").result?.pane?.pane_id;
    if (!paneId) throw new Error("herdr pane split did not return pane_id");
    createdPane = paneId;

    const runResult = await herdr(pi, ["pane", "run", paneId, roleCommand]);
    expectOk(runResult, "herdr pane run");

    const waitResult = await waitForAgent(pi, paneId);
    if (waitResult.code !== 0) {
      const output = await readPane(pi, paneId, FAILURE_READ_LINES);
      throw new Error(`agent detection failed for pane ${paneId}: ${waitResult.stderr || waitResult.stdout}\n\n${output}`);
    }

    const rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
    expectOk(rename, "herdr agent rename");
  }

  const promptArgs = ["agent", "prompt", agentName, prompt];
  if (params.wait ?? true) {
    promptArgs.push("--wait", "--timeout", String(params.timeoutMs ?? PROMPT_TIMEOUT_MS));
  }
  const promptResult = await herdr(pi, promptArgs, (params.timeoutMs ?? PROMPT_TIMEOUT_MS) + 5_000);
  if (promptResult.code !== 0) {
    const output = await readAgent(pi, agentName, FAILURE_READ_LINES);
    throw new Error(`crew role prompt failed for ${agentName}: ${promptResult.stderr || promptResult.stdout}\n\n${output}`);
  }

  const output = await readAgent(pi, agentName, params.readLines ?? DEFAULT_READ_LINES);
  const compactOutput = compactRoleOutput(output, prompt);
  return {
    content: [{ type: "text", text: compactOutput }],
    details: {
      version: VERSION,
      role: roleName,
      agentName,
      tabId,
      paneId,
      createdPane,
      reusedPane: !createdPane,
      workspaceId,
      cwd: roleCwd,
      command: baseCommand,
      model: role.model ?? null,
      authority: role.authority ?? null,
      configPath: configPath ?? null,
      splitPolicy: splitPolicy ?? null,
      outputLineCount: output.split(/\r?\n/).filter(Boolean).length,
      compactOutputLineCount: compactOutput.split(/\r?\n/).filter(Boolean).length,
    },
  };
}

export default function crewExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "crew_role",
    label: "Crew Role",
    description: "Run or reuse a visible Herdr role pane, prompt it, wait, read output, and return structured details.",
    promptSnippet: "Delegate a focused task to a visible crew role pane.",
    promptGuidelines: [
      "Use this for crew delegation when Herdr is available.",
      "Keep tasks short and focused. Reused panes keep their launch model.",
      "If the tool is unavailable or fails before starting, use the crew skill's shell recipe fallback.",
    ],
    parameters: {
      type: "object",
      required: ["role", "task"],
      properties: {
        role: { type: "string", description: "Crew role name, such as scout, oracle, executor, or reviewer." },
        task: { type: "string", description: "Focused task for the role." },
        wait: { type: "boolean", description: "Wait for completion before reading output. Defaults to true." },
        timeoutMs: { type: "number", description: "Prompt wait timeout in milliseconds. Defaults to 120000." },
        readLines: { type: "number", description: "Recent output lines to return. Defaults to 200." },
        configCwd: { type: "string", description: "Directory for project .pi/crew.config.json lookup. Defaults to current process cwd." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      return executeCrewRole(pi, (rawParams ?? {}) as CrewRoleParams);
    },
  });
}
