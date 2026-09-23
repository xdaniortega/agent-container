import { basename } from "node:path";

export type HerdrAgentSessionRef = {
  source: string;
  agent: string;
  kind: string;
  value: string;
};

export type HerdrAgentLike = {
  name?: string;
  agent?: string;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  foreground_cwd?: string;
  cwd?: string;
  agent_status?: string;
  status?: string;
  model?: string;
  model_id?: string;
  thinking_level?: string;
  reasoning_level?: string;
  revision?: number;
  state_change_seq?: number;
  agent_session?: HerdrAgentSessionRef;
  session_id?: string;
};

export type ChildControllerStatus =
  | "queued"
  | "starting"
  | "prompting"
  | "running"
  | "blocked"
  | "settled"
  | "timed_out"
  | "lost"
  | "replaced"
  | "failed";

export type ChildLaunchRecord = {
  launchId: string;
  role: string;
  agentName?: string;
  paneId?: string;
  workspaceId?: string;
  tabId?: string;
  runId?: string;
  repositoryId?: string;
  taskId?: string;
  attempt?: number;
  controllerStatus: ChildControllerStatus;
  herdrStatus: string;
  taskStatus?: string;
  complete: boolean;
  agentContinues: boolean;
  markerMode?: string;
  sessionRef?: HerdrAgentSessionRef;
  piSessionId?: string;
  stateChangeSeq?: number;
  revision?: number;
  startedAt: string;
  observedAt: string;
  lastProgressAt: string;
  recoveryHint: string;
};

function normalizedStatus(value: unknown): string {
  return String(value ?? "unknown").toLowerCase().replace(/[- ]/g, "_");
}

function normalizeSessionRef(value: unknown): HerdrAgentSessionRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (![input.source, input.agent, input.kind, input.value].every(item => typeof item === "string" && item.length > 0)) return undefined;
  return { source: input.source as string, agent: input.agent as string, kind: input.kind as string, value: input.value as string };
}

function sessionKey(value: HerdrAgentSessionRef | undefined): string {
  return value ? `${value.source}\0${value.agent}\0${value.kind}\0${value.value}` : "";
}

function piSessionId(value: HerdrAgentSessionRef | undefined, explicit?: unknown): string | undefined {
  if (typeof explicit === "string" && explicit) return explicit;
  if (!value || value.kind !== "path") return undefined;
  const match = basename(value.value).match(/_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match?.[1];
}

function controllerStatus(details: Record<string, unknown>, previous?: ChildLaunchRecord): ChildControllerStatus {
  if (details.agentExited === true) return "lost";
  const status = normalizedStatus(details.status);
  if (status === "spawned" || status === "startup") return "starting";
  if (status === "starting") return "prompting";
  if (status === "working" || status === "busy" || status === "running") return "running";
  if (status === "blocked" || status === "startup_blocked") return "blocked";
  if (status === "timed_out" || status === "startup_timeout") return "timed_out";
  if (status === "failed" || status === "error" || status === "teardown_failed") return "failed";
  if (status === "idle" || status === "done" || status === "completed" || status === "complete" || status === "summary" || status === "removed") return "settled";
  if (status === "retained") return previous?.controllerStatus ?? "settled";
  return previous?.controllerStatus ?? "queued";
}

function recoveryHintFor(status: ChildControllerStatus, complete: boolean, continues: boolean): string {
  if (complete) return "No recovery required; completion evidence is confirmed.";
  if (status === "blocked") return "Inspect the child pane and ask the user before answering an approval or question.";
  if (status === "timed_out" && continues) return "The child is still live; use crew_status or a bounded wait before considering recovery.";
  if (status === "settled") return "The child settled without complete evidence; inspect its output and retry with a fresh launch if needed.";
  if (status === "lost" || status === "replaced") return "Do not attribute new pane output to this launch; reconcile the child identity before recovery.";
  if (status === "failed") return "Inspect diagnostics and use explicit managed recovery only after proving the writer is inactive.";
  return "The child is active; wait or query crew_status.";
}

/**
 * @notice Normalizes the Herdr fields that identify one live child agent observation.
 * @param agent Raw agent data returned by Herdr.
 * @returns Stable status, topology, session, model, and sequence fields.
 */
export function herdrObservation(agent: HerdrAgentLike | undefined): Record<string, unknown> {
  const sessionRef = normalizeSessionRef(agent?.agent_session);
  return {
    agentName: agent?.name,
    paneId: agent?.pane_id,
    workspaceId: agent?.workspace_id,
    tabId: agent?.tab_id,
    status: normalizedStatus(agent?.agent_status ?? agent?.status),
    sessionRef,
    piSessionId: piSessionId(sessionRef, agent?.session_id),
    stateChangeSeq: agent?.state_change_seq,
    revision: agent?.revision,
  };
}

/**
 * @notice Reconciles one partial crew lifecycle update into a monotonic child-launch record.
 * @param previous Previously accepted state for the same launch, if any.
 * @param details Current tool, Herdr, or managed-task observation.
 * @returns The current record and whether a durable lifecycle transition occurred.
 */
export function reconcileChildLaunch(previous: ChildLaunchRecord | undefined, details: Record<string, unknown>, now = new Date().toISOString()): { record: ChildLaunchRecord; changed: boolean } {
  const launchId = typeof details.launchId === "string" ? details.launchId : previous?.launchId;
  const role = typeof details.role === "string" ? details.role : previous?.role;
  if (!launchId || !role) throw new Error("Child lifecycle updates require launchId and role");
  const incomingSeq = typeof details.stateChangeSeq === "number" ? details.stateChangeSeq : undefined;
  if (previous?.stateChangeSeq !== undefined && incomingSeq !== undefined && incomingSeq < previous.stateChangeSeq) return { record: previous, changed: false };

  const incomingSession = normalizeSessionRef(details.sessionRef ?? details.agentSession);
  const incomingPane = typeof details.paneId === "string" ? details.paneId : undefined;
  let nextController = controllerStatus(details, previous);
  if (previous?.paneId && incomingPane && previous.paneId !== incomingPane) nextController = "replaced";
  if (previous?.sessionRef && incomingSession && sessionKey(previous.sessionRef) !== sessionKey(incomingSession)) nextController = "replaced";

  const complete = typeof details.complete === "boolean" ? details.complete : previous?.complete ?? false;
  const agentContinues = typeof details.agentContinues === "boolean"
    ? details.agentContinues
    : ["queued", "starting", "prompting", "running", "blocked", "timed_out"].includes(nextController);
  const herdrStatus = normalizedStatus(details.herdrStatus ?? details.status ?? previous?.herdrStatus);
  const sessionRef = incomingSession ?? previous?.sessionRef;
  const record: ChildLaunchRecord = {
    launchId,
    role,
    agentName: typeof details.agentName === "string" ? details.agentName : previous?.agentName,
    paneId: incomingPane ?? previous?.paneId,
    workspaceId: typeof details.workspaceId === "string" ? details.workspaceId : previous?.workspaceId,
    tabId: typeof details.tabId === "string" ? details.tabId : previous?.tabId,
    runId: typeof details.runId === "string" ? details.runId : previous?.runId,
    repositoryId: typeof details.repositoryId === "string" ? details.repositoryId : previous?.repositoryId,
    taskId: typeof details.taskId === "string" ? details.taskId : previous?.taskId,
    attempt: typeof details.attempt === "number" ? details.attempt : previous?.attempt,
    controllerStatus: nextController,
    herdrStatus,
    taskStatus: typeof details.lifecycleStatus === "string" ? details.lifecycleStatus : previous?.taskStatus,
    complete,
    agentContinues,
    markerMode: typeof details.extractionMode === "string" ? details.extractionMode : typeof details.markerMode === "string" ? details.markerMode : previous?.markerMode,
    sessionRef,
    piSessionId: piSessionId(sessionRef, details.piSessionId) ?? previous?.piSessionId,
    stateChangeSeq: incomingSeq ?? previous?.stateChangeSeq,
    revision: typeof details.revision === "number" ? details.revision : previous?.revision,
    startedAt: previous?.startedAt ?? now,
    observedAt: now,
    lastProgressAt: details.progress === true || !previous || nextController !== previous.controllerStatus ? now : previous.lastProgressAt,
    recoveryHint: "",
  };
  record.recoveryHint = recoveryHintFor(record.controllerStatus, record.complete, record.agentContinues);
  const comparable = (item: ChildLaunchRecord | undefined) => item ? JSON.stringify({ ...item, observedAt: undefined, lastProgressAt: undefined, recoveryHint: undefined }) : "";
  return { record, changed: comparable(previous) !== comparable(record) };
}

/**
 * @notice Identifies child launches that still have live work rather than terminal or incomplete settlement.
 * @param record Normalized child-launch state.
 * @returns Whether status refresh/wait behavior should treat the child as active.
 */
export function isActiveChild(record: ChildLaunchRecord): boolean {
  return record.agentContinues && !record.complete && !["lost", "replaced", "failed", "settled"].includes(record.controllerStatus);
}
