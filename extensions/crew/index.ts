import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type ToolUpdate = (partialResult: ToolResult) => void;
type ExtensionAPI = {
  exec(command: string, args?: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate): Promise<unknown>;
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
  model?: string;
  model_id?: string;
};

const VERSION = "0.1.0";
const STARTUP_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINES = 200;
const FAILURE_READ_LINES = 160;
const STARTUP_READY_STABLE_MS = 3_000;
const STARTUP_POLL_MS = 500;
const MARKER_READ_LINES = 2_000;
const ROLE_POLL_MS = 15_000;
const PROMPT_START_GRACE_MS = 5_000;
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

export function selectDiscoveryCommand(): "pi" { return "pi"; }

export function buildRoleCommand(baseCommand: "pic-proxy" | "pi", launchModel?: string): string {
  return `${baseCommand} --approve${launchModel ? ` --model ${launchModel}` : ""}`;
}

export function parseCrewConfig(raw: string): CrewConfig {
  const parsed = JSON.parse(raw) as CrewConfig;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function normalizedCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try { return realpathSync(absolute); } catch { return absolute.replace(/[\\\\/]+$/, "") || absolute; }
}

export function configCandidates(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): string[] {
  const candidates: string[] = [];
  let current = normalizedCwd(cwd);
  const selected = current;
  while (true) {
    candidates.push(join(current, ".pi", "crew.config.json"));
    if (current === selected) {
      candidates.push(join(current, ".pi", "skills", "crew", "crew.config.json"));
      candidates.push(join(current, "skills", "crew", "crew.config.json"));
    }
    if (current === dirname(current)) break;
    current = dirname(current);
  }
  candidates.push(join(agentDir, "skills", "crew", "crew.config.json"));
  candidates.push(join(home, ".pi", "crew.config.json"));
  return [...new Set(candidates)];
}

export function loadCrewConfig(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): { config: CrewConfig; path?: string } {
  for (const path of configCandidates(cwd, home, agentDir)) {
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
    throw new Error("crew_launch role must match Herdr agent names: lowercase letter followed by lowercase letters, numbers, underscore, or hyphen; max 32 chars");
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

export type DelegationFields = { context?: string; constraints?: string; acceptanceCriteria?: string; expectedOutput?: string };

export function buildRolePrompt(roleName: string, role: Role, task: string, cwd = process.cwd(), fields: DelegationFields = {}): string {
  return [
    `You are ${roleName}.${role.description ? ` ${role.description}` : ""} Authority: ${role.authority ?? "unspecified"}. Task: ${task}`,
    `## Role\n${roleName}${role.description ? `\n${role.description}` : ""}`,
    `## Authority\n${role.authority === "read-only" ? "read-only\nDo not create, modify, rename, or delete files, and do not run mutating commands." : role.authority === "can-edit" ? "can-edit\nModify only the requested scope; do not make unrelated changes." : "unspecified"}`, 
    `## Working directory\n${cwd}`,
    `## Objective\n${task}`,
    `## Context\n${fields.context || "No additional context supplied."}`,
    `## Constraints\n${fields.constraints || "Follow repository conventions and do not exceed the requested scope."}`,
    `## Acceptance criteria\n${fields.acceptanceCriteria || "Explain what you checked and identify any remaining uncertainty."}`,
    `## Required response\n${fields.expectedOutput || "Return a concise summary of findings or changes, validation performed, and remaining risks."}`,
    "You do not have access to the parent agent's conversation. Treat only this contract and repository contents as context.",
  ].join("\n\n");
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
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (let startLine = lines.length - 1; startLine >= 0; startLine -= 1) {
    if (lines[startLine].trim() !== markers.start) continue;
    const endOffset = lines.slice(startLine + 1).findIndex(line => line.trim() === markers.end);
    if (endOffset >= 0) {
      const endLine = startLine + 1 + endOffset;
      return { text: boundedLines(lines.slice(startLine + 1, endLine).join("\n"), maxLines), mode: "marker-pair" };
    }
    return { text: boundedLines(lines.slice(startLine + 1).join("\n"), maxLines), mode: "marker-start" };
  }
  return { text: "", mode: "missing" };
}

type MarkerOutput = ReturnType<typeof extractMarkerOutput>;

function mergeOverlappingText(previous: string, next: string): string {
  const previousLines = previous.replace(/\r\n/g, "\n").split("\n");
  const nextLines = next.replace(/\r\n/g, "\n").split("\n");
  const maxOverlap = Math.min(previousLines.length, nextLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousLines.slice(-overlap).every((line, index) => line === nextLines[index])) {
      return [...previousLines, ...nextLines.slice(overlap)].join("\n");
    }
  }
  return [...previousLines, ...nextLines].join("\n");
}

export function updateMarkerOutput(previous: MarkerOutput, snapshot: string, markers: { start: string; end: string }): MarkerOutput {
  const observed = extractMarkerOutput(snapshot, markers);
  if (observed.mode === "marker-pair" || observed.mode === "marker-start") return observed;
  if (previous.mode !== "marker-start") return previous;

  const lines = snapshot.replace(/\r\n/g, "\n").split("\n");
  const endLine = lines.findIndex(line => line.trim() === markers.end);
  const continuation = (endLine >= 0 ? lines.slice(0, endLine) : lines).join("\n");
  return {
    text: mergeOverlappingText(previous.text, continuation).trim(),
    mode: endLine >= 0 ? "marker-pair" : "marker-start",
  };
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
  const suffix = `${workspaceId}-${tabSuffix || "tab"}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
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

export function isReusableRoleAgent(agent: AgentLike, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): boolean {
  const status = normalizedAgentStatus(agent);
  return (
    agent.name === role &&
    (status === "idle" || status === "done") &&
    agent.workspace_id === workspaceId &&
    (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
    (normalizedCwd(agent.foreground_cwd || agent.cwd || "") === normalizedCwd(cwd)) &&
    (!requestedModel || agent.model === requestedModel || agent.model_id === requestedModel) &&
    typeof agent.pane_id === "string" &&
    agent.pane_id.length > 0
  );
}

export function findReusableRolePane(agent: AgentLike | undefined, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string | undefined {
  return agent && isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel) ? agent.pane_id : undefined;
}

export function findReusableRolePaneInList(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string | undefined {
  return agents.find((agent) => isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel))?.pane_id;
}

export function chooseAgentName(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string {
  if (findReusableRolePaneInList(agents, role, workspaceId, cwd, tabId, requestedModel)) return role;
  const baseName = roleNameInUse(agents, role) ? scopedRoleName(role, workspaceId, tabId) : role;
  if (findReusableRolePaneInList(agents, baseName, workspaceId, cwd, tabId, requestedModel)) return baseName;
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

type StartupState = { agent?: AgentLike; status: "ready" | "blocked" | "timed_out"; output?: string };

export function isStartupBlockedOutput(output: string): boolean {
  return /trust project folder\?|approval required|waiting for (?:user )?approval/i.test(output);
}

async function waitForAgentReady(pi: ExtensionAPI, paneId: string, timeoutMs: number): Promise<StartupState> {
  const deadline = Date.now() + timeoutMs;
  let readySince: number | undefined;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const agents = await listAgents(pi);
    const agent = agents.find(item => item.pane_id === paneId);
    if (agent) {
      const status = normalizedAgentStatus(agent);
      if (status === "blocked") return { agent, status: "blocked" };
      if (status === "idle" || status === "done") {
        lastOutput = await readPane(pi, paneId, FAILURE_READ_LINES);
        if (isStartupBlockedOutput(lastOutput)) return { agent, status: "blocked", output: lastOutput };
        readySince ??= Date.now();
        if (Date.now() - readySince >= STARTUP_READY_STABLE_MS) return { agent, status: "ready", output: lastOutput };
      } else {
        readySince = undefined;
      }
    } else {
      readySince = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(STARTUP_POLL_MS, Math.max(50, deadline - Date.now()))));
  }
  return { status: "timed_out", output: lastOutput || undefined };
}

type CrewStatus = "done" | "idle" | "working" | "blocked" | "timed_out" | "failed" | "unknown";
export function classifyAgentStatus(value: unknown): CrewStatus {
  const status = String(value ?? "").toLowerCase().replace(/[- ]/g, "_");
  if (status.includes("block")) return "blocked";
  if (status.includes("timeout") || status.includes("timed_out")) return "timed_out";
  if (status.includes("fail") || status.includes("error")) return "failed";
  if (status === "working" || status === "busy" || /(?:^|[\\s"'])status[\\s"':=]+(?:working|busy)/.test(status)) return "working";
  if (status === "done" || status === "completed" || status === "complete" || /(?:^|[\\s"'])status[\\s"':=]+(?:done|completed|complete)/.test(status)) return "done";
  if (status === "idle" || status === "ready" || /(?:^|[\\s"'])status[\\s"':=]+(?:idle|ready)/.test(status)) return "idle";
  return "unknown";
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

export async function functionalPreflight(pi: ExtensionAPI): Promise<ExecResult> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("I am not currently running inside Herdr (HERDR_ENV must equal 1).");
  }
  return pi.exec("herdr", ["pane", "current", "--current"]);
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`crew_launch ${name} must be a positive integer`);
  }
  return value;
}

export function normalizeTask(value: unknown, fields: DelegationFields = {}): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("crew_launch requires a non-blank task string");
  const task = value.trim();
  const supplemental = [fields.context, fields.constraints, fields.acceptanceCriteria, fields.expectedOutput]
    .filter(value => typeof value === "string" && value.trim().length >= 20)
    .join(" ");
  const unresolvedOnly = /^(?:please\s+)?(?:implement|fix|review|do|follow|continue)\s+(?:it|that|this|the plan(?: above)?|the above|above)(?:\s+(?:in|from|using)\b.*)?[.!]?$/i;
  if (unresolvedOnly.test(task) && !supplemental) throw new Error("Delegation contract is incomplete: replace the unresolved task reference with an explicit objective, or supply concrete context, constraints, acceptance criteria, or expected output.");
  return task;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("crew_launch was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("crew_launch was cancelled")); }, { once: true });
  });
}

type CrewLaunchParams = DelegationFields & {
  role?: string; task?: string; startupTimeoutMs?: number; timeoutMs?: number; readLines?: number; configCwd?: string; toolCallId?: string;
};

export function parseModelCatalog(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const slash = line.match(/\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._:~-]+)\b/);
    if (slash) { models.push(`${slash[1]}/${slash[2]}`); continue; }
    // `pi --list-models` prints provider and model as separate whitespace columns.
    const columns = line.trim().split(/\s{2,}|\t+/).map(x => x.trim()).filter(Boolean);
    if (columns.length >= 2 && /^[A-Za-z][A-Za-z0-9._-]*$/.test(columns[0]) && /^[A-Za-z0-9._:~-]+$/.test(columns[1]) && !/^provider$/i.test(columns[0]) && !/^model$/i.test(columns[1])) {
      models.push(`${columns[0]}/${columns[1]}`);
    }
  }
  return [...new Set(models)];
}
export function modelMatch(requested: string, catalog: string[]): "exact" | "fuzzy" | "none" {
  if (catalog.includes(requested)) return "exact";
  const suffix = requested.split("/").pop()?.toLowerCase() ?? "";
  return catalog.some(id => {
    const candidate = id.split("/").pop()?.toLowerCase() ?? "";
    return suffix === "ds4-flash" && candidate.includes("deepseek-v4-flash");
  }) ? "fuzzy" : "none";
}

async function executeCrewLaunch(pi: ExtensionAPI, params: CrewLaunchParams, signal?: AbortSignal, onUpdate?: ToolUpdate) {
  const roleName = params.role ?? "scout";
  assertValidRoleName(roleName);
  const task = normalizeTask(params.task, params);
  const startupTimeoutMs = positiveInteger(params.startupTimeoutMs, STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const timeoutMs = positiveInteger(params.timeoutMs, PROMPT_TIMEOUT_MS, "timeoutMs");
  const readLines = positiveInteger(params.readLines, DEFAULT_READ_LINES, "readLines");
  const current = await functionalPreflight(pi);
  expectOk(current, "herdr pane current");
  const currentPane = parseJson(current.stdout, "herdr pane current").result?.pane;
  const reportedCwd = currentPane?.foreground_cwd || currentPane?.cwd;
  if (!reportedCwd) throw new Error("herdr pane current did not report a cwd");
  const roleCwd = normalizedCwd(reportedCwd);
  const workspaceId = currentPane?.workspace_id || "";
  const tabId = currentPane?.tab_id || "";
  const { config, path: configPath } = loadCrewConfig(params.configCwd ?? roleCwd);
  const roleNames = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})]);
  const role = resolveRole(roleName, config);
  const basePrompt = buildRolePrompt(roleName, role, task, roleCwd, params);
  const markers = buildCrewMarkers(params.toolCallId ?? "crew_launch");
  const prompt = appendMarkerInstruction(basePrompt, markers);
  const baseCommand = selectLaunchCommand();
  const launchModel = role.model;
  if (launchModel) {
    const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
    const catalog = parseModelCatalog(catalogResult.stdout);
    if (catalogResult.code !== 0 || modelMatch(launchModel, catalog) !== "exact") {
      const nearby = catalog.filter(id => id.toLowerCase().includes(launchModel.toLowerCase().split("/").pop() ?? "")).slice(0, 5);
      throw new Error(`Configured model ${launchModel} is not an exact match in the launch catalog.${nearby.length ? ` Nearby matches: ${nearby.join(", ")}` : " No nearby matches found."}`);
    }
  }
  const roleCommand = buildRoleCommand(baseCommand, launchModel);

  let agents = await listAgents(pi);
  let agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId, role.model);
  let paneId = findReusableRolePaneInList(agents, agentName, workspaceId, roleCwd, tabId, role.model);
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

    const startup = await waitForAgentReady(pi, paneId, startupTimeoutMs);
    if (startup.status !== "ready") {
      const output = startup.output ?? await readPane(pi, paneId, FAILURE_READ_LINES);
      const message = startup.status === "blocked"
        ? `agent startup is blocked in pane ${paneId}; inspect the pane and resolve the interactive prompt before retrying.`
        : `agent was not ready in pane ${paneId} within startupTimeoutMs=${startupTimeoutMs}; the process may still be loading.`;
      const error = new Error(`${message}\n\n${output}`) as Error & { details?: unknown };
      error.details = { paneId, status: startup.status === "blocked" ? "startup_blocked" : "startup_timeout", startupTimeoutMs, agentContinues: true, output };
      throw error;
    }

    let rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
    if (rename.code !== 0 && /agent_name_taken/.test(rename.stderr || rename.stdout)) {
      agents = await listAgents(pi);
      agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId, role.model);
      rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
      renameConflictRecovered = rename.code === 0;
    }
    expectOk(rename, "herdr agent rename");
  }

  onUpdate?.({ content: [{ type: "text", text: `Starting ${roleName}…` }], details: { role: roleName, agentName, paneId, status: "starting" } });
  const promptResult = await herdr(pi, ["agent", "prompt", agentName, prompt], 10_000);
  if (promptResult.code !== 0) {
    const diagnostic = await readAgent(pi, agentName, FAILURE_READ_LINES);
    throw new Error(`crew role prompt submission failed for ${agentName}: ${promptResult.stderr || promptResult.stdout}\n\n${diagnostic}`);
  }

  const submittedAt = Date.now();
  let lastProgressAt = submittedAt;
  let previousEvidence = "";
  let observedWorking = false;
  let heartbeatCount = 0;
  let output = "";
  let currentAgent: AgentLike | undefined;
  let lastKnownAgent: AgentLike | undefined;
  let agentExited = false;
  let status: CrewStatus = "unknown";
  let markerOutput = extractMarkerOutput("", markers);

  while (true) {
    if (signal?.aborted) throw new Error("crew_launch was cancelled");
    currentAgent = await maybeGetAgent(pi, agentName);
    if (currentAgent) lastKnownAgent = currentAgent;
    status = classifyAgentStatus(currentAgent?.agent_status || currentAgent?.status);
    output = currentAgent
      ? await readAgent(pi, agentName, Math.max(readLines, MARKER_READ_LINES))
      : await readPane(pi, paneId, Math.max(readLines, MARKER_READ_LINES));
    markerOutput = updateMarkerOutput(markerOutput, output, markers);
    const settled = status === "done" || status === "idle";
    const evidence = `${status}\n${output}`;
    if (evidence !== previousEvidence) {
      previousEvidence = evidence;
      lastProgressAt = Date.now();
    }
    if (status === "working") {
      observedWorking = true;
      // A positively working role is alive even when its visible output is unchanged.
      lastProgressAt = Date.now();
    }
    if (!currentAgent && Date.now() - submittedAt >= PROMPT_START_GRACE_MS) {
      agentExited = true;
      status = markerOutput.mode === "marker-pair" ? "done" : "failed";
      break;
    }

    if (markerOutput.mode === "marker-pair" && settled) break;
    if (status === "blocked" || status === "failed") break;
    if (observedWorking && settled) break;
    if (!observedWorking && settled && Date.now() - submittedAt >= PROMPT_START_GRACE_MS) break;
    if (Date.now() - lastProgressAt >= timeoutMs) {
      status = "timed_out";
      break;
    }

    heartbeatCount += 1;
    const dots = ".".repeat((heartbeatCount - 1) % 3 + 1);
    onUpdate?.({
      content: [{ type: "text", text: `Processing ${roleName}${dots}` }],
      details: { role: roleName, agentName, paneId, status, heartbeat: heartbeatCount, elapsedMs: Date.now() - submittedAt },
    });
    const pollMs = observedWorking ? ROLE_POLL_MS : Math.min(1_000, ROLE_POLL_MS);
    await delay(pollMs, signal);
  }

  const settled = status === "done" || status === "idle";
  const complete = settled && markerOutput.mode === "marker-pair";
  const agentContinues = status === "working" || status === "timed_out" || status === "blocked" || status === "unknown";

  const compactOutput = complete && markerOutput.text
    ? boundedLines(markerOutput.text, readLines)
    : `[CREW STATUS: ${status}; complete: false] ${settled ? "The role settled without a confirmed final marker pair; this is incomplete diagnostic output, not a final answer." : "The role did not complete. This is partial diagnostic output, not a final answer."}\n\n${compactRoleOutput(output, prompt, readLines)}`;
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
      requestedModel: role.model ?? null,
      actualModel: lastKnownAgent?.model ?? lastKnownAgent?.model_id ?? null,
      actualModelKnown: !!(lastKnownAgent?.model ?? lastKnownAgent?.model_id),
      modelWarning: role.model && lastKnownAgent?.model && lastKnownAgent.model !== role.model ? `Running model ${lastKnownAgent.model} differs from requested ${role.model}.` : (!createdPane && role.model ? "Reused pane model was not queried." : null),
      status,
      complete,
      agentContinues,
      agentExited,
      heartbeatCount,
      elapsedMs: Date.now() - submittedAt,
      authority: role.authority ?? null,
      configPath: configPath ?? null,
      splitPolicy: splitPolicy ?? null,
      renameConflictRecovered,
      markerFound: markerOutput.mode !== "missing",
      extractionMode: markerOutput.mode === "missing" ? "prompt-fallback" : markerOutput.mode,
      extractionWarning: markerOutput.mode !== "marker-pair" || !complete ? "No confirmed final marker pair for a completed delegation." : null,
      outputLineCount: output.split(/\r?\n/).filter(Boolean).length,
      markerCaptureLines: Math.max(readLines, MARKER_READ_LINES),
      compactOutputLineCount: compactOutput.split(/\r?\n/).filter(Boolean).length,
    },
  };
}

const crewQueues = new Map<string, Promise<void>>();
function enqueueCrewLaunch<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = crewQueues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  crewQueues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

type CrewRulesParams = { configCwd?: string };

async function executeCrewRules(pi: ExtensionAPI, params: CrewRulesParams = {}) {
  let configCwd = params.configCwd;
  if (!configCwd) {
    const current = await herdr(pi, ["pane", "current", "--current"]);
    if (current.code === 0) configCwd = parseJson(current.stdout, "herdr pane current").result?.pane?.foreground_cwd || parseJson(current.stdout, "herdr pane current").result?.pane?.cwd;
  }
  const { config, path: configPath } = loadCrewConfig(configCwd ?? process.cwd());
  const roleNames = [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})])].sort();
  const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
  const catalog = parseModelCatalog(catalogResult.stdout);
  const roles = Object.fromEntries(roleNames.map((name) => {
    const role = resolveRole(name, config);
    const modelState = role.model ? modelMatch(role.model, catalog) : "default";
    const catalogPresent = role.model ? (catalogResult.code === 0 && modelState === "exact") : null;
    return [name, { description: role.description ?? null, authority: role.authority ?? null, configured: role.model ?? null,
      model: role.model ?? null, modelState, catalogPresent, authenticationUnknown: true,
      launchable: role.model ? catalogPresent : true, currentlyUsed: null }];
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ configPath: configPath ?? null, roles }, null, 2) }],
    details: { version: VERSION, configPath: configPath ?? null, roles },
  };
}

export default function crewExtension(pi: ExtensionAPI) {
  const parameters = { type: "object", required: ["role", "task"], properties: {
    role: { type: "string", description: "Crew role name, such as scout, oracle, executor, or reviewer." },
    task: { type: "string", description: "Self-contained delegation objective. The role cannot see the parent conversation. Put concrete supporting information in context, constraints, acceptanceCriteria, and expectedOutput; avoid a task made only of unresolved references such as 'implement it'." },
    context: { type: "string", description: "Relevant prior decisions, files, findings, or requirements." }, constraints: { type: "string", description: "Boundaries and invariants." },
    acceptanceCriteria: { type: "string", description: "How the result should be judged." }, expectedOutput: { type: "string", description: "Required response format." },
    startupTimeoutMs: { type: "number", description: "Maximum startup detection wait. Defaults to 120000." }, timeoutMs: { type: "number", description: "Maximum inactivity wait after prompt submission. Progress and a working agent refresh this timeout. Defaults to 120000." }, readLines: { type: "number", description: "Recent output lines. Defaults to 200." }, configCwd: { type: "string", description: "Explicit config lookup override." },
  }, additionalProperties: false };
  const execute = async (toolCallId: string, rawParams: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate) => {
    const params = { ...((rawParams ?? {}) as CrewLaunchParams), toolCallId };
    const authority = DEFAULT_ROLES[params.role ?? "scout"]?.authority ?? (params.configCwd ? resolveRole(params.role ?? "scout", loadCrewConfig(params.configCwd).config).authority : "can-edit");
    const key = authority === "read-only" ? `readonly:${normalizedCwd(params.configCwd ?? process.cwd())}:${Date.now()}:${Math.random()}` : `writer:${params.configCwd ? normalizedCwd(params.configCwd) : "pane"}`;
    return enqueueCrewLaunch(key, () => executeCrewLaunch(pi, params, signal, onUpdate));
  };
  pi.registerTool({ name: "crew_launch", label: "Crew Launch", description: "Run or reuse a visible Herdr role pane and return structured status.", promptSnippet: "Delegate a self-contained task to a visible crew role pane.", promptGuidelines: ["Use crew_launch for delegation.", "Fully expand context; the role cannot see the parent conversation."], parameters, execute });


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
      return executeCrewRules(pi, (rawParams ?? {}) as CrewRulesParams);
    },
  });
}
