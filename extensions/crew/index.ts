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
  authority?: "read-only" | "can-edit";
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
    join(cwd, ".pi", "crew.config.json"),
    join(cwd, ".pi", "skills", "crew", "crew.config.json"),
    resolve(cwd, "skills", "crew", "crew.config.json"),
    join(home, ".pi", "crew.config.json"),
  ];
}

export function loadCrewConfig(cwd = process.cwd(), home = homedir()): { config: CrewConfig; path?: string } {
  for (const path of configCandidates(cwd, home)) {
    if (!existsSync(path)) continue;
    return { config: parseCrewConfig(readFileSync(path, "utf8")), path };
  }
  return { config: {}, path: undefined };
}

function assertValidAuthority(authority: unknown, roleName: string): asserts authority is Role["authority"] | undefined {
  if (authority === undefined) return;
  if (authority !== "read-only" && authority !== "can-edit") {
    throw new Error(`Invalid authority for crew role ${roleName}: expected read-only or can-edit`);
  }
}

function assertValidModel(model: unknown, roleName: string): asserts model is string | undefined {
  if (model === undefined) return;
  if (typeof model !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:~-]+$/.test(model)) {
    throw new Error(`Invalid model for crew role ${roleName}: expected exact provider/model id`);
  }
}

function assertValidRoleName(roleName: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(roleName)) {
    throw new Error("crew_role role must match Herdr agent names: lowercase letter followed by lowercase letters, numbers, underscore, or hyphen; max 32 chars");
  }
}

export function resolveRole(roleName: string, config: CrewConfig): Role & { name: string } {
  assertValidRoleName(roleName);
  const configured = config.roles?.[roleName];
  const fallback = DEFAULT_ROLES[roleName];
  if (!configured && !fallback) {
    throw new Error(`Unknown crew role: ${roleName}`);
  }
  const authority = configured?.authority ?? fallback?.authority;
  const model = configured?.model;
  assertValidAuthority(authority, roleName);
  assertValidModel(model, roleName);
  return {
    name: roleName,
    description: configured?.description ?? fallback?.description,
    authority,
    model,
  };
}

export function buildRolePrompt(roleName: string, role: Role, task: string): string {
  let prompt = `You are ${roleName}.`;
  if (role.description) prompt += ` ${role.description}`;
  if (role.authority) prompt += ` Authority: ${role.authority}.`;
  return `${prompt} Task: ${task}`;
}

export function buildCrewMarkers(toolCallId: string): { start: string; end: string } {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-48) || `${Date.now()}`;
  return { start: `CREW_RESULT_START_${safe}`, end: `CREW_RESULT_END_${safe}` };
}

export function appendMarkerInstruction(prompt: string, markers: { start: string; end: string }): string {
  return `${prompt}\n\nFor your final answer, print ${markers.start} on its own line, then your answer, then ${markers.end} on its own line.`;
}

function boundedLines(text: string, maxLines?: number): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const kept = maxLines && Number.isFinite(maxLines) ? lines.slice(-maxLines) : lines;
  return kept.join("\n").trim();
}

export function extractMarkerOutput(output: string, markers: { start: string; end: string }, maxLines?: number): { text: string; mode: "marker-pair" | "marker-start" | "missing" } {
  const normalized = output.replace(/\r\n/g, "\n");
  const startIndex = normalized.lastIndexOf(markers.start);
  if (startIndex < 0) return { text: "", mode: "missing" };
  const afterStart = normalized.slice(startIndex + markers.start.length);
  const endIndex = afterStart.indexOf(markers.end);
  if (endIndex >= 0) return { text: boundedLines(afterStart.slice(0, endIndex), maxLines), mode: "marker-pair" };
  return { text: boundedLines(afterStart, maxLines), mode: "marker-start" };
}

export function compactRoleOutput(output: string, prompt: string, maxLines?: number): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const promptIndex = normalized.lastIndexOf(prompt);
  const relevant = promptIndex >= 0 ? normalized.slice(promptIndex + prompt.length) : normalized;
  const lines = relevant
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const kept = maxLines && Number.isFinite(maxLines) ? lines.slice(-maxLines) : lines;
  return kept.join("\n").trim() || normalized.split("\n").slice(maxLines ? -maxLines : undefined).join("\n").trim();
}

function normalizedAgentStatus(agent: AgentLike): string {
  return String(agent.agent_status ?? agent.status ?? "").toLowerCase();
}

export function scopedRoleName(role: string, workspaceId: string, tabId?: string): string {
  const tabSuffix = tabId?.includes(":") ? tabId.split(":").pop() : tabId;
  const suffix = `${workspaceId}-${tabSuffix || "tab"}`.replace(/[^a-z0-9_-]/g, "-").toLowerCase();
  const maxRoleLength = Math.max(1, 31 - suffix.length);
  const safeRole = role.slice(0, maxRoleLength).replace(/-+$/g, "") || "r";
  return `${safeRole}-${suffix}`.slice(0, 32).replace(/-+$/g, "");
}

function roleNameInUse(agents: AgentLike[], name: string): boolean {
  return agents.some((agent) => agent.name === name);
}

function isKnownCrewAgentName(name: string, roleNames: Set<string>): boolean {
  for (const role of roleNames) {
    if (name === role || name.startsWith(`${role}-`)) return true;
  }
  return false;
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

export function chooseAgentName(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string): string {
  if (findReusableRolePaneInList(agents, role, workspaceId, cwd, tabId)) return role;
  const baseName = roleNameInUse(agents, role) ? scopedRoleName(role, workspaceId, tabId) : role;
  if (findReusableRolePaneInList(agents, baseName, workspaceId, cwd, tabId)) return baseName;
  if (!roleNameInUse(agents, baseName)) return baseName;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!roleNameInUse(agents, candidate)) return candidate;
  }
  throw new Error(`Could not choose an unused crew agent name for role ${role}`);
}

export function chooseSplitTarget(
  agents: AgentLike[],
  workspaceId: string,
  cwd: string,
  tabId?: string,
  roleNames = new Set(Object.keys(DEFAULT_ROLES)),
): { args: string[]; policy: "below-existing-crew" | "right-of-current" } {
  const crew = agents.find(
    (agent) =>
      !!agent.pane_id &&
      !!agent.name &&
      isKnownCrewAgentName(agent.name, roleNames) &&
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
  expectOk(result, `herdr agent read ${role}`);
  return result.stdout || result.stderr;
}

async function readPane(pi: ExtensionAPI, paneId: string, lines: number): Promise<string> {
  const result = await herdr(pi, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  expectOk(result, `herdr pane read ${paneId}`);
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

async function preflight(pi: ExtensionAPI): Promise<void> {
  const result = await pi.exec("bash", ["-lc", 'test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null 2>&1'], { timeout: 2_000 });
  if (result.code !== 0) {
    throw new Error("I am not currently able to control Herdr from this session. Start me inside Herdr with the Herdr CLI available, then retry.");
  }
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`crew_role ${name} must be a positive integer`);
  }
  return value;
}

function normalizeTask(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("crew_role requires a non-blank task string");
  return value;
}

type CrewRoleParams = {
  role?: string;
  task?: string;
  timeoutMs?: number;
  readLines?: number;
  configCwd?: string;
  toolCallId?: string;
};

async function executeCrewRole(pi: ExtensionAPI, params: CrewRoleParams) {
  const roleName = params.role ?? "scout";
  assertValidRoleName(roleName);
  const task = normalizeTask(params.task);
  const timeoutMs = positiveInteger(params.timeoutMs, PROMPT_TIMEOUT_MS, "timeoutMs");
  const readLines = positiveInteger(params.readLines, DEFAULT_READ_LINES, "readLines");
  await preflight(pi);

  const configCwd = params.configCwd ?? process.cwd();
  const { config, path: configPath } = loadCrewConfig(configCwd);
  const roleNames = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})]);
  const role = resolveRole(roleName, config);
  const basePrompt = buildRolePrompt(roleName, role, task);
  const markers = buildCrewMarkers(params.toolCallId ?? "crew-role");
  const prompt = appendMarkerInstruction(basePrompt, markers);
  const baseCommand = selectLaunchCommand();
  const launchModel = role.model;
  const roleCommand = launchModel ? `${baseCommand} --model ${launchModel}` : baseCommand;

  const current = await herdr(pi, ["pane", "current", "--current"]);
  expectOk(current, "herdr pane current");
  const currentPane = parseJson(current.stdout, "herdr pane current").result?.pane;
  const roleCwd = currentPane?.foreground_cwd || currentPane?.cwd;
  const workspaceId = currentPane?.workspace_id || "";
  const tabId = currentPane?.tab_id || "";
  if (!roleCwd) throw new Error("herdr pane current did not report a cwd");

  let agents = await listAgents(pi);
  let agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId);
  let paneId = findReusableRolePaneInList(agents, agentName, workspaceId, roleCwd, tabId);
  let createdPane: string | undefined;
  let splitPolicy: string | undefined;
  let renameConflictRecovered = false;

  if (!paneId) {
    const split = chooseSplitTarget(agents, workspaceId, roleCwd, tabId, roleNames);
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

    let rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
    if (rename.code !== 0 && /agent_name_taken/.test(rename.stderr || rename.stdout)) {
      agents = await listAgents(pi);
      agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId);
      rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
      renameConflictRecovered = rename.code === 0;
    }
    expectOk(rename, "herdr agent rename");
  }

  const promptArgs = ["agent", "prompt", agentName, prompt, "--wait", "--timeout", String(timeoutMs)];
  const promptResult = await herdr(pi, promptArgs, timeoutMs + 5_000);
  if (promptResult.code !== 0) {
    const output = await readAgent(pi, agentName, FAILURE_READ_LINES);
    throw new Error(`crew role prompt failed for ${agentName}: ${promptResult.stderr || promptResult.stdout}\n\n${output}`);
  }

  const output = await readAgent(pi, agentName, readLines);
  const markerOutput = extractMarkerOutput(output, markers, readLines);
  const compactOutput = markerOutput.mode !== "missing" && markerOutput.text ? markerOutput.text : compactRoleOutput(output, basePrompt, readLines);
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
      configuredModel: role.model ?? null,
      launchModel: createdPane ? launchModel ?? null : null,
      actualModel: createdPane ? launchModel ?? null : null,
      actualModelKnown: !!createdPane && !!launchModel,
      authority: role.authority ?? null,
      configPath: configPath ?? null,
      splitPolicy: splitPolicy ?? null,
      renameConflictRecovered,
      markerFound: markerOutput.mode !== "missing",
      extractionMode: markerOutput.mode === "missing" ? "prompt-fallback" : markerOutput.mode,
      outputLineCount: output.split(/\r?\n/).filter(Boolean).length,
      compactOutputLineCount: compactOutput.split(/\r?\n/).filter(Boolean).length,
    },
  };
}

let crewRoleQueue: Promise<void> = Promise.resolve();

function enqueueCrewRole<T>(work: () => Promise<T>): Promise<T> {
  const run = crewRoleQueue.then(work, work);
  crewRoleQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type CrewRulesParams = { configCwd?: string };

function executeCrewRules(params: CrewRulesParams = {}) {
  const configCwd = params.configCwd ?? process.cwd();
  const { config, path: configPath } = loadCrewConfig(configCwd);
  const roleNames = [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})])].sort();
  const roles = Object.fromEntries(roleNames.map((name) => {
    const role = resolveRole(name, config);
    return [name, {
      description: role.description ?? null,
      authority: role.authority ?? null,
      model: role.model ?? null,
    }];
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ configPath: configPath ?? null, roles }, null, 2) }],
    details: { version: VERSION, configPath: configPath ?? null, roles },
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
    ],
    parameters: {
      type: "object",
      required: ["role", "task"],
      properties: {
        role: { type: "string", description: "Crew role name, such as scout, oracle, executor, or reviewer." },
        task: { type: "string", description: "Focused task for the role." },
        timeoutMs: { type: "number", description: "Prompt wait timeout in milliseconds. Defaults to 120000." },
        readLines: { type: "number", description: "Recent output lines to return. Defaults to 200." },
        configCwd: { type: "string", description: "Directory for project .pi/crew.config.json lookup. Defaults to current process cwd." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      return enqueueCrewRole(() => executeCrewRole(pi, { ...((rawParams ?? {}) as CrewRoleParams), toolCallId: _toolCallId }));
    },
  });


  pi.registerTool({
    name: "crew_rules",
    label: "Crew Rules",
    description: "Load resolved crew role configuration: descriptions, authority, models, and config source.",
    promptSnippet: "Inspect configured crew roles and models.",
    parameters: {
      type: "object",
      properties: {
        configCwd: { type: "string", description: "Directory for project .pi/crew.config.json lookup. Defaults to current process cwd." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      return executeCrewRules((rawParams ?? {}) as CrewRulesParams);
    },
  });
}
