import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acknowledgeInbox,
  appendPublicationChunk,
  bindTaskChildSession,
  createPhaseCheckpoint,
  createReviewBatch,
  deferTaskAttempt,
  finalizeArtifactCleanup,
  previewArtifactCleanup,
  promoteTaskAttempt,
  publishPhaseContract,
  readCurrentPhase,
  readPhaseCheckpoint,
  readPlanIndex,
  writePlanIndex,
  beginPublication,
  beginTaskReview,
  completeTaskReview,
  createRunState,
  createTaskAttempt,
  createTaskCapability,
  acquireWriterOwnership,
  discardCorruptArtifact,
  disposeTaskEvidence,
  markWriterRunning,
  recoverTaskAttempt,
  recoverTaskReview,
  defaultCrewStateRoot,
  finalizePublication,
  readArtifact,
  readInbox,
  readTaskAttempt,
  resolveRepositoryIdentity,
  submitTaskAttempt,
  transitionTaskAttempt,
  type ChildSessionBinding,
  type PublicationMetadata,
  type RunAccess,
  type PlanIndex,
  type ReviewTiming,
  type RiskClass,
} from "./state.ts";
import { assessPayload, captureSourceSnapshot, contextWarningLevel, normalizeUsage, THINKING_LEVELS, type ThinkingLevel } from "./workflow.ts";
import { herdrObservation, isActiveChild, reconcileChildLaunch, type ChildLaunchRecord, type HerdrAgentLike } from "./herdr-session.ts";

type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type ToolUpdate = (partialResult: ToolResult) => void;
type SessionMessage = { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown; details?: Record<string, unknown> };
export type SessionEntryLike = { id?: string; parentId?: string | null; type?: string; message?: SessionMessage; customType?: string; data?: unknown; content?: unknown };
type SessionManagerLike = { getSessionId?(): string; getSessionFile?(): string | undefined; getSessionDir?(): string; getLeafId?(): string | null; getBranch?(): SessionEntryLike[] };
type ToolContext = { cwd: string; mode?: string; hasUI?: boolean; ui?: { setStatus?(id: string, text?: string): void; notify?(message: string, level?: "info" | "warning" | "error"): void }; sessionManager?: SessionManagerLike };
type ExtensionAPI = {
  exec(command: string, args?: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate, ctx?: ToolContext): Promise<unknown>;
  }): void;
  registerCommand?(name: string, command: { description?: string; handler(args: string, ctx: any): Promise<void> }): void;
  on?(event: string, handler: (event: any, ctx: any) => unknown): void;
  appendEntry?(customType: string, data?: unknown): void;
  sendMessage?(message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }): void;
};

export type RoleAuthority = "read-only" | "can-edit";

export type Role = {
  description?: string;
  model?: string;
  effort?: ThinkingLevel;
  reasoning?: ThinkingLevel;
  authority?: RoleAuthority;
  tier?: string;
};

export type CrewRoleConfig = {
  model?: string;
  reasoning?: ThinkingLevel;
  effort?: ThinkingLevel;
  authority?: RoleAuthority;
  description?: string;
};

export type ParallelReviewAgentConfig = {
  model?: string;
  reasoning?: ThinkingLevel;
  effort?: ThinkingLevel;
};

export type LifecycleConfig = {
  ephemeral?: boolean;
  teardownGraceMs?: number;
};

export type ModelTiers = {
  models?: Record<string, string>;
  crewRoles?: Record<string, CrewRoleConfig>;
  roles?: Record<string, CrewRoleConfig>;
  parallelCodeReview?: Record<string, ParallelReviewAgentConfig>;
  lifecycle?: LifecycleConfig;
};

export type CrewConfig = ModelTiers;
type AgentLike = HerdrAgentLike;

const VERSION = "0.2.0";
const STARTUP_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINES = 200;
const FAILURE_READ_LINES = 160;
const STARTUP_READY_STABLE_MS = 3_000;
const STARTUP_POLL_MS = 500;
const MARKER_READ_LINES = 2_000;
const ROLE_POLL_MS = 15_000;
export const PROMPT_START_GRACE_MS = 5_000;
export const REUSED_IDLE_GRACE_MS = 15_000;
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

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

/**
 * @notice Builds the approved role-process command with authority and durable-state constraints.
 * @param stateRoot Optional durable state root exported to the child process.
 * @param effort Optional model thinking level.
 * @param sessionDir Optional native session directory used for bounded context lookup.
 * @returns A shell-safe role launch command.
 */
export function buildRoleCommand(baseCommand: "pic-proxy" | "pi", launchModel?: string, authority?: RoleAuthority, stateRoot?: string, effort?: ThinkingLevel, sessionDir?: string): string {
  const tools = authority === "read-only" ? " --tools read,grep,find,ls,crew_publish,crew_read,crew_read_context" : "";
  const command = `${baseCommand} --approve${tools}${launchModel ? ` --model ${launchModel}` : ""}${effort ? ` --thinking ${effort}` : ""}${sessionDir ? ` --session-dir ${shellQuote(sessionDir)}` : ""}`;
  return stateRoot ? `env CREW_STATE_ROOT=${shellQuote(stateRoot)} ${command}` : command;
}

export function parseModelTiers(raw: string): ModelTiers {
  const parsed = JSON.parse(raw) as ModelTiers;
  return parsed && typeof parsed === "object" ? parsed : {};
}

export const parseCrewConfig = parseModelTiers;

function normalizedCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try { return realpathSync(absolute); } catch { return absolute.replace(/[\\\\/]+$/, "") || absolute; }
}

export function resolveQueueKey(roleName: string, cwd: string, explicitConfig?: ModelTiers): { authority: RoleAuthority; key: string } {
  const normalized = normalizedCwd(cwd);
  const config = explicitConfig ?? loadModelTiers(normalized).config;
  const role = resolveRole(roleName, config);
  const authority = role.authority ?? "can-edit";
  const key = authority === "read-only"
    ? `readonly:${normalized}:${Date.now()}:${Math.random()}`
    : `writer:${normalized}`;
  return { authority, key };
}

export function modelTiersCandidates(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): string[] {
  const candidates: string[] = [];
  let current = normalizedCwd(cwd);
  const selected = current;
  while (true) {
    candidates.push(join(current, ".pi", "model-tiers.json"));
    if (current === selected) {
      candidates.push(join(current, ".pi", "skills", "crew", "model-tiers.json"));
      candidates.push(join(current, "skills", "crew", "model-tiers.json"));
    }
    if (current === dirname(current)) break;
    current = dirname(current);
  }
  candidates.push(join(agentDir, "skills", "crew", "model-tiers.json"));
  candidates.push(join(home, ".pi", "model-tiers.json"));
  return [...new Set(candidates)];
}

export const configCandidates = modelTiersCandidates;

export function loadModelTiers(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): { config: ModelTiers; path?: string } {
  for (const path of modelTiersCandidates(cwd, home, agentDir)) {
    if (!existsSync(path)) continue;
    return { config: parseModelTiers(readFileSync(path, "utf8")), path };
  }
  return { config: {}, path: undefined };
}

export const loadCrewConfig = loadModelTiers;

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

function assertValidEffort(effort: unknown, roleName: string): asserts effort is ThinkingLevel | undefined {
  if (effort !== undefined && !THINKING_LEVELS.includes(effort as ThinkingLevel)) throw new Error(`Invalid effort for crew role ${roleName}`);
}

export function assertValidTierName(tier: unknown, models: Record<string, string> | undefined, roleName: string): asserts tier is string {
  if (typeof tier !== "string" || !models || !Object.prototype.hasOwnProperty.call(models, tier)) {
    throw new Error(`Unknown model tier "${String(tier)}" for crew role ${roleName}`);
  }
}

export function resolveModelTier(tier: string, tiers: ModelTiers): string {
  assertValidTierName(tier, tiers.models, tier);
  const model = tiers.models![tier];
  assertValidModel(model, tier);
  return model;
}

function assertValidRoleName(roleName: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(roleName)) {
    throw new Error("crew_launch role must match Herdr agent names: lowercase letter followed by lowercase letters, numbers, underscore, or hyphen; max 32 chars");
  }
}

export function resolveRole(roleName: string, config: ModelTiers = {}): Role & { name: string } {
  assertValidRoleName(roleName);
  const configured = config.crewRoles?.[roleName] ?? config.roles?.[roleName];
  const fallback = DEFAULT_ROLES[roleName];
  if (!configured && !fallback) {
    throw new Error(`Unknown crew role: ${roleName}`);
  }
  const authority = configured?.authority ?? fallback?.authority;
  const rawReasoning = configured?.reasoning ?? configured?.effort;
  assertValidAuthority(authority, roleName);
  assertValidEffort(rawReasoning, roleName);

  let resolvedModel: string | undefined;
  let tier: string | undefined;

  if (configured?.model) {
    if (configured.model.includes("/")) {
      assertValidModel(configured.model, roleName);
      resolvedModel = configured.model;
    } else {
      assertValidTierName(configured.model, config.models, roleName);
      tier = configured.model;
      resolvedModel = config.models![configured.model];
      assertValidModel(resolvedModel, roleName);
    }
  }

  return {
    name: roleName,
    description: configured?.description ?? fallback?.description,
    authority,
    model: resolvedModel,
    ...(tier ? { tier } : {}),
    ...(rawReasoning ? { effort: rawReasoning, reasoning: rawReasoning } : {}),
  };
}

export function resolveParallelReviewAgent(agentName: string, config: ModelTiers): { name: string; model?: string; reasoning?: ThinkingLevel; effort?: ThinkingLevel; tier?: string } {
  const configured = config.parallelCodeReview?.[agentName];
  if (!configured) {
    throw new Error(`Unknown parallel review agent: ${agentName}`);
  }
  const rawReasoning = configured.reasoning ?? configured.effort;
  assertValidEffort(rawReasoning, agentName);

  let resolvedModel: string | undefined;
  let tier: string | undefined;

  if (configured.model) {
    if (configured.model.includes("/")) {
      assertValidModel(configured.model, agentName);
      resolvedModel = configured.model;
    } else {
      assertValidTierName(configured.model, config.models, agentName);
      tier = configured.model;
      resolvedModel = config.models![configured.model];
      assertValidModel(resolvedModel, agentName);
    }
  }

  return {
    name: agentName,
    model: resolvedModel,
    ...(tier ? { tier } : {}),
    ...(rawReasoning ? { effort: rawReasoning, reasoning: rawReasoning } : {}),
  };
}

export const resolveReviewAgent = resolveParallelReviewAgent;

export type DelegationFields = { context?: string; constraints?: string; acceptanceCriteria?: string; expectedOutput?: string };
export type ParentContextSource = { version: 1; parentSessionId: string; upperBoundEntryId: string };
export type ReadContextParams = { mode?: "search" | "entry" | "around"; query?: string; entryId?: string; maxChars?: number; cursor?: string };
const CONTEXT_SOURCE_PATTERN = /<crew-context-source>\s*([\s\S]*?)\s*<\/crew-context-source>/g;
const CONTEXT_MAX_CALLS = 4;
const CONTEXT_MAX_CHARS = 24_000;
const CONTEXT_DEFAULT_PAGE_CHARS = 6_000;
const CONTEXT_MAX_SERIALIZED_BYTES = 16_000;

function validSessionId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value); }
function validEntryId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function sourceBlock(source: ParentContextSource): string { return `<crew-context-source>\n${JSON.stringify(source)}\n</crew-context-source>`; }
function parseContextSource(text: string): ParentContextSource | undefined {
  const matches = [...text.matchAll(CONTEXT_SOURCE_PATTERN)];
  try {
    const value = JSON.parse(matches.at(-1)?.[1] ?? "null") as ParentContextSource;
    return value?.version === 1 && validSessionId(value.parentSessionId) && validEntryId(value.upperBoundEntryId) ? value : undefined;
  } catch { return undefined; }
}
function redactCredentialLikeValues(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[credential redacted]")
    // Authorization values commonly contain a scheme plus credentials, so redact
    // the whole header/value rather than leaving the credential after "Bearer".
    .replace(/((?:["']?authorization["']?)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    // This is intentionally conservative pattern filtering, not universal secret
    // detection. Quoted JSON/string values may contain whitespace; unquoted values
    // end at normal structural or whitespace delimiters.
    .replace(/(["']?)(capabilityToken|api[_-]?key|access[_-]?token|secret)\1(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1$2$1$3[redacted]");
}
export function visibleMessageText(entry: SessionEntryLike): string {
  if (entry.type === "custom_message") {
    const content = (entry as any).content;
    const text = typeof content === "string" ? content : `[custom message: ${(entry as any).customType ?? "unknown"}]`;
    return redactCredentialLikeValues(text.replace(CONTEXT_SOURCE_PATTERN, "")).trim();
  }
  if (entry.type !== "message" || !["user", "assistant", "toolResult", "custom"].includes(entry.message?.role ?? "")) return "";
  const content = entry.message?.content;
  let rawText = "";
  if (typeof content === "string") {
    rawText = content;
  } else if (Array.isArray(content)) {
    const parts = content.flatMap((part: any) => {
      if (typeof part === "string") return [part];
      if (!part || typeof part !== "object") return [];
      if (part.type === "thinking" || part.type === "thinkingSignature") return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "toolCall") {
        const name = typeof part.name === "string" ? part.name : "unknown";
        const id = typeof part.id === "string" ? ` id=${part.id}` : "";
        return [`[tool call: ${name}${id}]`];
      }
      if (part.type === "image") return ["[image]"];
      return [`[attachment: ${part.type ?? "unsupported content"}]`];
    });
    rawText = parts.join("\n");
  } else if (content && typeof content === "object") {
    const part = content as any;
    if (part.type === "thinking" || part.type === "thinkingSignature") {
      rawText = "";
    } else if (part.type === "text" && typeof part.text === "string") {
      rawText = part.text;
    } else if (part.type === "image") {
      rawText = "[image]";
    } else if (part.type === "toolCall") {
      rawText = `[tool call: ${part.name ?? "unknown"}${part.id ? ` id=${part.id}` : ""}]`;
    } else {
      rawText = typeof part.text === "string" ? part.text : "";
    }
  }
  return redactCredentialLikeValues(rawText.replace(CONTEXT_SOURCE_PATTERN, "")).trim();
}

export function serializeSessionEntries(entries: SessionEntryLike[]): string {
  return entries
    .flatMap((entry) => {
      const text = visibleMessageText(entry);
      if (!text) return [];
      const role = entry.message?.role ?? (entry.type === "custom_message" ? "custom" : "message");
      const label = role === "toolResult" && entry.message?.toolName === "crew_launch"
        ? "crew result"
        : role === "toolResult"
        ? `tool result${entry.message?.toolName ? `: ${entry.message.toolName}` : ""}`
        : role;
      return [`[${label}]\n${text}`];
    })
    .join("\n\n");
}

export function selectHandoffEntries(entries: SessionEntryLike[]): SessionEntryLike[] {
  const callIds = new Set<string>();
  for (const entry of entries) {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && (part as any).type === "toolCall") {
          const id = (part as any).id;
          if (typeof id === "string") callIds.add(id);
        }
      }
    }
  }

  return entries.filter((entry) => {
    if (entry.type === "custom_message") return true;
    if (entry.type !== "message" || !entry.message) return false;
    const role = entry.message.role;
    if (!["user", "assistant", "toolResult", "custom"].includes(role ?? "")) return false;
    if (role === "toolResult") {
      if (entry.message.toolName === "crew_launch") return true;
      const toolCallId = entry.message.toolCallId ?? (entry as any).toolCallId;
      return typeof toolCallId === "string" && callIds.has(toolCallId);
    }
    return true;
  });
}

export function findCurrentCrewLaunch(branch: SessionEntryLike[], toolCallId: string): SessionEntryLike | undefined {
  return branch.find((entry) =>
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content) &&
    (entry.message.content as unknown[]).some(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as { id?: string; name?: string }).id === toolCallId &&
        (item as { id?: string; name?: string }).name === "crew_launch"
    )
  );
}

export function findCheckpoint(branch: SessionEntryLike[], beforeIndex: number): SessionEntryLike | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const m = branch[i].message;
    const details = m?.details ?? (branch[i] as any).details;
    const isCompletedCrewLaunch =
      m?.role === "toolResult" &&
      m.toolName === "crew_launch" &&
      m.isError !== true &&
      details?.complete === true;
    if (isCompletedCrewLaunch) return branch[i];
  }
  return undefined;
}

export function userBoundaryIndex(branch: SessionEntryLike[], end: number, turns: number): number {
  let seen = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (branch[i].message?.role === "user") {
      seen += 1;
      if (seen >= turns) return i;
    }
  }
  return 0;
}

export type ContextMode = "explicit" | "since-last-crew";
export type CheckpointFallback = "recent" | "explicit" | "error";

export type CrewLaunchContext = {
  text: string;
  entries: SessionEntryLike[];
  checkpointEntryId?: string;
  fallbackUsed: boolean;
};

export function buildHandoff(
  branch: SessionEntryLike[],
  toolCallId?: string,
  mode: ContextMode = "since-last-crew",
  fallback: CheckpointFallback = "recent",
  recentTurns = 6,
  maxHandoffChars = CONTEXT_MAX_CHARS,
  explicitText = ""
): CrewLaunchContext {
  if (mode === "explicit") {
    return { text: explicitText, entries: [], fallbackUsed: false };
  }

  const current = toolCallId ? findCurrentCrewLaunch(branch, toolCallId) : undefined;
  const end = current ? branch.indexOf(current) : branch.length;
  const checkpoint = findCheckpoint(branch, end);

  if (!checkpoint) {
    if (fallback === "error") {
      throw new Error("Cannot build crew handoff: no successful complete crew_launch checkpoint exists in the active branch.");
    }
    if (fallback === "explicit") {
      return { text: explicitText, entries: [], fallbackUsed: true };
    }
  }

  const start = checkpoint ? branch.indexOf(checkpoint) : userBoundaryIndex(branch, end, recentTurns);
  const rawEntries = branch.slice(start, end);
  const entries = selectHandoffEntries(rawEntries);
  const rawSerialized = serializeSessionEntries(entries);
  const redacted = redactCredentialLikeValues(rawSerialized);

  let text = redacted;
  if (text.length > maxHandoffChars) {
    text = text.slice(0, maxHandoffChars);
  }

  return {
    text,
    entries,
    checkpointEntryId: checkpoint?.id,
    fallbackUsed: !checkpoint,
  };
}
function serializeContextEntry(entry: SessionEntryLike): string { return `[${entry.message?.role} entryId=${entry.id}]\n${visibleMessageText(entry)}`; }
/**
 * @notice Parses a native JSONL session while tolerating only an incomplete trailing record.
 * @param raw Native session JSONL content.
 * @returns The validated session identifier and entries.
 */
export function parseNativeSession(raw: string): { sessionId: string; entries: SessionEntryLike[] } {
  const complete = /\r?\n$/.test(raw); const lines = raw.split(/\r?\n/); if (complete) lines.pop();
  const parsed: any[] = [];
  lines.forEach((line, index) => { if (!line) return; try { parsed.push(JSON.parse(line)); } catch { if (!complete && index === lines.length - 1) return; throw new Error(`Malformed native session JSONL at line ${index + 1}`); } });
  const header = parsed[0]; const sessionId = header?.sessionId ?? header?.session_id ?? header?.id;
  if (header?.type !== "session" || !validSessionId(sessionId)) throw new Error("Native session has an invalid header");
  const entries = parsed.slice(1) as SessionEntryLike[]; const ids = new Set<string>();
  for (const entry of entries) { if (!validEntryId(entry?.id) || ids.has(entry.id)) throw new Error("Native session contains an invalid or duplicate entry ID"); ids.add(entry.id); if (entry.parentId !== null && entry.parentId !== undefined && !validEntryId(entry.parentId)) throw new Error("Native session contains an invalid parent ID"); }
  return { sessionId, entries };
}
/**
 * @notice Resolves one contained regular native-session file for a session identifier.
 * @param sessionDir Trusted native session directory.
 * @returns The validated session file path.
 */
export function resolveNativeSessionPath(sessionDir: string, sessionId: string): string {
  if (!validSessionId(sessionId)) throw new Error("Invalid parent session ID");
  const directory = realpathSync(resolve(sessionDir));
  const candidates = readdirSync(directory).filter(name => name.endsWith(`_${sessionId}.jsonl`));
  if (candidates.length !== 1) throw new Error("Frozen parent session could not be resolved unambiguously");
  const candidate = resolve(directory, candidates[0]); const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || dirname(realpathSync(candidate)) !== directory) throw new Error("Frozen parent session is not a contained regular file");
  if (parseNativeSession(readFileSync(candidate, "utf8")).sessionId !== sessionId) throw new Error("Frozen parent session header ID mismatch");
  return candidate;
}
/**
 * @notice Reconstructs the frozen ancestor chain ending at an exact session entry.
 * @param upperBoundEntryId Leaf entry that bounds visible historical context.
 * @returns The root-to-leaf frozen branch.
 */
export function reconstructContextBranch(entries: SessionEntryLike[], upperBoundEntryId: string): SessionEntryLike[] {
  const byId = new Map(entries.map(entry => [entry.id!, entry])); const branch: SessionEntryLike[] = []; const visited = new Set<string>(); let current = byId.get(upperBoundEntryId);
  if (!current) throw new Error("Frozen upper-bound entry was not found");
  while (current) { if (visited.has(current.id!)) throw new Error("Frozen parent branch contains a cycle"); visited.add(current.id!); branch.push(current); if (!current.parentId) break; current = byId.get(current.parentId); if (!current) throw new Error("Frozen parent branch contains a missing parent"); }
  return branch.reverse();
}
// Process-owned key: callers can inspect cursor fields but cannot forge changed
// selection/offset data. Cursors intentionally expire when the extension reloads.
const contextCursorKey = randomBytes(32);
function cursorMac(value: Record<string, unknown>): Buffer { return createHmac("sha256", contextCursorKey).update(JSON.stringify(value)).digest(); }
function encodeContextCursor(value: Record<string, unknown>): string { const body = { ...value, mac: cursorMac(value).toString("base64url") }; return Buffer.from(JSON.stringify(body)).toString("base64url"); }
function decodeContextCursor(cursor: string): any {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); const { mac, ...body } = parsed;
    if (typeof mac !== "string") throw new Error();
    const supplied = Buffer.from(mac, "base64url"), expected = cursorMac(body);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    return body;
  } catch { throw new Error("Invalid or tampered context cursor"); }
}
function latestContextSource(branch: SessionEntryLike[]): { source: ParentContextSource; promptIndex: number } {
  for (let index = branch.length - 1; index >= 0; index -= 1) { if (branch[index].message?.role !== "user") continue; const text = visibleMessageText(branch[index]); if (!text) continue; const source = parseContextSource(typeof branch[index].message?.content === "string" ? branch[index].message!.content as string : Array.isArray(branch[index].message?.content) ? (branch[index].message!.content as any[]).map(part => part?.text ?? "").join("\n") : ""); if (source) return { source, promptIndex: index }; throw new Error("Latest delegation has no valid parent context locator; explicit new delegations invalidate older locators"); }
  throw new Error("No delegation prompt is available for bounded context lookup");
}
/**
 * @notice Serves a bounded, redacted selection from an explicitly frozen parent branch.
 * @param params Search mode, selection, page bound, and optional continuation cursor.
 * @param roleCtx Native role-session context used to authenticate the frozen source.
 * @returns A serialized-budget-safe context page with provenance metadata.
 */
export async function executeReadContext(params: ReadContextParams, roleCtx: ToolContext): Promise<ToolResult> {
  const roleBranch = roleCtx.sessionManager?.getBranch?.(); const sessionDir = roleCtx.sessionManager?.getSessionDir?.();
  if (!roleBranch || !sessionDir) throw new Error("crew_read_context requires native session APIs");
  const { source, promptIndex } = latestContextSource(roleBranch);
  const priorReads = roleBranch.slice(promptIndex + 1).filter(entry => entry.message?.role === "toolResult" && entry.message.toolName === "crew_read_context");
  const usedChars = priorReads.reduce((sum, entry) => sum + (typeof entry.message?.details?.returnedChars === "number" ? entry.message.details.returnedChars : 0), 0);
  if (priorReads.length >= CONTEXT_MAX_CALLS || usedChars >= CONTEXT_MAX_CHARS) throw new Error("crew_read_context budget exhausted; request a targeted artifact or contract update");
  const native = parseNativeSession(readFileSync(resolveNativeSessionPath(sessionDir, source.parentSessionId), "utf8"));
  const readable = reconstructContextBranch(native.entries, source.upperBoundEntryId).filter(entry => !!visibleMessageText(entry));
  const limit = params.maxChars ?? CONTEXT_DEFAULT_PAGE_CHARS;
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTEXT_DEFAULT_PAGE_CHARS) throw new Error(`maxChars must be an integer from 1 through ${CONTEXT_DEFAULT_PAGE_CHARS}`);
  const allowedChars = Math.min(limit, CONTEXT_MAX_CHARS - usedChars);
  const binding = { source, mode: params.mode, query: params.query ?? null, entryId: params.entryId ?? null };
  let indices: number[]; let position = 0; let offset = 0;
  if (params.cursor) {
    const cursor = decodeContextCursor(params.cursor);
    if (JSON.stringify(cursor.binding) !== JSON.stringify(binding) || !Array.isArray(cursor.indices) || !cursor.indices.every((value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < readable.length) || !Number.isInteger(cursor.position) || cursor.position < 0 || cursor.position > cursor.indices.length || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error("Context cursor does not match this source and selection");
    indices = cursor.indices; position = cursor.position; offset = cursor.offset;
  } else if (params.mode === "search") {
    if (!params.query?.trim() || params.query.length > 200) throw new Error("search requires a non-blank query of at most 200 characters"); const needle = params.query.toLocaleLowerCase(); indices = readable.map((entry, index) => visibleMessageText(entry).toLocaleLowerCase().includes(needle) ? index : -1).filter(index => index >= 0).slice(0, 20);
  } else if (params.mode === "entry" || params.mode === "around") {
    if (!validEntryId(params.entryId)) throw new Error("entryId is required"); const found = readable.findIndex(entry => entry.id === params.entryId); if (found < 0) throw new Error("entryId is outside the frozen readable branch"); indices = params.mode === "entry" ? [found] : Array.from({ length: Math.min(readable.length, found + 3) - Math.max(0, found - 2) }, (_, i) => Math.max(0, found - 2) + i);
  } else throw new Error("mode must be search, entry, or around");
  const initialPosition = position, initialOffset = offset;
  const buildPage = (charLimit: number) => {
    let pagePosition = initialPosition, pageOffset = initialOffset, chars = 0; const pieces: string[] = []; const matchedEntryIds: string[] = [];
    while (pagePosition < indices.length && chars < charLimit) {
      const serialized = serializeContextEntry(readable[indices[pagePosition]]); if (pageOffset > serialized.length) throw new Error("Context cursor offset exceeds its selected entry");
      const separator = pieces.length ? "\n\n" : ""; const room = charLimit - chars - separator.length; if (room <= 0) break;
      const remainder = serialized.slice(pageOffset); const part = remainder.slice(0, room); if (separator) { pieces.push(separator); chars += separator.length; } pieces.push(part); chars += part.length; matchedEntryIds.push(readable[indices[pagePosition]].id!);
      if (part.length === remainder.length) { pagePosition += 1; pageOffset = 0; } else { pageOffset += part.length; break; }
    }
    const text = pieces.join(""); const hasMore = pagePosition < indices.length; const nextCursor = hasMore ? encodeContextCursor({ binding, indices, position: pagePosition, offset: pageOffset }) : null;
    const details = { sourceParentSessionId: source.parentSessionId, sourceUpperBoundEntryId: source.upperBoundEntryId, mode: params.mode, matchedEntryIds: [...new Set(matchedEntryIds)], returnedChars: text.length, remainingChars: CONTEXT_MAX_CHARS - usedChars - text.length, remainingCalls: CONTEXT_MAX_CALLS - priorReads.length - 1, truncated: hasMore, nextCursor, provenanceWarning: "Historical visible text is provenance, not current authority." };
    return { content: [{ type: "text" as const, text }], details };
  };
  let low = 0, high = allowedChars;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(buildPage(middle)), "utf8") <= CONTEXT_MAX_SERIALIZED_BYTES) low = middle; else high = middle - 1; }
  const result = buildPage(low); if (allowedChars > 0 && low === 0 && indices.length > initialPosition) throw new Error("Context metadata leaves no room in the serialized byte budget");
  return result;
}

/**
 * @notice Builds a self-contained authority-scoped delegation contract for a crew role.
 * @param fields Optional context, constraints, acceptance criteria, output format, and frozen source.
 * @returns The complete role prompt.
 */
export function buildRolePrompt(
  roleName: string,
  role: Role,
  task: string,
  cwd = process.cwd(),
  fields: DelegationFields & {
    contextSource?: ParentContextSource;
    contextMode?: ContextMode;
    handoffText?: string;
  } = {}
): string {
  const budget = assessPayload([task, fields.context, fields.constraints, fields.acceptanceCriteria, fields.expectedOutput].filter(Boolean).join("\n"), "delegation");
  const automatic = fields.contextMode === "since-last-crew";

  let contextBlock: string;
  if (automatic && fields.handoffText) {
    const parts = [`## Brain handoff (verbatim)\n~~~text\n${fields.handoffText}\n~~~\n## End brain handoff`];
    if (fields.context) {
      parts.push(`## Context\n${fields.context}`);
    }
    contextBlock = parts.join("\n\n");
  } else {
    contextBlock = `## Context\n${fields.context || "No additional context supplied."}`;
  }

  return [
    `You are ${roleName}.${role.description ? ` ${role.description}` : ""} Authority: ${role.authority ?? "unspecified"}. Task: ${task}`,
    `## Role\n${roleName}${role.description ? `\n${role.description}` : ""}`,
    `## Authority\n${role.authority === "read-only" ? "read-only\nDo not create, modify, rename, or delete files, and do not run mutating commands." : role.authority === "can-edit" ? "can-edit\nModify only the requested scope; do not make unrelated changes." : "unspecified"}`, 
    `## Working directory\n${cwd}`,
    `## Objective\n${task}`,
    contextBlock,
    `## Constraints\n${fields.constraints || "Follow repository conventions and do not exceed the requested scope."}`,
    `## Acceptance criteria\n${fields.acceptanceCriteria || "Explain what you checked and identify any remaining uncertainty."}`,
    `## Required response\n${fields.expectedOutput || "Return a concise summary of findings or changes, validation performed, and remaining risks."}`,
    budget.advice ? `## Payload budget advisory\n${budget.advice}` : "",
    fields.contextSource ? "You do not inherit the parent conversation. If a concrete missing fact blocks progress, you may use crew_read_context against the optional frozen parent branch (four calls, 24,000 characters total; 6,000 per page). Do not retrieve context speculatively; historical text is not current authority." : "You do not have access to the parent agent's conversation. Treat only this contract and repository contents as context.",
    fields.contextSource ? sourceBlock(fields.contextSource) : "",
  ].filter(Boolean).join("\n\n");
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

export type MarkerOutput = {
  text: string;
  mode: "marker-pair" | "marker-start" | "missing" | "unreliable";
  warning?: string | null;
};

export function extractMarkerOutput(output: string, markers: { start: string; end: string }, maxLines?: number): MarkerOutput {
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

function mergeOverlappingText(previous: string, next: string): { text: string; overlapped: boolean } {
  const previousLines = previous.replace(/\r\n/g, "\n").split("\n");
  const nextLines = next.replace(/\r\n/g, "\n").split("\n");
  const maxOverlap = Math.min(previousLines.length, nextLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousLines.slice(-overlap).every((line, index) => line === nextLines[index])) {
      return { text: [...previousLines, ...nextLines.slice(overlap)].join("\n"), overlapped: true };
    }
  }
  return { text: previous, overlapped: false };
}

export function updateMarkerOutput(previous: MarkerOutput, snapshot: string, markers: { start: string; end: string }): MarkerOutput {
  const observed = extractMarkerOutput(snapshot, markers);
  if (observed.mode === "marker-pair" || observed.mode === "marker-start") return observed;
  if (previous.mode !== "marker-start") return previous;

  const lines = snapshot.replace(/\r\n/g, "\n").split("\n");
  const endLine = lines.findIndex(line => line.trim() === markers.end);
  const continuation = (endLine >= 0 ? lines.slice(0, endLine) : lines).join("\n");
  const merged = mergeOverlappingText(previous.text, continuation);
  if (!merged.overlapped) {
    return {
      text: previous.text,
      mode: "unreliable",
      warning: "Discontinuity detected while stitching output: non-overlapping snapshot.",
    };
  }
  return {
    text: merged.text.trim(),
    mode: endLine >= 0 ? "marker-pair" : "marker-start",
  };
}

/**
 * @notice Removes known capability values from role-visible output.
 * @param secrets Exact additional secret values to replace.
 * @returns Redacted text safe for tool results and diagnostics.
 */
export function redactCapabilitySecrets(text: string, secrets: string[] = []): string {
  let redacted = text.replace(/(capabilityToken\s*:\s*)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

/**
 * @notice Extracts and bounds relevant role output after removing capability secrets.
 * @param prompt Submitted prompt used to discard echoed terminal content.
 * @param maxLines Optional diagnostic tail limit.
 * @param secrets Exact capability values that must not be returned.
 * @returns Compact redacted role output.
 */
export function compactRoleOutput(output: string, prompt: string, maxLines?: number, secrets: string[] = []): string {
  const normalized = redactCapabilitySecrets(output, secrets).replace(/\r\n/g, "\n");
  const safePrompt = redactCapabilitySecrets(prompt, secrets);
  const promptIndex = normalized.lastIndexOf(safePrompt);
  const relevant = promptIndex >= 0 ? normalized.slice(promptIndex + safePrompt.length) : normalized;
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

/**
 * @notice Verifies that an idle agent matches role, workspace, location, model, and effort constraints.
 * @returns Whether the agent can safely serve the requested delegation.
 */
export function isReusableRoleAgent(agent: AgentLike, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string, requestedEffort?: ThinkingLevel): boolean {
  const status = normalizedAgentStatus(agent);
  return (
    agent.name === role &&
    (status === "idle" || status === "done") &&
    agent.workspace_id === workspaceId &&
    (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
    (normalizedCwd(agent.foreground_cwd || agent.cwd || "") === normalizedCwd(cwd)) &&
    (!requestedModel || agent.model === requestedModel || agent.model_id === requestedModel) &&
    (!requestedEffort || agent.thinking_level === requestedEffort || agent.reasoning_level === requestedEffort) &&
    typeof agent.pane_id === "string" &&
    agent.pane_id.length > 0
  );
}

/**
 * @notice Selects the pane of a reusable candidate when all launch constraints match.
 * @returns The matching pane identifier, if available.
 */
export function findReusableRolePane(agent: AgentLike | undefined, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string, requestedEffort?: ThinkingLevel): string | undefined {
  return agent && isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel, requestedEffort) ? agent.pane_id : undefined;
}

/**
 * @notice Finds a reusable pane among currently known Herdr agents.
 * @returns The first matching pane identifier, if available.
 */
export function findReusableRolePaneInList(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string, requestedEffort?: ThinkingLevel): string | undefined {
  return agents.find((agent) => isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel, requestedEffort))?.pane_id;
}

/**
 * @notice Chooses a reusable or collision-free role name within Herdr naming limits.
 * @returns The agent name to reuse or assign.
 */
export function chooseAgentName(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string, requestedEffort?: ThinkingLevel): string {
  if (findReusableRolePaneInList(agents, role, workspaceId, cwd, tabId, requestedModel, requestedEffort)) return role;
  const baseName = roleNameInUse(agents, role) ? scopedRoleName(role, workspaceId, tabId) : role;
  if (findReusableRolePaneInList(agents, baseName, workspaceId, cwd, tabId, requestedModel, requestedEffort)) return baseName;
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

function logLifecycle(
  pi: ExtensionAPI,
  onUpdate: ToolUpdate | undefined,
  action: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  onUpdate?.({
    content: [{ type: "text", text: message }],
    details: { ...details, status: (details.status as string) ?? action },
  });
  pi.appendEntry?.("crew-lifecycle", {
    action,
    ...details,
  });
}

async function herdr(pi: ExtensionAPI, args: string[], timeout = PROMPT_TIMEOUT_MS, signal?: AbortSignal): Promise<ExecResult> {
  return pi.exec("herdr", args, { timeout, signal });
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

async function waitForAgentReady(pi: ExtensionAPI, paneId: string, timeoutMs: number, stableMs = STARTUP_READY_STABLE_MS): Promise<StartupState> {
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
        if (Date.now() - readySince >= stableMs) return { agent, status: "ready", output: lastOutput };
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

export type CrewStatus = "done" | "idle" | "working" | "blocked" | "timed_out" | "failed" | "unknown";
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

export async function getOrCorroborateAgent(pi: ExtensionAPI, agentName: string): Promise<AgentLike | undefined> {
  const agent = await maybeGetAgent(pi, agentName);
  if (agent) return agent;
  try {
    const agents = await listAgents(pi);
    return agents.find(a => a.name === agentName);
  } catch {
    return undefined;
  }
}

async function waitForAgentTransition(pi: ExtensionAPI, agentName: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  // This wait is an optimization, not an authority. A disappearance or bridge
  // error is reconciled by the following get/list observation.
  const result = await herdr(pi, ["agent", "wait", agentName, "--timeout", String(timeoutMs)], timeoutMs + 2_000, signal);
  return result.code === 0 || /timeout/i.test(result.stderr || result.stdout);
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

export function classifyDelegationResult(status: CrewStatus, markerMode: string): {
  settled: boolean;
  complete: boolean;
  agentContinues: boolean;
} {
  const settled = status === "done" || status === "idle";
  const complete = settled && markerMode === "marker-pair";
  const agentContinues = status === "working" || status === "timed_out" || status === "blocked" || status === "unknown";
  return { settled, complete, agentContinues };
}

export type PollingDependencies = {
  getAgent: (agentName: string) => Promise<AgentLike | undefined>;
  readOutput: (agentName: string, paneId: string, lines: number, currentAgent?: AgentLike) => Promise<string>;
  now: () => number;
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitForState?: (agentName: string, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
  onUpdate?: ToolUpdate;
};

export async function runCrewPollingLoop(
  params: {
    launchId?: string;
    roleName: string;
    agentName: string;
    paneId: string;
    markers: { start: string; end: string };
    reusedPane: boolean;
    submittedAt: number;
    timeoutMs: number;
    hardCapMs: number;
    readLines: number;
    signal?: AbortSignal;
  },
  deps: PollingDependencies
): Promise<{
  status: CrewStatus;
  output: string;
  markerOutput: MarkerOutput;
  observedWorking: boolean;
  heartbeatCount: number;
  agentExited: boolean;
  lastKnownAgent?: AgentLike;
}> {
  const {
    launchId,
    roleName,
    agentName,
    paneId,
    markers,
    reusedPane,
    submittedAt,
    timeoutMs,
    hardCapMs,
    readLines,
    signal,
  } = params;
  const { getAgent, readOutput, now, delay: delayFn, waitForState, onUpdate } = deps;

  let lastProgressAt = submittedAt;
  let previousEvidence = "";
  let observedWorking = false;
  let heartbeatCount = 0;
  let output = "";
  let currentAgent: AgentLike | undefined;
  let lastKnownAgent: AgentLike | undefined;
  let missingAgentSince: number | undefined;
  let consecutiveMissingCount = 0;
  let agentExited = false;
  let status: CrewStatus = "unknown";
  let markerOutput = extractMarkerOutput("", markers);

  while (true) {
    if (signal?.aborted) throw new Error("crew_launch was cancelled");
    currentAgent = await getAgent(agentName);
    if (currentAgent) {
      lastKnownAgent = currentAgent;
      missingAgentSince = undefined;
      consecutiveMissingCount = 0;
    } else {
      if (missingAgentSince === undefined) missingAgentSince = now();
      consecutiveMissingCount += 1;
    }
    status = classifyAgentStatus(currentAgent?.agent_status || currentAgent?.status);
    output = await readOutput(agentName, paneId, Math.max(readLines, MARKER_READ_LINES), currentAgent);
    markerOutput = updateMarkerOutput(markerOutput, output, markers);
    const settled = status === "done" || status === "idle";
    const evidence = `${status}\n${output}`;
    const currentTime = now();
    const evidenceChanged = evidence !== previousEvidence;
    if (evidenceChanged) {
      previousEvidence = evidence;
      lastProgressAt = currentTime;
    }
    if (status === "working") {
      observedWorking = true;
      // A positively working role is alive even when its visible output is unchanged.
      lastProgressAt = currentTime;
    }
    if (!currentAgent && consecutiveMissingCount >= 2 && currentTime - (missingAgentSince ?? submittedAt) >= PROMPT_START_GRACE_MS) {
      agentExited = true;
      status = "failed";
      break;
    }

    if (markerOutput.mode === "marker-pair" && settled) break;
    if (status === "blocked" || status === "failed") break;
    if (observedWorking && settled) break;
    if (!reusedPane && !observedWorking && settled && currentTime - submittedAt >= PROMPT_START_GRACE_MS) break;
    if (reusedPane && !observedWorking && settled && currentTime - submittedAt >= REUSED_IDLE_GRACE_MS) {
      status = "timed_out";
      break;
    }
    if (currentTime - submittedAt >= hardCapMs) {
      status = "timed_out";
      break;
    }
    if (currentTime - lastProgressAt >= timeoutMs) {
      status = "timed_out";
      break;
    }

    heartbeatCount += 1;
    const dots = ".".repeat(((heartbeatCount - 1) % 3) + 1);
    const observation = herdrObservation(currentAgent ?? lastKnownAgent);
    onUpdate?.({
      content: [{ type: "text", text: `Processing ${roleName}${dots}` }],
      details: {
        launchId,
        role: roleName,
        agentName,
        paneId,
        status,
        herdrStatus: observation.status,
        sessionRef: observation.sessionRef,
        piSessionId: observation.piSessionId,
        stateChangeSeq: observation.stateChangeSeq,
        revision: observation.revision,
        heartbeat: heartbeatCount,
        elapsedMs: currentTime - submittedAt,
        progress: evidenceChanged || status === "working",
      },
    });
    const pollMs = observedWorking ? ROLE_POLL_MS : Math.min(1_000, ROLE_POLL_MS);
    if (!waitForState || !await waitForState(agentName, pollMs, signal)) await delayFn(pollMs, signal);
  }

  return {
    status,
    output,
    markerOutput,
    observedWorking,
    heartbeatCount,
    agentExited,
    lastKnownAgent,
  };
}

type CrewLaunchParams = DelegationFields & {
  role?: string; task?: string; durable?: boolean; runId?: string; taskId?: string; attempt?: number; contractVersion?: string; baseSha?: string;
  managedAction?: "launch" | "status" | "wait" | "recover"; recoveryReason?: string; waitMs?: number;
  sourcePaths?: string[];
  riskClass?: RiskClass; reviewTiming?: ReviewTiming; launchId?: string;
  allowContextLookup?: boolean; contextSource?: ParentContextSource; parentSessionDir?: string;
  contextMode?: ContextMode; checkpointFallback?: CheckpointFallback; recentTurns?: number; maxHandoffChars?: number;
  handoffText?: string; branch?: SessionEntryLike[];
  ephemeral?: boolean; teardownGraceMs?: number;
  startupTimeoutMs?: number; timeoutMs?: number; hardCapMs?: number; readLines?: number; configCwd?: string; toolCallId?: string;
};

const ownerAccessBySession = new Map<string, Map<string, RunAccess>>();

function ownerAccessKey(repositoryId: string, runId: string): string {
  return `${repositoryId}/${runId}`;
}

function ownerAccessRecordPath(stateRoot: string, sessionId: string, repositoryId: string, runId: string): string {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return join(stateRoot, "owner-sessions", sessionHash, `${repositoryId}-${runId}.json`);
}

/**
 * @notice Associates durable run-owner access with a native session for later tool calls.
 * @param sessionId Stable native owner-session identifier.
 * @param access Run access coordinates and owner capability to persist.
 */
export function rememberOwnerAccess(sessionId: string, access: RunAccess): void {
  if (!sessionId) throw new Error("Managed durable mode requires a stable owner session ID");
  const runs = ownerAccessBySession.get(sessionId) ?? new Map<string, RunAccess>();
  runs.set(ownerAccessKey(access.repositoryId, access.runId), access);
  ownerAccessBySession.set(sessionId, runs);
  const path = ownerAccessRecordPath(access.stateRoot, sessionId, access.repositoryId, access.runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(access)}\n`, { mode: 0o600 });
}

/**
 * @notice Resolves task-token or originating-session access to a repository-bound run.
 * @param token Optional role capability; omitted access requires the owner session.
 * @param sessionId Optional originating owner-session identifier.
 * @returns Authorized run access coordinates.
 */
export function resolveArtifactAccess(cwd: string, runId: string, repositoryId: string, token?: string, sessionId?: string): RunAccess {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid runId");
  if (!/^[a-f0-9]{32}$/.test(repositoryId)) throw new Error("Invalid repositoryId");
  const actual = resolveRepositoryIdentity(cwd);
  if (actual.repositoryId !== repositoryId) throw new Error("repositoryId does not match the current Git repository");
  if (token) {
    const stateRoot = defaultCrewStateRoot();
    return { stateRoot, repositoryId, runId, runDir: join(stateRoot, repositoryId, runId), token };
  }
  let owner = sessionId ? ownerAccessBySession.get(sessionId)?.get(ownerAccessKey(repositoryId, runId)) : undefined;
  if (!owner && sessionId) {
    const stateRoot = defaultCrewStateRoot();
    const record = ownerAccessRecordPath(stateRoot, sessionId, repositoryId, runId);
    if (existsSync(record)) {
      const parsed = JSON.parse(readFileSync(record, "utf8")) as RunAccess;
      if (parsed.stateRoot !== stateRoot || parsed.repositoryId !== repositoryId || parsed.runId !== runId || parsed.runDir !== join(stateRoot, repositoryId, runId)) throw new Error("Invalid persisted owner access record");
      owner = parsed;
      const runs = ownerAccessBySession.get(sessionId) ?? new Map<string, RunAccess>();
      runs.set(ownerAccessKey(repositoryId, runId), owner);
      ownerAccessBySession.set(sessionId, runs);
    }
  }
  if (!owner) throw new Error("A task capability token or the originating owner session is required");
  return owner;
}

/**
 * @notice Delivers unread managed context notifications to the brain without failing the caller.
 * @returns The number of warnings queued and acknowledged.
 */
export async function deliverManagedContextWarnings(pi: ExtensionAPI, access: RunAccess): Promise<number> {
  let delivered = 0; let after: string | undefined;
  try {
    while (true) {
      const inbox = await readInbox(access, { after, limit: 100 });
      for (const message of inbox.messages) {
        if (message.acknowledged || message.category !== "notification" || !message.preview.startsWith("Crew context ")) continue;
        const artifact = await readArtifact(access, message.artifactId, { limit: 4_000 });
        if (!artifact.complete || artifact.metadata.recipient !== "brain" || !/^Crew context (?:warn|checkpoint):/.test(artifact.content)) continue;
        pi.sendMessage?.({ customType: "crew-context-warning", content: artifact.content, display: false, details: { artifactId: message.artifactId, runId: access.runId, taskId: message.taskId, attempt: message.attempt, propagatedFromChild: true } }, { deliverAs: "nextTurn", triggerTurn: false });
        await acknowledgeInbox(access, [message.artifactId]);
        pi.appendEntry?.("crew-context-warning-delivery", { status: "queued", artifactId: message.artifactId, runId: access.runId, taskId: message.taskId, attempt: message.attempt, recordedAt: new Date().toISOString() });
        delivered += 1;
      }
      if (inbox.messages.length < 100 || !inbox.nextCursor) break;
      after = inbox.nextCursor;
    }
  } catch (error) {
    // Warning delivery must not turn a completed launch/status check into a
    // failure. Persist the problem so it remains visible and retryable.
    pi.appendEntry?.("crew-context-warning-delivery", { status: "failed", runId: access.runId, error: error instanceof Error ? error.message : String(error), recordedAt: new Date().toISOString() });
  }
  return delivered;
}

/**
 * @notice Creates or resumes capability-gated state for a managed executor or reviewer launch.
 * @param options Launch identity, contract, owner session, and optional source scope.
 * @returns Managed run credentials and task metadata, or undefined when disabled.
 */
export async function prepareDurableLaunch(options: {
  enabled: boolean;
  baseCommand: "pic-proxy" | "pi";
  cwd: string;
  role: string;
  taskId: string;
  attempt?: number;
  runId?: string;
  contractVersion?: string;
  baseSha?: string;
  ownerSessionId?: string;
  stateRoot?: string;
  sourcePaths?: string[];
  riskClass?: RiskClass;
  reviewTiming?: ReviewTiming;
}): Promise<{ access: RunAccess; taskToken: string; attempt: number; contractVersion?: string; baseSha?: string; reportArtifactId?: string; headSha?: string; sourcePaths?: string[]; sessionGeneration: string } | undefined> {
  if (!options.enabled) return undefined;
  if (options.baseCommand === "pic-proxy") {
    throw new Error("Managed durable coordination is not supported through pic-proxy yet because host state and repository identity are not mounted. Retry with durable omitted/false, or launch in direct pi mode.");
  }
  if (!options.ownerSessionId) throw new Error("Managed durable coordination requires an active session ID; retry with durable omitted/false");
  const attempt = options.attempt ?? 1;
  try {
    let access: RunAccess;
    if (options.runId) {
      const identity = resolveRepositoryIdentity(options.cwd);
      access = resolveArtifactAccess(options.cwd, options.runId, identity.repositoryId, undefined, options.ownerSessionId);
    } else {
      access = await createRunState({ cwd: options.cwd, stateRoot: options.stateRoot, ownerSessionId: options.ownerSessionId });
      rememberOwnerAccess(options.ownerSessionId, access);
    }
    let existing: Awaited<ReturnType<typeof readTaskAttempt>> | undefined;
    try { existing = await readTaskAttempt(access, options.taskId, attempt); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.role === "executor") {
      if (!options.contractVersion || !options.baseSha) throw new Error("Managed executor launch requires contractVersion and baseSha");
      if (!existing) existing = await createTaskAttempt(access, { taskId: options.taskId, attempt, contractVersion: options.contractVersion, baseSha: options.baseSha, sourcePaths: options.sourcePaths, executorSessionGeneration: randomUUID(), riskClass: options.riskClass, reviewTiming: options.reviewTiming });
      if (existing.contractVersion !== options.contractVersion || existing.baseSha !== options.baseSha) throw new Error("Task attempt contract/base does not match the managed launch");
      if ((existing.riskClass ?? "major") !== (options.riskClass ?? "major") || (existing.reviewTiming ?? "immediate") !== (options.reviewTiming ?? "immediate")) throw new Error("Task attempt risk/review policy does not match the managed launch");
      if (existing.status !== "ready") throw new Error(`Executor attempt is ${existing.status}; use managedAction=status or recover instead of starting a competing writer`);
    } else if (options.role === "reviewer") {
      if (!existing) throw new Error("Reviewer launch requires an existing submitted task attempt");
      if (existing.status === "submitted" && existing.sourcePaths?.length) {
        const actual = captureSourceSnapshot(options.cwd, existing.sourcePaths);
        if (actual.id !== existing.sourceSnapshotId) throw new Error("Reviewer launch refused because the submitted source snapshot is stale");
      }
      if (existing.status === "submitted") existing = await beginTaskReview(access, options.taskId, attempt, randomUUID());
      else if (existing.status !== "reviewing") throw new Error(`Reviewer attempt is ${existing.status}, expected submitted or reviewing`);
    }
    const current = ["executor", "reviewer"].includes(options.role) ? await readTaskAttempt(access, options.taskId, attempt) : undefined;
    const taskToken = await createTaskCapability(access, { role: options.role, taskId: options.taskId, attempt });
    return { access, taskToken, attempt, contractVersion: current?.contractVersion, baseSha: current?.baseSha, reportArtifactId: current?.reportArtifactId, headSha: current?.headSha, sourcePaths: current?.sourcePaths, sessionGeneration: options.role === "reviewer" ? current?.reviewerSessionGeneration! : current?.executorSessionGeneration! };
  } catch (error) {
    throw new Error(`Managed durable coordination setup failed; retry with durable omitted/false after resolving Git/state-root access: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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

/**
 * @notice Orchestrates role launch, polling, output redaction, and optional artifact-gated completion.
 * @param params Delegation contract and lifecycle controls supplied by the crew tool.
 * @param signal Optional cancellation signal.
 * @param onUpdate Optional progress callback.
 * @param ownerSessionId Originating native session used for managed owner access.
 * @returns The crew tool result and structured lifecycle details.
 */
export async function executeCrewLaunch(
  pi: ExtensionAPI,
  params: CrewLaunchParams,
  signal?: AbortSignal,
  onUpdate?: ToolUpdate,
  ownerSessionId?: string,
  delayFn: (ms: number, signal?: AbortSignal) => Promise<void> = delay
) {
  const roleName = params.role ?? "scout";
  assertValidRoleName(roleName);
  const task = normalizeTask(params.task, params);
  const startupTimeoutMs = positiveInteger(params.startupTimeoutMs, STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const timeoutMs = positiveInteger(params.timeoutMs, PROMPT_TIMEOUT_MS, "timeoutMs");
  const hardCapMs = params.hardCapMs !== undefined ? positiveInteger(params.hardCapMs, timeoutMs * 2, "hardCapMs") : timeoutMs * 2;
  const readLines = positiveInteger(params.readLines, DEFAULT_READ_LINES, "readLines");
  const contextMode: ContextMode = params.contextMode ?? "explicit";
  if (params.contextMode !== undefined && params.contextMode !== "explicit" && params.contextMode !== "since-last-crew") {
    throw new Error("contextMode must be explicit or since-last-crew");
  }
  const checkpointFallback: CheckpointFallback = params.checkpointFallback ?? "recent";
  if (params.checkpointFallback !== undefined && params.checkpointFallback !== "recent" && params.checkpointFallback !== "explicit" && params.checkpointFallback !== "error") {
    throw new Error("checkpointFallback must be recent, explicit, or error");
  }
  const recentTurns = params.recentTurns !== undefined ? positiveInteger(params.recentTurns, 6, "recentTurns") : 6;
  const maxHandoffChars = params.maxHandoffChars !== undefined ? positiveInteger(params.maxHandoffChars, CONTEXT_MAX_CHARS, "maxHandoffChars") : CONTEXT_MAX_CHARS;
  if (params.teardownGraceMs !== undefined) {
    positiveInteger(params.teardownGraceMs, 5_000, "teardownGraceMs");
  }

  if (contextMode === "since-last-crew" && !params.handoffText && params.branch) {
    const handoff = buildHandoff(params.branch, params.toolCallId, contextMode, checkpointFallback, recentTurns, maxHandoffChars, params.context);
    params.handoffText = handoff.text;
  }
  const current = await functionalPreflight(pi);
  expectOk(current, "herdr pane current");
  const currentPane = parseJson(current.stdout, "herdr pane current").result?.pane;
  const reportedCwd = currentPane?.foreground_cwd || currentPane?.cwd;
  if (!reportedCwd) throw new Error("herdr pane current did not report a cwd");
  const roleCwd = normalizedCwd(reportedCwd);
  const workspaceId = currentPane?.workspace_id || "";
  const tabId = currentPane?.tab_id || "";
  const taskId = params.taskId ?? `task-${(params.toolCallId ?? randomTaskId()).replace(/[^A-Za-z0-9._-]/g, "-").slice(-64)}`;
  const launchId = params.launchId ?? `launch-${(params.toolCallId ?? randomTaskId()).replace(/[^A-Za-z0-9._-]/g, "-").slice(-64)}`;
  const attempt = params.attempt ?? 1;
  if (params.managedAction && params.managedAction !== "launch") {
    if (!params.runId || !params.taskId || !ownerSessionId) throw new Error("Managed status/recovery requires runId, taskId, and the originating owner session");
    const identity = resolveRepositoryIdentity(roleCwd);
    const access = resolveArtifactAccess(roleCwd, params.runId, identity.repositoryId, undefined, ownerSessionId);
    const before = await readTaskAttempt(access, params.taskId, attempt);
    if (params.managedAction === "status" || params.managedAction === "wait") {
      let currentState = before;
      if (params.managedAction === "wait") {
        const waitMs = Math.min(30_000, positiveInteger(params.waitMs, 15_000, "waitMs"));
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          await delay(Math.min(250, deadline - Date.now()), signal);
          currentState = await readTaskAttempt(access, params.taskId, attempt);
          if (currentState.updatedAt !== before.updatedAt || ["approved", "revision-needed", "blocked", "failed"].includes(currentState.status)) break;
        }
      }
      const changed = currentState.updatedAt !== before.updatedAt;
      const boundChild = currentState.childSession;
      const liveAgent = boundChild?.agentName ? await getOrCorroborateAgent(pi, boundChild.agentName) : undefined;
      const live = herdrObservation(liveAgent);
      const liveSession = live.sessionRef as ChildSessionBinding["sessionRef"] | undefined;
      const bindingMatches = !boundChild || !!liveAgent && liveAgent.pane_id === boundChild.paneId && (!boundChild.sessionRef || JSON.stringify(liveSession) === JSON.stringify(boundChild.sessionRef));
      const deliveredContextWarnings = await deliverManagedContextWarnings(pi, access);
      const status = { taskStatus: currentState.status, changed, updatedAt: currentState.updatedAt, childSession: boundChild ?? null, liveHerdr: liveAgent ? live : null, bindingMatches };
      return { content: [{ type: "text", text: JSON.stringify(status) }], details: { durableMode: "managed", runId: params.runId, taskId: params.taskId, attempt, lifecycleStatus: currentState.status, herdrStatus: live.status ?? null, childBindingMatches: bindingMatches, changed, complete: ["approved", "revision-needed", "blocked", "failed"].includes(currentState.status), deliveredContextWarnings } };
    }
    if (!params.recoveryReason?.trim()) throw new Error("Managed recovery requires recoveryReason");
    const boundAgentName = before.writerAgentName ?? before.childSession?.agentName;
    const boundPaneId = before.writerPaneId ?? before.childSession?.paneId;
    const agents = boundAgentName ? await listAgents(pi) : [];
    const agent = boundAgentName ? agents.find(item => item.name === boundAgentName) : undefined;
    if (agent && boundPaneId && agent.pane_id !== boundPaneId) throw new Error("Recovery refused: bound agent name now points to a different pane; reconcile the original pane manually");
    const liveness = classifyAgentStatus(agent?.agent_status ?? agent?.status);
    if (agent && !["idle", "done", "failed"].includes(liveness)) throw new Error(`Recovery refused: bound agent ${boundAgentName} is ${liveness}; resolve or stop the live agent first`);
    const recovered = before.status === "reviewing"
      ? await recoverTaskReview(access, params.taskId, attempt, true, params.recoveryReason.trim())
      : await recoverTaskAttempt(access, params.taskId, attempt, true, params.recoveryReason.trim());
    return { content: [{ type: "text", text: JSON.stringify(recovered) }], details: { durableMode: "managed", runId: params.runId, taskId: params.taskId, attempt, lifecycleStatus: recovered.status, recovered: true, agentLiveness: agent ? liveness : "absent" } };
  }
  const { config, path: configPath } = loadModelTiers(params.configCwd ?? roleCwd);
  const ephemeral = params.ephemeral ?? config.lifecycle?.ephemeral ?? false;
  const teardownGraceMs = positiveInteger(
    params.teardownGraceMs ?? config.lifecycle?.teardownGraceMs,
    5_000,
    "teardownGraceMs"
  );
  const configuredRoles = { ...config.roles, ...config.crewRoles };
  const roleNames = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(configuredRoles)]);
  const role = resolveRole(roleName, config);
  const basePrompt = buildRolePrompt(roleName, role, task, roleCwd, params);
  const markers = buildCrewMarkers(params.toolCallId ?? "crew_launch");
  const baseCommand = selectLaunchCommand();
  const durable = await prepareDurableLaunch({
    enabled: params.durable === true,
    baseCommand,
    cwd: roleCwd,
    role: roleName,
    taskId,
    attempt: params.attempt,
    runId: params.runId,
    contractVersion: params.contractVersion,
    baseSha: params.baseSha,
    ownerSessionId,
    sourcePaths: params.sourcePaths,
    riskClass: params.riskClass,
    reviewTiming: params.reviewTiming,
  });
  const durableContext = durable ? [
    "Managed durable lifecycle is enabled. Terminal markers are only a status signal: managed completion requires a finalized, current artifact with every required Markdown section.",
    `runId: ${durable.access.runId}`,
    `repositoryId: ${durable.access.repositoryId}`,
    `taskId: ${taskId}`,
    `attempt: ${durable.attempt}`,
    `contractVersion: ${durable.contractVersion}`,
    `baseSha: ${durable.baseSha}`,
    `riskClass: ${params.riskClass ?? (roleName === "executor" ? "major" : "review-target")}`,
    `reviewTiming: ${params.reviewTiming ?? (roleName === "executor" ? "immediate" : "review-target")}`,
    `sessionGeneration: ${durable.sessionGeneration}`,
    durable.sourcePaths?.length ? `sourceSnapshotPaths: ${durable.sourcePaths.join(", ")}` : "sourceSnapshotPaths: not configured (snapshot-bound review unavailable; disclose this limitation)",
    durable.headSha ? `exactReviewHeadSha: ${durable.headSha}` : "requiredReportSections: Summary, Validation, Assumptions, Risks",
    durable.reportArtifactId ? `requiredSubmittedReportArtifactId: ${durable.reportArtifactId}` : "Before publishing, call crew_control action=snapshot with this run/repository/task scope. Publish kind=report as executor and echo this exact contractVersion, baseSha, sourceSnapshotId, and resulting headSha.",
    roleName === "reviewer" ? "Publish kind=review with verdict PASS, REVISION_NEEDED, or BLOCKED and sections Verdict, Findings, Validation. The contract/base/head must exactly match the executor report." : "Check the addressed inbox before finalizing; unresolved blocking messages prevent submission.",
    `capabilityToken: ${durable.taskToken}`,
    "Publish in bounded chunks and finalize atomically. Use crew_read pagination to consume required evidence completely. Never include the capability token in reports, messages, final responses, details, or logs.",
    "These are API-level authorization guardrails, not a same-user OS sandbox: built-in filesystem reads can access local crew state, so do not use durable artifacts for confidentiality from local roles.",
  ].join("\n") : undefined;
  const prompt = appendMarkerInstruction(durableContext ? `${basePrompt}\n\n## Durable coordination\n${durableContext}` : basePrompt, markers);
  const launchModel = role.model;
  if (launchModel) {
    const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
    const catalog = parseModelCatalog(catalogResult.stdout);
    if (catalogResult.code !== 0 || modelMatch(launchModel, catalog) !== "exact") {
      const nearby = catalog.filter(id => id.toLowerCase().includes(launchModel.toLowerCase().split("/").pop() ?? "")).slice(0, 5);
      throw new Error(`Configured model ${launchModel} is not an exact match in the launch catalog.${nearby.length ? ` Nearby matches: ${nearby.join(", ")}` : " No nearby matches found."}`);
    }
  }
  const roleCommand = buildRoleCommand(baseCommand, launchModel, role.authority, durable?.access.stateRoot, role.effort, params.parentSessionDir);

  let agents = await listAgents(pi);
  // Managed or ephemeral panes must be freshly bootstrapped with the resolved state-root/lifecycle environment
  const namingAgents = (durable || ephemeral) ? agents.map(agent => ({ ...agent, agent_status: "working", status: "working" })) : agents;
  let agentName = chooseAgentName(namingAgents, roleName, workspaceId, roleCwd, tabId, role.model, role.effort);
  let paneId = (durable || ephemeral) ? undefined : findReusableRolePaneInList(agents, agentName, workspaceId, roleCwd, tabId, role.model, role.effort);
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

    const startup = await waitForAgentReady(pi, paneId, startupTimeoutMs, (params as any).startupReadyStableMs ?? STARTUP_READY_STABLE_MS);
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
      agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId, role.model, role.effort);
      rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
      renameConflictRecovered = rename.code === 0;
    }
    expectOk(rename, "herdr agent rename");

    const spawnLog = `crew: spawned ${roleName} in pane ${paneId} (${role.tier ?? role.model ?? "default model"}, workspace: ${workspaceId || "default"}, tab: ${tabId || "default"})`;
    logLifecycle(pi, onUpdate, "spawn", spawnLog, { launchId, role: roleName, agentName, paneId, status: "spawned", workspaceId, tabId, model: role.model, tier: role.tier, ephemeral });
  }

  const boundAgent = await getOrCorroborateAgent(pi, agentName) ?? agents.find(agent => agent.pane_id === paneId);
  const childObservation = herdrObservation(boundAgent);
  const childBinding: ChildSessionBinding = {
    launchId,
    agentName,
    paneId,
    workspaceId: (childObservation.workspaceId as string | undefined) ?? workspaceId,
    tabId: (childObservation.tabId as string | undefined) ?? tabId,
    sessionRef: childObservation.sessionRef as ChildSessionBinding["sessionRef"],
    piSessionId: childObservation.piSessionId as string | undefined,
    stateChangeSeq: childObservation.stateChangeSeq as number | undefined,
    herdrStatus: childObservation.status as string,
    observedAt: new Date().toISOString(),
  };
  if (durable && roleName === "reviewer") await bindTaskChildSession(durable.access, taskId, durable.attempt, childBinding);
  onUpdate?.({ content: [{ type: "text", text: `Starting ${roleName}…` }], details: { launchId, role: roleName, agentName, paneId, status: "starting", herdrStatus: childObservation.status, sessionRef: childObservation.sessionRef, piSessionId: childObservation.piSessionId, stateChangeSeq: childObservation.stateChangeSeq, revision: childObservation.revision, progress: true } });
  if (durable && roleName === "executor") {
    await acquireWriterOwnership(durable.access, taskId, durable.attempt, agentName, paneId);
    await bindTaskChildSession(durable.access, taskId, durable.attempt, childBinding);
  }
  const promptResult = await herdr(pi, ["agent", "prompt", agentName, prompt], 10_000);
  if (promptResult.code !== 0) {
    const liveAfterFailure = await getOrCorroborateAgent(pi, agentName);
    const failureLiveness = classifyAgentStatus(liveAfterFailure?.agent_status ?? liveAfterFailure?.status);
    const provenInactive = !liveAfterFailure || ["idle", "done", "failed"].includes(failureLiveness);
    if (durable && provenInactive && roleName === "executor") await recoverTaskAttempt(durable.access, taskId, durable.attempt, true, "Prompt submission failed before writer execution");
    if (durable && provenInactive && roleName === "reviewer") await recoverTaskReview(durable.access, taskId, durable.attempt, true, "Prompt submission failed before reviewer execution");
    const diagnostic = redactCapabilitySecrets(await readAgent(pi, agentName, FAILURE_READ_LINES), durable ? [durable.taskToken] : []);
    const error = new Error(`crew role prompt submission failed for ${agentName}: ${redactCapabilitySecrets(promptResult.stderr || promptResult.stdout, durable ? [durable.taskToken] : [])}\n\n${diagnostic}`) as Error & { details?: unknown };
    error.details = { paneId, status: failureLiveness === "blocked" ? "blocked" : failureLiveness === "working" ? "working" : "failed", agentContinues: !provenInactive };
    throw error;
  }
  if (durable && roleName === "executor") await markWriterRunning(durable.access, taskId, durable.attempt);
  onUpdate?.({
    content: [{ type: "text", text: `Prompted ${roleName}; waiting for Herdr lifecycle updates…` }],
    details: {
      launchId, role: roleName, agentName, paneId, status: "working", herdrStatus: childObservation.status,
      lifecycleStatus: durable ? roleName === "executor" ? "running" : roleName === "reviewer" ? "reviewing" : undefined : undefined,
      runId: durable?.access.runId, repositoryId: durable?.access.repositoryId, taskId: durable ? taskId : undefined, attempt: durable?.attempt,
      sessionRef: childObservation.sessionRef, piSessionId: childObservation.piSessionId,
      stateChangeSeq: childObservation.stateChangeSeq, revision: childObservation.revision, progress: true,
    },
  });

  const submittedAt = Date.now();
  const pollingResult = await runCrewPollingLoop(
    {
      launchId,
      roleName,
      agentName,
      paneId,
      markers,
      reusedPane: !createdPane,
      submittedAt,
      timeoutMs,
      hardCapMs,
      readLines,
      signal,
    },
    {
      getAgent: (name) => getOrCorroborateAgent(pi, name),
      readOutput: (name, pId, lines, curAgent) =>
        curAgent ? readAgent(pi, name, lines) : readPane(pi, pId, lines),
      now: () => Date.now(),
      delay: (ms, sig) => delayFn(ms, sig),
      waitForState: (name, ms, sig) => waitForAgentTransition(pi, name, ms, sig),
      onUpdate,
    }
  );

  const {
    status,
    output,
    markerOutput,
    observedWorking,
    heartbeatCount,
    agentExited,
    lastKnownAgent,
  } = pollingResult;

  const markerResult = classifyDelegationResult(status, markerOutput.mode);
  let managedTaskState;
  let managedError: string | undefined;
  if (durable && ["executor", "reviewer"].includes(roleName)) {
    try {
      const finalChild = herdrObservation(lastKnownAgent ?? boundAgent);
      await bindTaskChildSession(durable.access, taskId, durable.attempt, {
        launchId,
        agentName,
        paneId,
        workspaceId: finalChild.workspaceId as string | undefined,
        tabId: finalChild.tabId as string | undefined,
        sessionRef: finalChild.sessionRef as ChildSessionBinding["sessionRef"],
        piSessionId: finalChild.piSessionId as string | undefined,
        stateChangeSeq: finalChild.stateChangeSeq as number | undefined,
        herdrStatus: finalChild.status as string,
        observedAt: new Date().toISOString(),
      });
      if (!markerResult.settled) throw new Error(`Managed completion requires a quiescent role; observed ${status}`);
      if (durable.sourcePaths?.length) {
        const snapshot = captureSourceSnapshot(roleCwd, durable.sourcePaths);
        if (roleName === "reviewer" && snapshot.id !== (await readTaskAttempt(durable.access, taskId, durable.attempt)).sourceSnapshotId) throw new Error("Source snapshot changed during or before independent review");
        managedTaskState = roleName === "executor"
          ? await submitTaskAttempt(durable.access, taskId, durable.attempt, undefined, snapshot.id)
          : await completeTaskReview(durable.access, taskId, durable.attempt);
      } else {
        managedTaskState = roleName === "executor"
          ? await submitTaskAttempt(durable.access, taskId, durable.attempt)
          : await completeTaskReview(durable.access, taskId, durable.attempt);
      }
    } catch (error) {
      managedError = error instanceof Error ? error.message : String(error);
    }
  }
  const lifecycleManaged = !!durable && ["executor", "reviewer"].includes(roleName);
  const complete = lifecycleManaged ? !!managedTaskState : markerResult.complete;
  const settled = lifecycleManaged ? complete : markerResult.settled;
  const agentContinues = complete ? false : markerResult.agentContinues;

  const compactOutput = complete
    ? lifecycleManaged
      ? JSON.stringify({ status: managedTaskState!.status, taskId, attempt: durable!.attempt, reportArtifactId: managedTaskState!.reportArtifactId, reviewArtifactId: managedTaskState!.reviewArtifactId })
      : boundedLines(markerOutput.text)
    : `[CREW STATUS: ${status}; complete: false] ${managedError ? `Managed completion rejected: ${managedError}` : settled ? "The role settled without a confirmed final marker pair; this is incomplete diagnostic output, not a final answer." : "The role did not complete. This is partial diagnostic output, not a final answer."}\n\n${compactRoleOutput(output, prompt, readLines, durable ? [durable.taskToken] : [])}`;

  let tornDown = false;
  let removalLogged = false;
  const isWriter = role.authority === "can-edit";
  const canTeardown = ephemeral && !!createdPane && !isWriter;

  if (canTeardown && complete) {
    const summaryMsg = `crew: ${roleName} completed in pane ${createdPane}. Summary:\n${compactOutput}`;
    logLifecycle(pi, onUpdate, "summary", summaryMsg, { role: roleName, agentName, paneId: createdPane, status: "summary", summary: compactOutput });

    try {
      try {
        await delayFn(teardownGraceMs, signal);
      } catch {
        // Skip remaining grace wait if cancelled, and still attempt clean teardown
      }
      const closeResult = await herdr(pi, ["pane", "close", createdPane]);
      expectOk(closeResult, "herdr pane close");
      tornDown = true;
      const removalMsg = `crew: removed ${roleName} pane ${createdPane} after successful run`;
      logLifecycle(pi, onUpdate, "remove", removalMsg, { role: roleName, agentName, paneId: createdPane, status: "removed", ephemeral: true });
      removalLogged = true;
    } catch (teardownError) {
      const failMsg = `crew: warning - failed to close pane ${createdPane}: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`;
      logLifecycle(pi, onUpdate, "teardown-failed", failMsg, { role: roleName, agentName, paneId: createdPane, error: teardownError instanceof Error ? teardownError.message : String(teardownError) });
    }
  } else if (ephemeral && !complete) {
    const retentionReason = status !== "done" && status !== "idle" ? status : "incomplete marker output";
    const retentionMsg = `crew: retained ${roleName} pane ${paneId} (${retentionReason}; inspect pane for diagnostics)`;
    logLifecycle(pi, onUpdate, "retain", retentionMsg, { role: roleName, agentName, paneId, status: "retained", retentionReason, ephemeral: true });
  } else if (ephemeral && isWriter) {
    const retentionMsg = `crew: retained writer pane ${paneId} (writer panes cannot be torn down ephemerally)`;
    logLifecycle(pi, onUpdate, "retain", retentionMsg, { role: roleName, agentName, paneId, status: "retained", retentionReason: "writer", reason: "writer", ephemeral: true });
  }

  const deliveredContextWarnings = durable ? await deliverManagedContextWarnings(pi, durable.access) : 0;
  const finalObservation = herdrObservation(lastKnownAgent ?? boundAgent);
  return {
    content: [{ type: "text", text: compactOutput }],
    details: {
      version: VERSION,
      launchId,
      role: roleName,
      agentName,
      tabId,
      paneId,
      createdPane,
      reusedPane: !createdPane,
      ephemeral,
      tornDown,
      teardownGraceMs,
      removalLogged,
      workspaceId,
      cwd: roleCwd,
      command: baseCommand,
      requestedModel: role.model ?? null,
      requestedEffort: role.effort ?? null,
      actualModel: lastKnownAgent?.model ?? lastKnownAgent?.model_id ?? null,
      actualEffort: lastKnownAgent?.thinking_level ?? lastKnownAgent?.reasoning_level ?? null,
      actualModelKnown: !!(lastKnownAgent?.model ?? lastKnownAgent?.model_id),
      modelWarning: role.model && lastKnownAgent?.model && lastKnownAgent.model !== role.model ? `Running model ${lastKnownAgent.model} differs from requested ${role.model}.` : (!createdPane && role.model ? "Reused pane model was not queried." : null),
      status,
      herdrStatus: finalObservation.status,
      sessionRef: finalObservation.sessionRef ?? null,
      piSessionId: finalObservation.piSessionId ?? null,
      stateChangeSeq: finalObservation.stateChangeSeq ?? null,
      revision: finalObservation.revision ?? null,
      complete,
      agentContinues,
      agentExited,
      heartbeatCount,
      elapsedMs: Date.now() - submittedAt,
      authority: role.authority ?? null,
      riskClass: params.riskClass ?? null,
      reviewTiming: params.reviewTiming ?? null,
      contextMode,
      configPath: configPath ?? null,
      splitPolicy: splitPolicy ?? null,
      renameConflictRecovered,
      markerFound: markerOutput.mode !== "missing",
      extractionMode: markerOutput.mode === "missing" ? "prompt-fallback" : markerOutput.mode,
      extractionWarning: markerOutput.warning ?? (markerOutput.mode !== "marker-pair" || !complete ? "No confirmed final marker pair for a completed delegation." : null),
      outputLineCount: output.split(/\r?\n/).filter(Boolean).length,
      markerCaptureLines: Math.max(readLines, MARKER_READ_LINES),
      compactOutputLineCount: compactOutput.split(/\r?\n/).filter(Boolean).length,
      durableMode: durable ? "managed" : "legacy",
      runId: durable?.access.runId ?? null,
      repositoryId: durable?.access.repositoryId ?? null,
      taskId: durable ? taskId : null,
      attempt: durable?.attempt ?? null,
      lifecycleStatus: managedTaskState?.status ?? null,
      reportArtifactId: managedTaskState?.reportArtifactId ?? durable?.reportArtifactId ?? null,
      reviewArtifactId: managedTaskState?.reviewArtifactId ?? null,
      managedCompletionError: managedError ?? null,
      deliveredContextWarnings,
    },
  };
}

function randomTaskId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  const { config, path: configPath } = loadModelTiers(configCwd ?? process.cwd());
  const configuredRoles = { ...config.roles, ...config.crewRoles };
  const roleNames = [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(configuredRoles)])].sort();
  const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
  const catalog = parseModelCatalog(catalogResult.stdout);
  const roles = Object.fromEntries(roleNames.map((name) => {
    const role = resolveRole(name, config);
    const modelState = role.model ? modelMatch(role.model, catalog) : "default";
    const catalogPresent = role.model ? (catalogResult.code === 0 && modelState === "exact") : null;
    return [name, {
      description: role.description ?? null,
      authority: role.authority ?? null,
      tier: role.tier ?? null,
      configured: role.tier ?? role.model ?? null,
      model: role.model ?? null,
      effort: role.effort ?? null,
      reasoning: role.reasoning ?? role.effort ?? null,
      modelState,
      catalogPresent,
      authenticationUnknown: true,
      launchable: role.model ? catalogPresent : true,
      currentlyUsed: null,
    }];
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ configPath: configPath ?? null, roles }, null, 2) }],
    details: { version: VERSION, configPath: configPath ?? null, roles },
  };
}

function managedCoordinates(branch: SessionEntryLike[] | undefined): { runId: string; repositoryId: string; taskId: string; attempt: number; token: string } | undefined {
  if (!branch) return undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]; if (entry.message?.role !== "user") continue;
    const raw = typeof entry.message.content === "string" ? entry.message.content : Array.isArray(entry.message.content) ? entry.message.content.map((part: any) => part?.type === "text" ? part.text : "").join("\n") : "";
    const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(raw)?.[1];
    const runId = field("runId"), repositoryId = field("repositoryId"), taskId = field("taskId"), token = field("capabilityToken"), attempt = Number(field("attempt"));
    if (runId && repositoryId && taskId && token && Number.isInteger(attempt) && attempt > 0) return { runId, repositoryId, taskId, token, attempt };
    return undefined;
  }
  return undefined;
}

/**
 * @notice Registers crew launch, durable coordination, context, and rules integrations with Pi.
 * @param pi Extension API used to register tools, commands, and lifecycle handlers.
 */
export default function crewExtension(pi: ExtensionAPI) {
  const childLaunches = new Map<string, ChildLaunchRecord>();

  const updateCrewStatusUi = (ctx?: ToolContext) => {
    if (!ctx?.ui?.setStatus) return;
    const records = [...childLaunches.values()];
    const running = records.filter(isActiveChild).length;
    const blocked = records.filter(record => record.controllerStatus === "blocked").length;
    const attention = records.filter(record =>
      ["timed_out", "lost", "replaced", "failed"].includes(record.controllerStatus) ||
      (record.controllerStatus === "settled" && !record.complete) ||
      ["revision-needed", "blocked", "failed"].includes(record.taskStatus ?? "")
    ).length;
    const parts = [running ? `${running} running` : "", blocked ? `${blocked} blocked` : "", attention ? `${attention} attention` : ""].filter(Boolean);
    ctx.ui.setStatus("crew", parts.length ? `crew: ${parts.join(" · ")}` : undefined);
  };

  const trackChild = (details: unknown, ctx?: ToolContext): ChildLaunchRecord | undefined => {
    if (!details || typeof details !== "object") return undefined;
    const input = details as Record<string, unknown>;
    if (typeof input.launchId !== "string" || typeof input.role !== "string") return undefined;
    const previous = childLaunches.get(input.launchId);
    const { record, changed } = reconcileChildLaunch(previous, input);
    childLaunches.set(record.launchId, record);
    if (changed) pi.appendEntry?.("crew-child-lifecycle", record);
    updateCrewStatusUi(ctx);
    return record;
  };

  const childStatusSnapshot = async (query: { launchId?: string; runId?: string; taskId?: string; activeOnly?: boolean; refresh?: boolean }, ctx?: ToolContext) => {
    let records = [...childLaunches.values()].filter(record =>
      (!query.launchId || record.launchId === query.launchId) &&
      (!query.runId || record.runId === query.runId) &&
      (!query.taskId || record.taskId === query.taskId) &&
      (!query.activeOnly || isActiveChild(record)));
    if (query.refresh) {
      for (const record of records) {
        let lifecycleStatus = record.taskStatus;
        if (ctx?.cwd && record.runId && record.repositoryId && record.taskId && record.attempt) {
          try {
            const access = resolveArtifactAccess(ctx.cwd, record.runId, record.repositoryId, undefined, ctx.sessionManager?.getSessionId?.());
            lifecycleStatus = (await readTaskAttempt(access, record.taskId, record.attempt)).status;
          } catch {
            // Herdr status remains useful when durable owner state is unavailable.
          }
        }
        const managedComplete = lifecycleStatus ? ["approved", "revision-needed", "blocked", "failed"].includes(lifecycleStatus) : false;
        if (!record.agentName || !record.agentContinues) {
          trackChild({ launchId: record.launchId, role: record.role, lifecycleStatus, complete: record.complete || managedComplete, agentContinues: record.agentContinues, status: record.controllerStatus, herdrStatus: record.herdrStatus }, ctx);
          continue;
        }
        const agent = await getOrCorroborateAgent(pi, record.agentName);
        const observation = agent ? herdrObservation(agent) : { status: "failed", agentExited: true };
        trackChild({ ...observation, launchId: record.launchId, role: record.role, agentName: record.agentName, paneId: agent?.pane_id ?? record.paneId, runId: record.runId, repositoryId: record.repositoryId, taskId: record.taskId, attempt: record.attempt, lifecycleStatus, complete: record.complete || managedComplete, agentContinues: agent ? undefined : false }, ctx);
      }
      records = records.map(record => childLaunches.get(record.launchId) ?? record);
    }
    return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  };

  const parameters = { type: "object", required: ["role", "task"], properties: {
    role: { type: "string", description: "Crew role name, such as scout, oracle, executor, or reviewer." },
    task: { type: "string", description: "Self-contained delegation objective. The role cannot see the parent conversation. Put concrete supporting information in context, constraints, acceptanceCriteria, and expectedOutput; avoid a task made only of unresolved references such as 'implement it'." },
    context: { type: "string", description: "Relevant prior decisions, files, findings, or requirements." }, constraints: { type: "string", description: "Boundaries and invariants." },
    acceptanceCriteria: { type: "string", description: "How the result should be judged." }, expectedOutput: { type: "string", description: "Required response format." },
    durable: { type: "boolean", description: "Explicitly opt into managed durable artifacts and artifact-gated lifecycle. Defaults to false (legacy launch). Currently unsupported through pic-proxy." },
    runId: { type: "string", description: "Brain-owned managed run to reuse. Omit only when creating the run with its first executor task." },
    taskId: { type: "string", description: "Stable managed task identity. Required to hand an executor attempt to a reviewer." },
    attempt: { type: "number", description: "Managed task attempt. Defaults to 1." },
    contractVersion: { type: "string", description: "Immutable contract version for a managed executor attempt." },
    baseSha: { type: "string", description: "Exact base commit for a managed executor attempt." },
    managedAction: { type: "string", enum: ["launch", "status", "wait", "recover"], description: "Launch (default), inspect/wait for resumable managed state without a model call, or recover after deterministic liveness reconciliation." },
    waitMs: { type: "number", description: "For managedAction=wait, deterministic non-model wait up to 30000ms." },
    sourcePaths: { type: "array", items: { type: "string" }, description: "Explicit repository-relative source paths included in the uncommitted review fingerprint." },
    riskClass: { type: "string", enum: ["standard", "major"], description: "Planned phase risk. Standard work defers review; major work reviews immediately." },
    reviewTiming: { type: "string", enum: ["final", "immediate"], description: "Review timing paired with riskClass." },
    launchId: { type: "string", description: "Stable child-launch identity. Defaults to the crew_launch tool call ID." },
    allowContextLookup: { type: "boolean", description: "Opt in to bounded lookup of concrete missing facts from this frozen parent-session branch; never replays history automatically." },
    contextMode: { type: "string", enum: ["explicit", "since-last-crew"], description: "Parent context handoff mode: explicit (default, context-free) or since-last-crew (bounded automatic handoff from previous completed crew checkpoint)." },
    checkpointFallback: { type: "string", enum: ["recent", "explicit", "error"], description: "Fallback strategy when no completed crew checkpoint is found: recent (default, serialize recent N user turns), explicit (use explicit context), or error." },
    recentTurns: { type: "number", description: "Number of recent user turns to include when falling back to recent turns. Defaults to 6." },
    maxHandoffChars: { type: "number", description: "Maximum character budget for the pushed brain handoff. Defaults to 24000." },
    ephemeral: { type: "boolean", description: "Whether to tear down the spawned role pane after successful completion. Defaults to false (or lifecycle.ephemeral from config)." },
    teardownGraceMs: { type: "number", description: "Grace wait in milliseconds before closing an ephemeral pane on success. Defaults to 5000 (or lifecycle.teardownGraceMs from config)." },
    recoveryReason: { type: "string", description: "Required audit reason for managed recovery." },
    startupTimeoutMs: { type: "number", description: "Maximum startup detection wait. Defaults to 120000." }, timeoutMs: { type: "number", description: "Maximum inactivity wait after prompt submission. Progress and a working agent refresh this timeout up to a hard ceiling (default 2x timeoutMs). Defaults to 120000." }, hardCapMs: { type: "number", description: "Hard maximum total runtime ceiling after prompt submission that cannot be refreshed by activity. Defaults to 2x timeoutMs." }, readLines: { type: "number", description: "Line bound for partial/diagnostic output when a role does not complete. The full marked final answer is returned in full on success (capped only by the ~2000-line capture window). Defaults to 200." }, configCwd: { type: "string", description: "Explicit config lookup override." },
  }, additionalProperties: false };
  const execute = async (toolCallId: string, rawParams: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate, ctx?: ToolContext) => {
    const params = { ...((rawParams ?? {}) as CrewLaunchParams), toolCallId };
    params.launchId ??= `launch-${toolCallId.replace(/[^A-Za-z0-9._-]/g, "-").slice(-64)}`;
    if (params.allowContextLookup) {
      const parentSessionId = ctx?.sessionManager?.getSessionId?.(); const upperBoundEntryId = ctx?.sessionManager?.getLeafId?.(); const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!parentSessionId || !upperBoundEntryId || !sessionFile) throw new Error("allowContextLookup requires a persisted native parent session with a frozen branch leaf");
      params.contextSource = { version: 1, parentSessionId, upperBoundEntryId };
      params.parentSessionDir = realpathSync(dirname(sessionFile));
    }
    const branch = ctx?.sessionManager?.getBranch?.();
    if (params.contextMode === "since-last-crew" && branch) {
      params.branch = branch;
      const handoff = buildHandoff(
        branch,
        toolCallId,
        params.contextMode,
        params.checkpointFallback,
        params.recentTurns,
        params.maxHandoffChars,
        params.context
      );
      params.handoffText = handoff.text;
    }
    let executionCwd: string | undefined;
    try {
      const currentResult = await herdr(pi, ["pane", "current", "--current"]);
      if (currentResult.code === 0) {
        const currentPane = parseJson(currentResult.stdout, "herdr pane current").result?.pane;
        executionCwd = currentPane?.foreground_cwd || currentPane?.cwd;
      }
    } catch {
      // herdr query is best-effort
    }
    const { key } = resolveQueueKey(params.role ?? "scout", executionCwd || ctx?.cwd || process.cwd());
    const trackedUpdate: ToolUpdate = partial => {
      trackChild(partial.details, ctx);
      onUpdate?.(partial);
    };
    return enqueueCrewLaunch(key, async () => {
      try {
        const result = await executeCrewLaunch(pi, params, signal, trackedUpdate, ctx?.sessionManager?.getSessionId?.());
        trackChild((result as ToolResult).details, ctx);
        return result;
      } catch (error) {
        const failure = error && typeof error === "object" && "details" in error && (error as any).details && typeof (error as any).details === "object" ? (error as any).details : {};
        trackChild({ launchId: params.launchId, role: params.role ?? "scout", status: failure.status ?? "failed", paneId: failure.paneId, complete: false, agentContinues: failure.agentContinues === true }, ctx);
        throw error;
      }
    });
  };
  pi.registerTool({ name: "crew_launch", label: "Crew Launch", description: "Run or reuse a visible Herdr role pane and return structured status.", promptSnippet: "Delegate a self-contained task to a visible Herdr role pane.", promptGuidelines: ["Use crew_launch for delegation.", "Fully expand context; the role cannot see the parent conversation."], parameters, execute });

  pi.registerTool({
    name: "crew_status",
    label: "Crew Status",
    description: "Read and optionally refresh normalized child-launch, Herdr-session, and managed-task status without prompting a model.",
    promptSnippet: "Inspect active or recent crew child status by stable launch identity.",
    parameters: {
      type: "object",
      properties: {
        launchId: { type: "string" }, runId: { type: "string" }, taskId: { type: "string" },
        activeOnly: { type: "boolean" }, refresh: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const records = await childStatusSnapshot((rawParams ?? {}) as any, ctx);
      return { content: [{ type: "text", text: JSON.stringify({ count: records.length, records }) }], details: { count: records.length, records } };
    },
  });

  pi.registerTool({
    name: "crew_read_context",
    label: "Crew Read Context",
    description: "Optionally retrieve a bounded visible-text passage from the frozen invoking-parent branch for one concrete missing fact.",
    promptSnippet: "Search an explicitly enabled frozen parent branch only when a concrete fact is missing.",
    parameters: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["search", "entry", "around"] }, query: { type: "string" }, entryId: { type: "string" }, maxChars: { type: "number" }, cursor: { type: "string" } }, additionalProperties: false },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      if (!ctx) throw new Error("crew_read_context requires native session context");
      return executeReadContext((rawParams ?? {}) as ReadContextParams, ctx);
    },
  });

  pi.registerTool({
    name: "crew_publish",
    label: "Crew Publish",
    description: "Publish an immutable crew artifact with API-level capability checks (not a same-user filesystem confidentiality boundary). Call begin, append each sequential chunk, then finalize.",
    promptSnippet: "Publish durable task evidence or addressed crew messages.",
    promptGuidelines: ["Use crew_publish for authoritative handoffs that may exceed terminal capture; never expose capability tokens in prose."],
    parameters: {
      type: "object",
      required: ["action", "runId", "repositoryId"],
      properties: {
        action: { type: "string", enum: ["begin", "append", "finalize"] },
        runId: { type: "string" }, repositoryId: { type: "string" }, token: { type: "string" },
        publicationId: { type: "string" }, index: { type: "number" }, content: { type: "string" }, chunkCount: { type: "number" },
        kind: { type: "string", enum: ["report", "review", "message", "checkpoint"] }, taskId: { type: "string" }, attempt: { type: "number" }, phaseId: { type: "string" },
        recipient: { type: "string" }, category: { type: "string", enum: ["question", "answer", "finding", "dependency-change", "notification"] },
        replyTo: { type: "string" }, blocking: { type: "boolean" }, verdict: { type: "string", enum: ["PASS", "REVISION_NEEDED", "BLOCKED"] },
        contractVersion: { type: "string" }, baseSha: { type: "string" }, headSha: { type: "string" }, sourceSnapshotId: { type: "string" },
        requiredSections: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      if (!ctx?.cwd) throw new Error("crew_publish requires an active session cwd");
      const params = rawParams as Record<string, any>;
      const access = resolveArtifactAccess(ctx.cwd, params.runId, params.repositoryId, params.token, ctx.sessionManager?.getSessionId?.());
      if (params.action === "begin") {
        if (!params.kind) throw new Error("crew_publish begin requires kind");
        const metadata: PublicationMetadata = {
          kind: params.kind, taskId: params.taskId, attempt: params.attempt, phaseId: params.phaseId, recipient: params.recipient,
          category: params.category, replyTo: params.replyTo, blocking: params.blocking, verdict: params.verdict,
          contractVersion: params.contractVersion, baseSha: params.baseSha, headSha: params.headSha, sourceSnapshotId: params.sourceSnapshotId, requiredSections: params.requiredSections,
        };
        const publicationId = await beginPublication(access, metadata);
        return { content: [{ type: "text", text: JSON.stringify({ publicationId, nextAction: "append", nextIndex: 0 }) }], details: { publicationId } };
      }
      if (params.action === "append") {
        if (!params.publicationId || params.index === undefined || params.content === undefined) throw new Error("crew_publish append requires publicationId, index, and content");
        await appendPublicationChunk(access, params.publicationId, params.index, params.content);
        return { content: [{ type: "text", text: JSON.stringify({ publicationId: params.publicationId, acceptedIndex: params.index, nextIndex: params.index + 1 }) }] };
      }
      if (params.action === "finalize") {
        if (!params.publicationId || params.chunkCount === undefined) throw new Error("crew_publish finalize requires publicationId and chunkCount");
        const result = await finalizePublication(access, params.publicationId, params.chunkCount);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      throw new Error("crew_publish action must be begin, append, or finalize");
    },
  });

  pi.registerTool({
    name: "crew_read",
    label: "Crew Read",
    description: "Read immutable artifacts or addressed inbox deltas, and explicitly acknowledge messages, through API-level capability checks. Artifact pages are checksum-verified and byte-budgeted. This is not a same-user filesystem confidentiality boundary.",
    promptSnippet: "Read durable crew evidence or addressed inbox deltas with explicit acknowledgement.",
    promptGuidelines: ["Use crew_read pagination until complete when an artifact is required evidence; previews do not acknowledge or resolve messages."],
    parameters: {
      type: "object",
      required: ["runId", "repositoryId"],
      properties: {
        action: { type: "string", enum: ["artifact", "inbox", "acknowledge", "recover-evidence"] },
        runId: { type: "string" }, repositoryId: { type: "string" }, token: { type: "string" }, artifactId: { type: "string" },
        artifactIds: { type: "array", items: { type: "string" } }, after: { type: "string" }, blockerAfter: { type: "string" }, offset: { type: "number" }, limit: { type: "number" },
        section: { type: "string" }, query: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      if (!ctx?.cwd) throw new Error("crew_read requires an active session cwd");
      const params = rawParams as Record<string, any>;
      const access = resolveArtifactAccess(ctx.cwd, params.runId, params.repositoryId, params.token, ctx.sessionManager?.getSessionId?.());
      const action = params.action ?? "artifact";
      if (action === "inbox") {
        const inbox = await readInbox(access, { after: params.after, blockerAfter: params.blockerAfter, limit: params.limit });
        return { content: [{ type: "text", text: JSON.stringify(inbox) }], details: { nextCursor: inbox.nextCursor, nextBlockerCursor: inbox.nextBlockerCursor, unresolvedBlockerIds: inbox.unresolvedBlockerIds } };
      }
      if (action === "recover-evidence") {
        if (!params.artifactId) throw new Error("crew_read recover-evidence requires artifactId");
        await discardCorruptArtifact(access, params.artifactId);
        return { content: [{ type: "text", text: JSON.stringify({ artifactId: params.artifactId, recovery: "discard-corrupt" }) }] };
      }
      if (action === "acknowledge") {
        if (!Array.isArray(params.artifactIds) || !params.artifactIds.length) throw new Error("crew_read acknowledge requires artifactIds");
        await acknowledgeInbox(access, params.artifactIds);
        return { content: [{ type: "text", text: JSON.stringify({ acknowledged: [...new Set(params.artifactIds)] }) }] };
      }
      if (!params.artifactId) throw new Error("crew_read artifact requires artifactId");
      const page = await readArtifact(access, params.artifactId, { offset: params.offset, limit: params.limit, section: params.section, query: params.query });
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: { artifactId: page.artifactId, sha256: page.sha256, complete: page.complete, nextOffset: page.nextOffset } };
    },
  });

  pi.registerTool({
    name: "crew_control",
    label: "Crew Control",
    description: "Manage compact phase plans/checkpoints, deferred review batches, exact source snapshots, and ownership-scoped artifact cleanup.",
    promptSnippet: "Manage compact crew phase state, review batches, source snapshots, and safe cleanup.",
    parameters: {
      type: "object", required: ["action", "runId", "repositoryId"],
      properties: {
        action: { type: "string", enum: ["plan-write", "plan-read", "contract-publish", "phase-read", "checkpoint-create", "checkpoint-read", "snapshot", "task-promote", "task-defer", "review-batch-create", "task-disposition", "cleanup-preview", "cleanup-finalize"] },
        runId: { type: "string" }, repositoryId: { type: "string" }, token: { type: "string" },
        plan: { type: "object" }, phaseId: { type: "string" }, contractVersion: { type: "string" }, content: { type: "string" }, checkpoint: { type: "object" }, batch: { type: "object" },
        taskId: { type: "string" }, attempt: { type: "number" }, disposition: { type: "string", enum: ["finalized", "abandoned"] }, reason: { type: "string" }, sourcePaths: { type: "array", items: { type: "string" } }, artifactIds: { type: "array", items: { type: "string" } }, previewId: { type: "string" },
      }, additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      if (!ctx?.cwd) throw new Error("crew_control requires an active session cwd");
      const params = rawParams as Record<string, any>;
      const access = resolveArtifactAccess(ctx.cwd, params.runId, params.repositoryId, params.token, ctx.sessionManager?.getSessionId?.());
      let result: unknown;
      if (params.action === "plan-write") result = await writePlanIndex(access, params.plan as Omit<PlanIndex, "schemaVersion" | "updatedAt">);
      else if (params.action === "plan-read") result = await readPlanIndex(access);
      else if (params.action === "contract-publish") result = await publishPhaseContract(access, params.phaseId, params.contractVersion, params.content);
      else if (params.action === "phase-read") result = await readCurrentPhase(access);
      else if (params.action === "checkpoint-create") result = await createPhaseCheckpoint(access, params.checkpoint);
      else if (params.action === "checkpoint-read") result = await readPhaseCheckpoint(access, params.phaseId);
      else if (params.action === "snapshot") {
        const task = params.taskId ? await readTaskAttempt(access, params.taskId, params.attempt ?? 1) : undefined;
        result = captureSourceSnapshot(ctx.cwd, params.sourcePaths ?? task?.sourcePaths ?? []);
      } else if (params.action === "task-promote") {
        if (!params.taskId) throw new Error("task-promote requires taskId");
        result = await promoteTaskAttempt(access, params.taskId, params.attempt ?? 1);
      } else if (params.action === "task-defer") {
        if (!params.taskId) throw new Error("task-defer requires taskId");
        result = await deferTaskAttempt(access, params.taskId, params.attempt ?? 1);
      } else if (params.action === "review-batch-create") {
        if (!params.batch) throw new Error("review-batch-create requires batch");
        result = await createReviewBatch(access, params.batch);
      } else if (params.action === "task-disposition") {
        if (!params.taskId || !params.disposition || !params.reason) throw new Error("task-disposition requires taskId, disposition, and reason");
        result = await disposeTaskEvidence(access, params.taskId, params.attempt ?? 1, params.disposition, params.reason);
      } else if (params.action === "cleanup-preview") result = await previewArtifactCleanup(access, params.artifactIds ?? []);
      else if (params.action === "cleanup-finalize") result = await finalizeArtifactCleanup(access, params.previewId);
      else throw new Error("Unknown crew_control action");
      const serialized = JSON.stringify(result);
      return { content: [{ type: "text", text: serialized }], details: { action: params.action, bytes: Buffer.byteLength(serialized) } };
    },
  });

  pi.registerCommand?.("crew-status", {
    description: "Show and refresh child Herdr session and lifecycle status.",
    handler: async (_args, ctx) => {
      const records = await childStatusSnapshot({ refresh: true }, ctx);
      const summary = records.length ? records.map(record => `${record.launchId}: ${record.role} ${record.controllerStatus} (Herdr ${record.herdrStatus}${record.taskStatus ? `, task ${record.taskStatus}` : ""})`).join("\n") : "No crew child launches are recorded in this session.";
      ctx.ui?.notify?.(summary, records.some(record => ["blocked", "timed_out", "lost", "replaced", "failed"].includes(record.controllerStatus)) ? "warning" : "info");
    },
  });

  pi.on?.("session_start", (_event, ctx) => {
    childLaunches.clear();
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.customType !== "crew-child-lifecycle" || !entry.data || typeof entry.data !== "object") continue;
      try {
        const data = entry.data as ChildLaunchRecord;
        const restored = reconcileChildLaunch(childLaunches.get(data.launchId), data as unknown as Record<string, unknown>, data.observedAt);
        childLaunches.set(restored.record.launchId, { ...restored.record, ...data });
      } catch {
        // Ignore malformed historical extension entries and keep restoring later valid records.
      }
    }
    updateCrewStatusUi(ctx);
  });
  pi.on?.("session_shutdown", (_event, ctx) => ctx.ui?.setStatus?.("crew", undefined));

  // Safe interactive brain handoff. It is deliberately a user command: tools
  // cannot silently replace the active conversation.
  pi.registerCommand?.("crew-handoff", {
    description: "Start a fresh brain session from an approved compact checkpoint (JSON args: runId, repositoryId, phaseId).",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const parsed = JSON.parse(args || "{}") as { runId?: string; repositoryId?: string; phaseId?: string };
      if (!parsed.runId || !parsed.repositoryId || !parsed.phaseId) throw new Error("/crew-handoff requires JSON runId, repositoryId, and phaseId");
      const oldSessionId = ctx.sessionManager.getSessionId();
      const access = resolveArtifactAccess(ctx.cwd, parsed.runId, parsed.repositoryId, undefined, oldSessionId);
      const checkpoint = await readPhaseCheckpoint(access, parsed.phaseId);
      if (checkpoint.approvalState !== "approved") throw new Error("Fresh-session handoff requires an approved checkpoint");
      const handoff = `Crew checkpoint restoration (authoritative compact state):\n${JSON.stringify(checkpoint, null, 2)}\nRead only the current phase contract and referenced evidence needed for the next decision; do not reconstruct prior transcripts.`;
      const parentSession = ctx.sessionManager.getSessionFile();
      await ctx.newSession({ parentSession, setup: async (sm: any) => sm.appendMessage({ role: "user", content: [{ type: "text", text: handoff }], timestamp: Date.now() }), withSession: async (newCtx: any) => { rememberOwnerAccess(newCtx.sessionManager.getSessionId(), access); } });
    },
  });

  let warningLevel: "none" | "warn" | "checkpoint" = "none";
  pi.on?.("session_start", (_event, ctx) => {
    const saved = [...(ctx.sessionManager?.getBranch?.() ?? [])].reverse().find((entry: SessionEntryLike) => entry.customType === "crew-context-warning-state")?.data as { level?: unknown } | undefined;
    warningLevel = saved?.level === "warn" || saved?.level === "checkpoint" ? saved.level : "none";
  });
  pi.on?.("message_end", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const normalized = normalizeUsage(event.message.usage);
    pi.appendEntry?.("crew-usage", { ...normalized, recordedAt: new Date().toISOString(), semantics: "current request, not cumulative session usage" });
    const observed = ctx.getContextUsage?.()?.tokens; const tokens = observed ?? normalized.currentContextTokens;
    const next = contextWarningLevel(tokens, warningLevel);
    if (next !== "none" && next !== warningLevel) {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
      const managed = managedCoordinates(ctx.sessionManager?.getBranch?.());
      const runId = managed?.runId ?? "parent-local"; const taskId = managed?.taskId ?? "parent-session";
      const action = next === "checkpoint" ? "Checkpoint before another long delegation; at a safe idle boundary use /crew-handoff or supported compaction." : "Keep handoffs selective and prepare a compact checkpoint.";
      const text = `Crew context ${next}: session=${sessionId} run=${runId} task=${taskId}; ${observed === undefined ? "estimated" : "observed"} current context=${tokens} tokens, threshold=${next === "checkpoint" ? 125000 : 75000}. ${action}`;
      ctx.ui?.notify?.(text, "warning");
      pi.appendEntry?.("crew-context-warning", { level: next, tokens, sessionId, runId, taskId, measured: observed !== undefined, text, recordedAt: new Date().toISOString() });
      // Model-visible but non-autonomous: nextTurn waits for the next real user
      // prompt and cannot interrupt tools or create a reminder-response loop.
      pi.sendMessage?.({ customType: "crew-context-warning", content: text, display: false, details: { level: next, tokens, sessionId, runId, taskId } }, { deliverAs: "nextTurn", triggerTurn: false });
      if (managed) {
        try {
          const access = resolveArtifactAccess(ctx.cwd, managed.runId, managed.repositoryId, managed.token);
          const publicationId = await beginPublication(access, { kind: "message", taskId: managed.taskId, attempt: managed.attempt, recipient: "brain", category: "notification", blocking: false });
          await appendPublicationChunk(access, publicationId, 0, text); await finalizePublication(access, publicationId, 1);
        } catch (error) {
          pi.appendEntry?.("crew-context-warning-propagation", { status: "failed", sessionId, runId, taskId, error: error instanceof Error ? error.message : String(error), recordedAt: new Date().toISOString() });
        }
      }
    }
    if (next !== warningLevel) pi.appendEntry?.("crew-context-warning-state", { level: next, sessionId: ctx.sessionManager?.getSessionId?.() ?? "unknown-session", recordedAt: new Date().toISOString() });
    warningLevel = next;
  });

  pi.registerTool({
    name: "crew_rules",
    label: "Crew Rules",
    description: "Load resolved crew role configuration: descriptions, authority, models, and config source.",
    promptSnippet: "Inspect configured crew roles and models.",
    parameters: {
      type: "object",
      properties: {
        configCwd: { type: "string", description: "Directory for project .pi/model-tiers.json lookup. Defaults to current process cwd." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      return executeCrewRules(pi, (rawParams ?? {}) as CrewRulesParams);
    },
  });
}
