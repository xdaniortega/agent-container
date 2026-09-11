import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const CREW_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_ARTIFACT_PAGE_SIZE = 16_000;
export const MAX_ARTIFACT_PAGE_SIZE = 50_000;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_PUBLICATION_CHUNKS = 1_000;
export const MAX_SERIALIZED_PAGE_BYTES = 48_000;
const MAX_METADATA_BYTES = 8_000;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;

type Capability = {
  tokenHash: string;
  role: string;
  taskId?: string;
  attempt?: number;
  owner: boolean;
  revokedAt?: string;
  createdAt: string;
};

type RunManifest = {
  schemaVersion: 1;
  runId: string;
  repositoryId: string;
  gitCommonDir: string;
  createdAt: string;
  ownerSessionId?: string;
  capabilities: Capability[];
};

export type RunAccess = {
  stateRoot: string;
  repositoryId: string;
  runId: string;
  runDir: string;
  token: string;
};

export type PublicationMetadata = {
  kind: "report" | "review" | "message" | "checkpoint";
  phaseId?: string;
  taskId?: string;
  attempt?: number;
  recipient?: string;
  category?: "question" | "answer" | "finding" | "dependency-change" | "notification";
  replyTo?: string;
  blocking?: boolean;
  contractVersion?: string;
  baseSha?: string;
  headSha?: string;
  sourceSnapshotId?: string;
  requiredSections?: string[];
  verdict?: "PASS" | "REVISION_NEEDED" | "BLOCKED";
};

export type TaskAttemptState = {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  contractVersion: string;
  baseSha: string;
  headSha?: string;
  status: "ready" | "starting" | "running" | "submitted" | "reviewing" | "approved" | "revision-needed" | "blocked" | "failed";
  reportArtifactId?: string;
  reviewArtifactId?: string;
  writerAgentName?: string;
  writerPaneId?: string;
  failureReason?: string;
  sourcePaths?: string[];
  sourceSnapshotId?: string;
  executorSessionGeneration?: string;
  reviewerSessionGeneration?: string;
  evidenceDisposition?: { action: "finalized" | "abandoned"; reason: string; disposedAt: string };
  updatedAt: string;
};

export type PlanPhase = { id: string; summary: string; status: "pending" | "current" | "completed" | "blocked"; contractVersion: string };
export type PlanIndex = { schemaVersion: 1; revision: number; currentPhaseId: string | null; phases: PlanPhase[]; updatedAt: string };
export type PhaseCheckpoint = { schemaVersion: 1; phaseId: string; contractVersion: string; sourceSnapshotId: string; summary: string; decisions: string[]; remainingPhaseIds: string[]; unresolvedBlockerIds: string[]; approvalState: "approved" | "provisional"; evidenceArtifactIds: string[]; createdAt: string };

export type InboxEntry = {
  artifactId: string;
  sender: string;
  category: NonNullable<PublicationMetadata["category"]>;
  taskId?: string;
  attempt?: number;
  replyTo?: string;
  blocking: boolean;
  acknowledged: boolean;
  resolved: boolean;
  preview: string;
  finalizedAt: string;
};

type PublicationDraft = PublicationMetadata & {
  schemaVersion: 1;
  publicationId: string;
  runId: string;
  repositoryId: string;
  authorRole: string;
  capabilityHash: string;
  createdAt: string;
};

type StoredArtifact = Omit<PublicationDraft, "capabilityHash"> & {
  artifactId: string;
  sequence: number;
  finalizedAt: string;
  content: string;
  contentBytes: number;
  contentSha256: string;
  chunkCount: number;
};

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${label} must match ${ID_PATTERN}`);
}

function assertOptionalSha(value: string | undefined, label: string): void {
  if (value !== undefined && !SHA_PATTERN.test(value)) throw new Error(`${label} must be a 40-64 character hexadecimal SHA`);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonical(path: string): string {
  return realpathSync(resolve(path));
}

/**
 * @notice Resolves the filesystem root used for durable crew coordination state.
 * @returns The configured or default absolute state-root path.
 */
export function defaultCrewStateRoot(): string {
  return process.env.CREW_STATE_ROOT ? resolve(process.env.CREW_STATE_ROOT) : join(homedir(), ".pi", "crew-state");
}

/**
 * @notice Derives a stable repository identity from Git's canonical common directory.
 * @param cwd A path inside the target Git worktree.
 * @returns The repository identifier and canonical Git common-directory path.
 */
export function resolveRepositoryIdentity(cwd: string): { repositoryId: string; gitCommonDir: string } {
  const commonRaw = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commonPath = isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw);
  const gitCommonDir = canonical(commonPath);
  return {
    repositoryId: createHash("sha256").update(gitCommonDir).digest("hex").slice(0, 32),
    gitCommonDir,
  };
}

function assertSafeTree(root: string, target: string): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Crew state path escapes its state root");
  let cursor = rootPath;
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Crew state root may not be a symlink: ${cursor}`);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Crew state path may not contain symlinks: ${cursor}`);
  }
}

async function mkdirSafe(root: string, target: string): Promise<void> {
  assertSafeTree(root, target);
  await mkdir(target, { recursive: true, mode: 0o700 });
  assertSafeTree(root, target);
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishExclusive(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeExclusive(temp, content);
  try {
    await link(temp, path); // Hard-link creation is atomic and refuses an existing immutable destination.
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function withStateLock<T>(access: RunAccess, name: string, work: () => Promise<T>): Promise<T> {
  assertId(name, "lock name");
  const lockPath = join(access.runDir, "locks", `${name}.lock`);
  await mkdirSafe(access.stateRoot, dirname(lockPath));
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Crew state lock ${name} is busy; retry after reconciling the active owner`);
      await delay(25);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readManifest(runDir: string): Promise<RunManifest> {
  const parsed = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as RunManifest;
  if (parsed.schemaVersion !== CREW_STATE_SCHEMA_VERSION) throw new Error(`Unsupported crew state schema: ${parsed.schemaVersion}`);
  return parsed;
}

async function authenticate(runDir: string, token: string): Promise<{ manifest: RunManifest; capability: Capability }> {
  if (typeof token !== "string" || token.length < 32) throw new Error("Invalid crew capability token");
  const manifest = await readManifest(runDir);
  const hash = tokenHash(token);
  const capability = manifest.capabilities.find((candidate) => !candidate.revokedAt && hashesEqual(candidate.tokenHash, hash));
  if (!capability) throw new Error("Crew capability token is not authorized for this run");
  return { manifest, capability };
}

/**
 * @notice Creates an isolated durable run and its owner capability.
 * @param options Repository, state-root, and optional run ownership settings.
 * @returns Access coordinates and the owner capability token.
 */
export async function createRunState(options: { cwd: string; stateRoot?: string; runId?: string; ownerSessionId?: string }): Promise<RunAccess> {
  const identity = resolveRepositoryIdentity(options.cwd);
  const stateRoot = resolve(options.stateRoot ?? defaultCrewStateRoot());
  const runId = options.runId ?? `run-${Date.now()}-${randomBytes(5).toString("hex")}`;
  assertId(runId, "runId");
  const repositoryDir = join(stateRoot, identity.repositoryId);
  const runDir = join(repositoryDir, runId);
  await mkdirSafe(stateRoot, repositoryDir);
  assertSafeTree(stateRoot, runDir);
  await mkdir(runDir, { mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const manifest: RunManifest = {
    schemaVersion: CREW_STATE_SCHEMA_VERSION,
    runId,
    repositoryId: identity.repositoryId,
    gitCommonDir: identity.gitCommonDir,
    createdAt: new Date().toISOString(),
    ownerSessionId: options.ownerSessionId,
    capabilities: [{ tokenHash: tokenHash(token), role: "brain", owner: true, createdAt: new Date().toISOString() }],
  };
  try {
    await publishExclusive(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { stateRoot, repositoryId: identity.repositoryId, runId, runDir, token };
}

/**
 * @notice Issues or resumes a role-scoped capability for one task attempt.
 * @param access Owner-authorized run access.
 * @param options Role and task-attempt scope for the capability.
 * @returns The task capability token.
 */
export async function createTaskCapability(access: RunAccess, options: { role: string; taskId: string; attempt: number }): Promise<string> {
  assertId(options.role, "role");
  assertId(options.taskId, "taskId");
  if (!Number.isInteger(options.attempt) || options.attempt < 1) throw new Error("attempt must be a positive integer");
  return withStateLock(access, "manifest", async () => {
    const { manifest, capability } = await authenticate(access.runDir, access.token);
    if (!capability.owner) throw new Error("Only the run owner may issue task capabilities");
    const existing = manifest.capabilities.find(item => !item.revokedAt && item.role === options.role && item.taskId === options.taskId && item.attempt === options.attempt);
    if (existing) {
      const secretPath = join(access.runDir, "secrets", "capabilities", `${existing.tokenHash}.txt`);
      assertSafeTree(access.stateRoot, secretPath);
      if (!existsSync(secretPath)) throw new Error("Existing task capability cannot be resumed because its extension-side secret is missing");
      return (await readFile(secretPath, "utf8")).trim();
    }
    const token = randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const secretPath = join(access.runDir, "secrets", "capabilities", `${hash}.txt`);
    await mkdirSafe(access.stateRoot, dirname(secretPath));
    await publishExclusive(secretPath, `${token}\n`);
    manifest.capabilities.push({ tokenHash: hash, role: options.role, taskId: options.taskId, attempt: options.attempt, owner: false, createdAt: new Date().toISOString() });
    await writeReplacement(join(access.runDir, "manifest.json"), manifest);
    return token;
  });
}

function taskAttemptPath(access: RunAccess, taskId: string, attempt: number): string {
  assertId(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return join(access.runDir, "tasks", taskId, `attempt-${attempt}.json`);
}

async function writeReplacement(path: string, value: unknown): Promise<void> {
  const nextPath = `${path}.${randomUUID()}.next`;
  await writeExclusive(nextPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(nextPath, path);
}

/**
 * @notice Records an immutable launch contract for a managed task attempt.
 * @param options Contract, base revision, and optional source-snapshot scope.
 * @returns The initial task-attempt state.
 */
export async function createTaskAttempt(access: RunAccess, options: { taskId: string; attempt: number; contractVersion: string; baseSha: string; sourcePaths?: string[]; executorSessionGeneration?: string }): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may create task attempts");
  assertId(options.contractVersion, "contractVersion");
  assertOptionalSha(options.baseSha, "baseSha");
  return withStateLock(access, `task-${createHash("sha256").update(`${options.taskId}/${options.attempt}`).digest("hex").slice(0, 32)}`, async () => {
    const path = taskAttemptPath(access, options.taskId, options.attempt);
    await mkdirSafe(access.stateRoot, dirname(path));
    if (existsSync(path)) {
      const existing = await readTaskAttempt(access, options.taskId, options.attempt);
      if (existing.status === "ready" && existing.contractVersion === options.contractVersion && existing.baseSha === options.baseSha) return existing;
      throw new Error(`Task attempt already exists in ${existing.status} state with a different or active launch contract`);
    }
    if (options.attempt > 1) {
      const previous = await readTaskAttempt(access, options.taskId, options.attempt - 1);
      if (!["revision-needed", "blocked", "failed"].includes(previous.status)) throw new Error("A new attempt requires the previous attempt to need revision, be blocked, or fail");
    }
    const state: TaskAttemptState = { schemaVersion: 1, ...options, status: "ready", updatedAt: new Date().toISOString() };
    await publishExclusive(path, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  });
}

/**
 * @notice Loads an authorized managed task-attempt state.
 * @returns The integrity-checked task-attempt state.
 */
export async function readTaskAttempt(access: RunAccess, taskId: string, attempt: number): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner && (capability.taskId !== taskId || capability.attempt !== attempt)) throw new Error("Task capability may read only its assigned task attempt");
  const path = taskAttemptPath(access, taskId, attempt);
  assertSafeTree(access.stateRoot, path);
  const state = JSON.parse(await readFile(path, "utf8")) as TaskAttemptState;
  if (state.schemaVersion !== CREW_STATE_SCHEMA_VERSION || state.taskId !== taskId || state.attempt !== attempt) throw new Error("Invalid task-attempt state");
  return state;
}

/**
 * @notice Applies an owner-authorized compare-and-set lifecycle transition.
 * @param expected Status that must still be current.
 * @param update Lifecycle fields to merge into the attempt.
 * @returns The updated task-attempt state.
 */
export async function transitionTaskAttempt(access: RunAccess, taskId: string, attempt: number, expected: TaskAttemptState["status"], update: Partial<Pick<TaskAttemptState, "status" | "headSha" | "reportArtifactId" | "reviewArtifactId" | "writerAgentName" | "writerPaneId" | "failureReason" | "sourceSnapshotId" | "reviewerSessionGeneration">>): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may transition task attempts");
  return withStateLock(access, `task-${createHash("sha256").update(`${taskId}/${attempt}`).digest("hex").slice(0, 32)}`, async () => {
    const current = await readTaskAttempt(access, taskId, attempt);
    if (current.status !== expected) throw new Error(`Task ${taskId} attempt ${attempt} is ${current.status}, expected ${expected}`);
    if (update.headSha) assertOptionalSha(update.headSha, "headSha");
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    await writeReplacement(taskAttemptPath(access, taskId, attempt), next);
    return next;
  });
}

function writerOwnershipPath(access: RunAccess): string {
  return join(dirname(access.runDir), "active-writer.json");
}

/**
 * @notice Exclusively reserves the repository writer slot for a task attempt.
 * @param agentName Herdr agent that owns the writer slot.
 * @param paneId Herdr pane hosting the writer.
 * @returns The attempt transitioned to its starting state.
 */
export async function acquireWriterOwnership(access: RunAccess, taskId: string, attempt: number, agentName: string, paneId: string): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may acquire writer ownership");
  const ownership = { schemaVersion: 1, repositoryId: access.repositoryId, runId: access.runId, taskId, attempt, agentName, paneId, acquiredAt: new Date().toISOString() };
  const path = writerOwnershipPath(access);
  await mkdirSafe(access.stateRoot, dirname(path));
  try {
    await publishExclusive(path, `${JSON.stringify(ownership, null, 2)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const current = JSON.parse(await readFile(path, "utf8")) as typeof ownership;
      throw new Error(`Repository writer is already owned by ${current.runId}/${current.taskId}/attempt-${current.attempt} in pane ${current.paneId}; reconcile its liveness before retrying`);
    }
    throw error;
  }
  try {
    return await transitionTaskAttempt(access, taskId, attempt, "ready", { status: "starting", writerAgentName: agentName, writerPaneId: paneId });
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

/**
 * @notice Marks a writer-owned attempt as actively running.
 * @returns The updated task-attempt state.
 */
export async function markWriterRunning(access: RunAccess, taskId: string, attempt: number): Promise<TaskAttemptState> {
  return transitionTaskAttempt(access, taskId, attempt, "starting", { status: "running" });
}

async function releaseWriterOwnership(access: RunAccess, taskId: string, attempt: number): Promise<void> {
  const path = writerOwnershipPath(access);
  if (!existsSync(path)) return;
  const ownership = JSON.parse(await readFile(path, "utf8")) as { runId: string; taskId: string; attempt: number };
  if (ownership.runId !== access.runId || ownership.taskId !== taskId || ownership.attempt !== attempt) {
    throw new Error("Writer ownership changed unexpectedly; refusing to release another task's ownership");
  }
  await unlink(path);
}

/**
 * @notice Fails an orphaned attempt only after external writer-liveness confirmation.
 * @param confirmedWriterInactive Whether the caller proved the writer is inactive.
 * @param reason Audit reason recorded for recovery.
 * @returns The recovered terminal task-attempt state.
 */
export async function recoverTaskAttempt(access: RunAccess, taskId: string, attempt: number, confirmedWriterInactive: boolean, reason: string): Promise<TaskAttemptState> {
  if (!confirmedWriterInactive) throw new Error("Recovery refused: writer liveness has not been proven inactive");
  const current = await readTaskAttempt(access, taskId, attempt);
  if (!["starting", "running", "ready"].includes(current.status)) throw new Error(`Task recovery requires ready, starting, or running state, found ${current.status}`);
  const next = await transitionTaskAttempt(access, taskId, attempt, current.status, { status: "failed", failureReason: reason });
  if (current.status !== "ready") await releaseWriterOwnership(access, taskId, attempt);
  return next;
}

/**
 * @notice Records explicit run-level disposition of terminal task evidence.
 * @param action Finalize approved evidence or abandon unsuccessful evidence.
 * @param reason Audit reason for the disposition.
 * @returns The task state containing the evidence disposition.
 */
export async function disposeTaskEvidence(access: RunAccess, taskId: string, attempt: number, action: "finalized" | "abandoned", reason: string): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may dispose task evidence");
  if (!reason?.trim() || Buffer.byteLength(reason.trim(), "utf8") > 1_000) throw new Error("Evidence disposition requires a non-blank reason of at most 1000 bytes");
  return withStateLock(access, `task-${createHash("sha256").update(`${taskId}/${attempt}`).digest("hex").slice(0, 32)}`, async () => {
    const current = await readTaskAttempt(access, taskId, attempt);
    if (!["approved", "revision-needed", "blocked", "failed"].includes(current.status)) throw new Error(`Evidence disposition requires approved, revision-needed, blocked, or failed status, found ${current.status}`);
    if (current.status === "approved" && action !== "finalized") throw new Error("Approved task evidence may only be disposed by explicit finalization");
    if (current.status !== "approved" && action !== "abandoned") throw new Error(`${current.status} task evidence requires explicit abandonment`);
    if (current.evidenceDisposition) {
      if (current.evidenceDisposition.action === action && current.evidenceDisposition.reason === reason.trim()) return current;
      throw new Error("Task evidence already has a different disposition");
    }
    const next = { ...current, evidenceDisposition: { action, reason: reason.trim(), disposedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
    await writeReplacement(taskAttemptPath(access, taskId, attempt), next);
    return next;
  });
}

function validateMetadata(metadata: PublicationMetadata, capability: Capability): void {
  if (metadata.taskId) assertId(metadata.taskId, "taskId");
  if (metadata.phaseId) assertId(metadata.phaseId, "phaseId");
  if (metadata.sourceSnapshotId && !/^[a-f0-9]{64}$/i.test(metadata.sourceSnapshotId)) throw new Error("sourceSnapshotId must be a SHA-256 fingerprint");
  if (metadata.recipient) assertId(metadata.recipient, "recipient");
  if (metadata.replyTo) assertId(metadata.replyTo, "replyTo");
  assertOptionalSha(metadata.baseSha, "baseSha");
  assertOptionalSha(metadata.headSha, "headSha");
  if (metadata.requiredSections !== undefined && (!Array.isArray(metadata.requiredSections) || metadata.requiredSections.some(section => typeof section !== "string"))) {
    throw new Error("requiredSections must be an array of strings");
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) throw new Error(`Publication metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  if (!capability.owner) {
    if (!capability.taskId || metadata.taskId !== capability.taskId) throw new Error("Task capability may publish only to its assigned task");
    if (metadata.attempt !== capability.attempt) throw new Error("Task capability may publish only to its assigned attempt");
  }
  if (metadata.kind === "message" && (!metadata.recipient || !metadata.category || !metadata.taskId || metadata.attempt === undefined)) throw new Error("Messages require recipient, category, taskId, and attempt");
  if (metadata.kind !== "message" && (metadata.recipient || metadata.category || metadata.replyTo || metadata.blocking)) throw new Error("Recipient/category/replyTo/blocking are valid only for messages");
  if (metadata.blocking && !["question", "finding", "dependency-change"].includes(metadata.category ?? "")) throw new Error("Only questions, findings, and dependency changes may block");
  if (metadata.kind === "review" && !metadata.verdict) throw new Error("Reviews require a structured verdict");
  if (metadata.kind !== "review" && metadata.verdict) throw new Error("verdict is valid only for reviews");
}

/**
 * @notice Opens an authorized immutable-artifact upload.
 * @param metadata Routing, lifecycle, and integrity metadata for the artifact.
 * @returns The publication identifier used for chunk upload and finalization.
 */
export async function beginPublication(access: RunAccess, metadata: PublicationMetadata): Promise<string> {
  const { manifest, capability } = await authenticate(access.runDir, access.token);
  validateMetadata(metadata, capability);
  if (metadata.kind === "message" && metadata.recipient !== "brain" && !manifest.capabilities.some(item => !item.revokedAt && item.role === metadata.recipient && item.taskId === metadata.taskId && item.attempt === metadata.attempt)) {
    throw new Error("Message recipient has no routable capability for this task attempt");
  }
  if (metadata.replyTo) {
    const repliedTo = await loadArtifact(access.runDir, access.stateRoot, metadata.replyTo);
    if (repliedTo.kind !== "message") throw new Error("replyTo must reference a message");
    if (!capability.owner && repliedTo.recipient !== capability.role && repliedTo.authorRole !== capability.role) throw new Error("A task role may reply only to a message it sent or received");
    if (repliedTo.taskId !== metadata.taskId || repliedTo.attempt !== metadata.attempt) throw new Error("A reply must remain in the same task attempt");
    if (metadata.category === "answer") {
      const authoritativeResolver = capability.owner || repliedTo.authorRole === capability.role;
      if (["finding", "dependency-change"].includes(repliedTo.category ?? "") && !authoritativeResolver) throw new Error("Only the finding owner or run owner may resolve this blocking message");
    }
  }
  const publicationId = `${metadata.kind}-${randomUUID()}`;
  const uploadDir = join(access.runDir, "uploads", publicationId);
  await mkdirSafe(access.stateRoot, join(uploadDir, "chunks"));
  const draft: PublicationDraft = {
    ...metadata,
    schemaVersion: CREW_STATE_SCHEMA_VERSION,
    publicationId,
    runId: manifest.runId,
    repositoryId: manifest.repositoryId,
    authorRole: capability.role,
    capabilityHash: capability.tokenHash,
    createdAt: new Date().toISOString(),
  };
  await publishExclusive(join(uploadDir, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  return publicationId;
}

async function authorizedDraft(access: RunAccess, publicationId: string): Promise<{ draft: PublicationDraft; uploadDir: string }> {
  assertId(publicationId, "publicationId");
  const { capability } = await authenticate(access.runDir, access.token);
  const uploadDir = join(access.runDir, "uploads", publicationId);
  assertSafeTree(access.stateRoot, uploadDir);
  const draft = JSON.parse(await readFile(join(uploadDir, "draft.json"), "utf8")) as PublicationDraft;
  if (!hashesEqual(draft.capabilityHash, capability.tokenHash)) throw new Error("Only the publication owner may append or finalize it");
  return { draft, uploadDir };
}

/**
 * @notice Appends one immutable, position-bound chunk to a publication.
 * @param index Zero-based contiguous chunk index.
 * @param content UTF-8 artifact content for this chunk.
 */
export async function appendPublicationChunk(access: RunAccess, publicationId: string, index: number, content: string): Promise<void> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PUBLICATION_CHUNKS) throw new Error(`chunk index must be between 0 and ${MAX_PUBLICATION_CHUNKS - 1}`);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_ARTIFACT_PAGE_SIZE) throw new Error(`chunk must be a string no larger than ${MAX_ARTIFACT_PAGE_SIZE} bytes`);
  const { uploadDir } = await authorizedDraft(access, publicationId);
  await publishExclusive(join(uploadDir, "chunks", `${index.toString().padStart(6, "0")}.txt`), content);
}

function artifactRelativePath(draft: PublicationDraft): string {
  // The flat immutable artifact store is the run's artifact index. Authorization
  // is evaluated from the stored metadata, never inferred from capability paths.
  return join("artifacts", `${draft.publicationId}.json`);
}

/**
 * @notice Atomically publishes a complete, integrity-addressed artifact.
 * @param chunkCount Exact number of contiguous chunks to assemble.
 * @returns The artifact identifier, SHA-256 digest, and byte length.
 */
export async function finalizePublication(access: RunAccess, publicationId: string, chunkCount: number): Promise<{ artifactId: string; sha256: string; bytes: number }> {
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_PUBLICATION_CHUNKS) throw new Error("chunkCount must be a positive bounded integer");
  const { draft, uploadDir } = await authorizedDraft(access, publicationId);
  const expectedChunkNames = Array.from({ length: chunkCount }, (_, index) => `${index.toString().padStart(6, "0")}.txt`);
  const actualChunkNames = (await readdir(join(uploadDir, "chunks"))).sort();
  if (actualChunkNames.length !== expectedChunkNames.length || actualChunkNames.some((name, index) => name !== expectedChunkNames[index])) {
    throw new Error(`Publication chunks must be exactly the contiguous set 0..${chunkCount - 1}`);
  }
  const chunks: string[] = [];
  let bytes = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const path = join(uploadDir, "chunks", expectedChunkNames[index]);
    const chunk = await readFile(path, "utf8");
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    chunks.push(chunk);
  }
  const content = chunks.join("");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const { capabilityHash: _capabilityHash, ...publicDraft } = draft;
  await withStateLock(access, "artifact-sequence", async () => {
    const sequencePath = join(access.runDir, "artifact-sequence.json");
    const sequence = existsSync(sequencePath) ? (JSON.parse(await readFile(sequencePath, "utf8")) as { next: number }).next : 1;
    const artifact: StoredArtifact = {
      ...publicDraft,
      artifactId: draft.publicationId,
      sequence,
      finalizedAt: new Date().toISOString(),
      content,
      contentBytes: bytes,
      contentSha256: sha256,
      chunkCount,
    };
    const destination = join(access.runDir, artifactRelativePath(draft));
    await mkdirSafe(access.stateRoot, dirname(destination));
    // Advance first: a crash may leave a harmless gap, but can never reuse an
    // already-visible publication sequence and invalidate stable cursors.
    await writeReplacement(sequencePath, { schemaVersion: 1, next: sequence + 1 });
    await publishExclusive(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  });
  await rm(uploadDir, { recursive: true, force: true });
  return { artifactId: draft.publicationId, sha256, bytes };
}

async function findArtifactPath(runDir: string, artifactId: string): Promise<string> {
  assertId(artifactId, "artifactId");
  const indexed = join(runDir, "artifacts", `${artifactId}.json`);
  if (existsSync(indexed)) return indexed;
  throw new Error(`Unknown artifact: ${artifactId}`);
}

async function loadArtifact(runDir: string, stateRoot: string, artifactId: string): Promise<StoredArtifact> {
  const path = await findArtifactPath(runDir, artifactId);
  assertSafeTree(stateRoot, path);
  const artifact = JSON.parse(await readFile(path, "utf8")) as StoredArtifact;
  if (artifact.schemaVersion !== CREW_STATE_SCHEMA_VERSION || artifact.artifactId !== artifactId || typeof artifact.content !== "string" || !Number.isSafeInteger(artifact.sequence) || artifact.sequence < 1) throw new Error("Invalid artifact envelope");
  const actualHash = createHash("sha256").update(artifact.content).digest("hex");
  if (actualHash !== artifact.contentSha256 || Buffer.byteLength(artifact.content) !== artifact.contentBytes) throw new Error("Artifact content failed integrity validation");
  return artifact;
}

function selectedArtifactContent(content: string, options: { section?: string; query?: string }): { content: string; selection: { section?: string; query?: string } | null } {
  if (options.section && options.query) throw new Error("Select either a Markdown section or a search query, not both");
  if (options.section) {
    const escaped = options.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").exec(content);
    if (!match) throw new Error(`Artifact does not contain Markdown section: ${options.section}`);
    const start = match.index;
    const headingLevel = match[0].match(/^#+/)![0].length;
    const rest = content.slice(start + match[0].length);
    const next = new RegExp(`^#{1,${headingLevel}}\\s+`, "m").exec(rest);
    return { content: content.slice(start, next ? start + match[0].length + next.index : content.length), selection: { section: options.section } };
  }
  if (options.query) {
    if (options.query.length > 200) throw new Error("Artifact query must be at most 200 characters");
    const needle = options.query.toLowerCase();
    const lines = content.split(/\r?\n/);
    const selected = new Set<number>();
    lines.forEach((line, index) => { if (line.toLowerCase().includes(needle)) for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i += 1) selected.add(i); });
    return { content: [...selected].sort((a, b) => a - b).map(index => `${index + 1}:${lines[index]}`).join("\n"), selection: { query: options.query } };
  }
  return { content, selection: null };
}

/**
 * @notice Reads an authorized, integrity-checked artifact selection within page limits.
 * @param options Pagination and optional Markdown-section or query selection.
 * @returns Artifact metadata and a bounded content page.
 */
export async function readArtifact(access: RunAccess, artifactId: string, options: { offset?: number; limit?: number; section?: string; query?: string } = {}) {
  const { capability } = await authenticate(access.runDir, access.token);
  const artifact = await loadArtifact(access.runDir, access.stateRoot, artifactId);
  const allowed = capability.owner || artifact.taskId === capability.taskId && artifact.attempt === capability.attempt && (artifact.kind !== "message" || artifact.recipient === capability.role);
  if (!allowed) throw new Error("Capability is not authorized to read this artifact");
  const selected = selectedArtifactContent(artifact.content, options);
  const selectedContent = selected.content;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_ARTIFACT_PAGE_SIZE;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_PAGE_SIZE) throw new Error(`limit must be between 1 and ${MAX_ARTIFACT_PAGE_SIZE}`);
  const metadata = { ...artifact, content: undefined };
  const makePage = (content: string) => {
    const nextOffset = offset + content.length;
    return {
      artifactId,
      metadata,
      content,
      offset,
      totalLength: selectedContent.length,
      totalBytes: Buffer.byteLength(selectedContent, "utf8"),
      sha256: artifact.contentSha256,
      selection: selected.selection,
      complete: nextOffset >= selectedContent.length,
      nextOffset: nextOffset < selectedContent.length ? nextOffset : null,
    };
  };
  const available = Math.min(limit, Math.max(0, selectedContent.length - offset));
  let low = 0;
  let high = available;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = makePage(selectedContent.slice(offset, offset + middle));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_SERIALIZED_PAGE_BYTES) low = middle;
    else high = middle - 1;
  }
  const page = makePage(selectedContent.slice(offset, offset + low));
  if (available > 0 && low === 0) throw new Error("Artifact metadata leaves no room in the serialized tool-result budget");
  return page;
}

async function allArtifacts(access: RunAccess): Promise<StoredArtifact[]> {
  const directory = join(access.runDir, "artifacts");
  if (!existsSync(directory)) return [];
  assertSafeTree(access.stateRoot, directory);
  const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  const artifacts: StoredArtifact[] = [];
  const corrupt: string[] = [];
  for (const name of names) {
    try {
      artifacts.push(await loadArtifact(access.runDir, access.stateRoot, name.slice(0, -5)));
    } catch (error) {
      corrupt.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (corrupt.length) throw new Error(`Corrupt crew evidence blocks this operation pending explicit owner recovery: ${corrupt.join("; ")}`);
  return artifacts;
}

/**
 * @notice Quarantines corrupt artifact evidence under explicit owner authority.
 * @param artifactId Identifier of the corrupt artifact to quarantine.
 */
export async function discardCorruptArtifact(access: RunAccess, artifactId: string): Promise<void> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may recover corrupt evidence");
  assertId(artifactId, "artifactId");
  const source = join(access.runDir, "artifacts", `${artifactId}.json`);
  const quarantine = join(access.runDir, "quarantine");
  await mkdirSafe(access.stateRoot, quarantine);
  assertSafeTree(access.stateRoot, source);
  if (!existsSync(source)) throw new Error(`Unknown corrupt artifact: ${artifactId}`);
  await rename(source, join(quarantine, `${artifactId}.${Date.now()}.corrupt.json`));
  await publishExclusive(join(quarantine, `${artifactId}.${Date.now()}.recovery.json`), `${JSON.stringify({ schemaVersion: 1, artifactId, action: "discard-corrupt", recoveredAt: new Date().toISOString() }, null, 2)}\n`);
}

function hasMarkdownSection(content: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(content);
}

async function matchingHandoff(access: RunAccess, options: { kind: "report" | "review"; authorRole: string; task: TaskAttemptState; headSha?: string; sourceSnapshotId?: string; requiredSections: string[] }): Promise<StoredArtifact> {
  const candidates = (await allArtifacts(access)).filter(artifact =>
    artifact.kind === options.kind && artifact.authorRole === options.authorRole &&
    artifact.taskId === options.task.taskId && artifact.attempt === options.task.attempt &&
    artifact.contractVersion === options.task.contractVersion && artifact.baseSha === options.task.baseSha &&
    (!options.headSha || artifact.headSha === options.headSha) && (!options.sourceSnapshotId || artifact.sourceSnapshotId === options.sourceSnapshotId));
  if (candidates.length !== 1) throw new Error(`Managed ${options.kind} completion requires exactly one current, integrity-valid artifact; found ${candidates.length}`);
  const artifact = candidates[0];
  if (!artifact.headSha) throw new Error(`Managed ${options.kind} must declare an exact headSha`);
  const declared = new Set(artifact.requiredSections ?? []);
  for (const section of options.requiredSections) {
    if (!declared.has(section) || !hasMarkdownSection(artifact.content, section)) throw new Error(`Managed ${options.kind} is missing required section: ${section}`);
  }
  return artifact;
}

/**
 * @notice Gates executor submission on current, complete report evidence and no blockers.
 * @param requiredSections Markdown sections required in the executor report.
 * @param sourceSnapshotId Optional exact source fingerprint bound to the report.
 * @returns The submitted task-attempt state.
 */
export async function submitTaskAttempt(access: RunAccess, taskId: string, attempt: number, requiredSections = ["Summary", "Validation", "Assumptions", "Risks"], sourceSnapshotId?: string): Promise<TaskAttemptState> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may gate managed submission");
  const task = await readTaskAttempt(access, taskId, attempt);
  if (task.status !== "running") throw new Error(`Task submission requires running state, found ${task.status}`);
  const blockers = await unresolvedBlockersFor(access, "executor", taskId, attempt);
  if (blockers.length) throw new Error(`Task submission is blocked by unresolved messages: ${blockers.map(item => item.artifactId).join(", ")}`);
  const report = await matchingHandoff(access, { kind: "report", authorRole: "executor", task, sourceSnapshotId, requiredSections });
  if (sourceSnapshotId && report.sourceSnapshotId !== sourceSnapshotId) throw new Error("Executor report does not identify the exact captured source snapshot");
  const submitted = await transitionTaskAttempt(access, taskId, attempt, "running", { status: "submitted", headSha: report.headSha, sourceSnapshotId, reportArtifactId: report.artifactId });
  await releaseWriterOwnership(access, taskId, attempt);
  return submitted;
}

/**
 * @notice Starts review only for an artifact-gated submitted attempt.
 * @param reviewerSessionGeneration Optional reviewer-session generation marker.
 * @returns The attempt transitioned to review.
 */
export async function beginTaskReview(access: RunAccess, taskId: string, attempt: number, reviewerSessionGeneration?: string): Promise<TaskAttemptState> {
  const task = await readTaskAttempt(access, taskId, attempt);
  if (!task.reportArtifactId || !task.headSha) throw new Error("Review requires an artifact-gated submitted report and exact head SHA");
  await loadArtifact(access.runDir, access.stateRoot, task.reportArtifactId);
  return transitionTaskAttempt(access, taskId, attempt, "submitted", { status: "reviewing", reviewerSessionGeneration });
}

/**
 * @notice Resolves review status from one current structured review artifact.
 * @param requiredSections Markdown sections required in the review.
 * @returns The approved, revision-needed, or blocked task state.
 */
export async function completeTaskReview(access: RunAccess, taskId: string, attempt: number, requiredSections = ["Verdict", "Findings", "Validation"]): Promise<TaskAttemptState> {
  const task = await readTaskAttempt(access, taskId, attempt);
  if (task.status !== "reviewing" || !task.headSha) throw new Error("Review completion requires reviewing state with an exact submitted head");
  const blockers = await unresolvedBlockersFor(access, "reviewer", taskId, attempt);
  if (blockers.length) throw new Error(`Review completion is blocked by unresolved messages: ${blockers.map(item => item.artifactId).join(", ")}`);
  const review = await matchingHandoff(access, { kind: "review", authorRole: "reviewer", task, headSha: task.headSha, sourceSnapshotId: task.sourceSnapshotId, requiredSections });
  const status = review.verdict === "PASS" ? "approved" : review.verdict === "BLOCKED" ? "blocked" : "revision-needed";
  return transitionTaskAttempt(access, taskId, attempt, "reviewing", { status, reviewArtifactId: review.artifactId });
}

function acknowledgementPath(access: RunAccess, capability: Capability, artifactId: string): string {
  return join(access.runDir, "acknowledgements", capability.tokenHash, `${artifactId}.json`);
}

/**
 * @notice Persists idempotent acknowledgement of addressed inbox messages.
 * @param artifactIds Message artifact identifiers to acknowledge.
 */
export async function acknowledgeInbox(access: RunAccess, artifactIds: string[]): Promise<void> {
  const { capability } = await authenticate(access.runDir, access.token);
  for (const artifactId of [...new Set(artifactIds)]) {
    const artifact = await loadArtifact(access.runDir, access.stateRoot, artifactId);
    if (artifact.kind !== "message" || (!capability.owner && (artifact.recipient !== capability.role || artifact.taskId !== capability.taskId || artifact.attempt !== capability.attempt))) throw new Error(`Message ${artifactId} is not addressed to this capability`);
    const path = acknowledgementPath(access, capability, artifactId);
    await mkdirSafe(access.stateRoot, dirname(path));
    try {
      await publishExclusive(path, `${JSON.stringify({ schemaVersion: 1, artifactId, acknowledgedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function resolvingReplyIds(artifacts: StoredArtifact[]): Set<string> {
  const byId = new Map(artifacts.map(item => [item.artifactId, item]));
  return new Set(artifacts.filter(item => {
    if (item.kind !== "message" || item.category !== "answer" || !item.replyTo) return false;
    const original = byId.get(item.replyTo);
    if (!original || original.kind !== "message") return false;
    if (["finding", "dependency-change"].includes(original.category ?? "")) return item.authorRole === original.authorRole || item.authorRole === "brain";
    return item.authorRole === original.recipient || item.authorRole === "brain";
  }).map(item => item.replyTo!));
}

async function unresolvedBlockersFor(access: RunAccess, recipient: string, taskId?: string, attempt?: number): Promise<StoredArtifact[]> {
  const artifacts = await allArtifacts(access);
  const replies = resolvingReplyIds(artifacts);
  return artifacts.filter(item => item.kind === "message" && item.recipient === recipient && item.blocking === true &&
    (taskId === undefined || item.taskId === taskId) && (attempt === undefined || item.attempt === attempt) && !replies.has(item.artifactId));
}

function encodeInboxCursor(item: StoredArtifact): string { return `${item.sequence}:${item.artifactId}`; }
function cursorSequence(cursor: string): number {
  const separator = cursor.indexOf(":");
  const sequence = Number(cursor.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid inbox cursor");
  return sequence;
}

/**
 * @notice Reads authorized message deltas and unresolved blockers with stable cursors.
 * @param options Message cursor, blocker cursor, and bounded page size.
 * @returns The inbox page and continuation cursors.
 */
export async function readInbox(access: RunAccess, options: { after?: string; blockerAfter?: string; limit?: number } = {}): Promise<{ messages: InboxEntry[]; nextCursor: string | null; unresolvedBlockerIds: string[]; nextBlockerCursor: string | null }> {
  const { capability } = await authenticate(access.runDir, access.token);
  const all = await allArtifacts(access);
  const artifacts = all.filter(item => item.kind === "message" && (capability.owner || item.recipient === capability.role && item.taskId === capability.taskId && item.attempt === capability.attempt))
    .sort((left, right) => left.sequence - right.sequence);
  const afterSequence = options.after ? cursorSequence(options.after) : 0;
  if (options.after && !artifacts.some(item => encodeInboxCursor(item) === options.after)) throw new Error("Inbox cursor is not an addressed message");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Inbox limit must be between 1 and 100");
  const selected = artifacts.filter(item => item.sequence > afterSequence).slice(0, limit);
  const replies = resolvingReplyIds(all);
  const messages: InboxEntry[] = selected.map(item => ({
    artifactId: item.artifactId,
    sender: item.authorRole,
    category: item.category!,
    taskId: item.taskId,
    attempt: item.attempt,
    replyTo: item.replyTo,
    blocking: item.blocking === true,
    acknowledged: existsSync(acknowledgementPath(access, capability, item.artifactId)),
    resolved: replies.has(item.artifactId),
    preview: item.content.replace(/\s+/g, " ").trim().slice(0, 240),
    finalizedAt: item.finalizedAt,
  }));
  const blockers = artifacts.filter(item => item.blocking === true && !replies.has(item.artifactId));
  const blockerAfterSequence = options.blockerAfter ? cursorSequence(options.blockerAfter) : 0;
  if (options.blockerAfter && !artifacts.some(item => encodeInboxCursor(item) === options.blockerAfter)) throw new Error("Blocker cursor is not an addressed message");
  const selectedBlockers = blockers.filter(item => item.sequence > blockerAfterSequence).slice(0, limit);
  const response = {
    messages,
    nextCursor: selected.length ? encodeInboxCursor(selected[selected.length - 1]) : options.after ?? null,
    unresolvedBlockerIds: selectedBlockers.map(item => item.artifactId),
    nextBlockerCursor: selectedBlockers.length && blockers.some(item => item.sequence > selectedBlockers[selectedBlockers.length - 1].sequence) ? encodeInboxCursor(selectedBlockers[selectedBlockers.length - 1]) : null,
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_SERIALIZED_PAGE_BYTES) throw new Error("Inbox page exceeds the serialized tool-result budget; retry with a smaller limit");
  return response;
}

/**
 * @notice Creates or advances the compact, revisioned phase-plan index.
 * @param input Next exact plan revision and phase states.
 * @returns The persisted plan index with schema metadata.
 */
export async function writePlanIndex(access: RunAccess, input: Omit<PlanIndex, "schemaVersion" | "updatedAt">): Promise<PlanIndex> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may update the plan index");
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("Plan revision must be a positive integer");
  if (!Array.isArray(input.phases) || input.phases.length > 100) throw new Error("Plan index must contain at most 100 phases");
  const ids = new Set<string>();
  for (const phase of input.phases) {
    assertId(phase.id, "phase id"); assertId(phase.contractVersion, "contractVersion");
    if (!phase.summary.trim() || Buffer.byteLength(phase.summary, "utf8") > 512) throw new Error("Phase summaries must be non-empty and at most 512 bytes");
    if (ids.has(phase.id)) throw new Error(`Duplicate phase id: ${phase.id}`); ids.add(phase.id);
  }
  if (input.currentPhaseId !== null && !ids.has(input.currentPhaseId)) throw new Error("currentPhaseId must name an indexed phase");
  if (input.phases.filter(phase => phase.status === "current").length !== (input.currentPhaseId ? 1 : 0)) throw new Error("Exactly the current phase must have current status");
  const value: PlanIndex = { schemaVersion: 1, ...input, updatedAt: new Date().toISOString() };
  return withStateLock(access, "plan-index", async () => {
    const path = join(access.runDir, "plan", "index.json");
    await mkdirSafe(access.stateRoot, dirname(path));
    if (existsSync(path)) {
      const current = JSON.parse(await readFile(path, "utf8")) as PlanIndex;
      if (input.revision !== current.revision + 1) throw new Error(`Plan revision must advance exactly from ${current.revision} to ${current.revision + 1}`);
      await writeReplacement(path, value);
    } else {
      if (input.revision !== 1) throw new Error("Initial plan revision must be 1");
      await publishExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
    }
    return value;
  });
}

/**
 * @notice Loads the current compact phase-plan index for an authorized run.
 * @returns The current plan index.
 */
export async function readPlanIndex(access: RunAccess): Promise<PlanIndex> {
  await authenticate(access.runDir, access.token);
  const value = JSON.parse(await readFile(join(access.runDir, "plan", "index.json"), "utf8")) as PlanIndex;
  if (value.schemaVersion !== 1) throw new Error("Invalid plan index");
  return value;
}

/**
 * @notice Publishes an immutable focused contract for one phase version.
 * @param contractVersion Immutable version label referenced by the plan.
 * @param content Focused Markdown handoff contract.
 * @returns Contract identity and content digest.
 */
export async function publishPhaseContract(access: RunAccess, phaseId: string, contractVersion: string, content: string): Promise<{ phaseId: string; contractVersion: string; sha256: string }> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may publish phase contracts");
  assertId(phaseId, "phaseId"); assertId(contractVersion, "contractVersion");
  if (!content.trim()) throw new Error("Phase contract cannot be blank");
  if (Buffer.byteLength(content, "utf8") > 32_000) throw new Error("Phase contract exceeds the 32KB focused handoff limit; move optional evidence into referenced artifacts");
  const path = join(access.runDir, "contracts", phaseId, `${contractVersion}.md`);
  await mkdirSafe(access.stateRoot, dirname(path));
  await publishExclusive(path, content);
  return { phaseId, contractVersion, sha256: createHash("sha256").update(content).digest("hex") };
}

/**
 * @notice Resolves the current plan phase to its immutable contract.
 * @returns The plan index, contract content, and contract digest.
 */
export async function readCurrentPhase(access: RunAccess): Promise<{ index: PlanIndex; contract: string; contractSha256: string }> {
  const index = await readPlanIndex(access);
  if (!index.currentPhaseId) throw new Error("Plan has no current phase");
  const phase = index.phases.find(item => item.id === index.currentPhaseId)!;
  const path = join(access.runDir, "contracts", phase.id, `${phase.contractVersion}.md`);
  assertSafeTree(access.stateRoot, path);
  const contract = await readFile(path, "utf8");
  return { index, contract, contractSha256: createHash("sha256").update(contract).digest("hex") };
}

/**
 * @notice Persists a compact immutable checkpoint for a completed phase boundary.
 * @param input Snapshot-bound decisions, remaining phases, and evidence references.
 * @returns The persisted checkpoint with schema metadata.
 */
export async function createPhaseCheckpoint(access: RunAccess, input: Omit<PhaseCheckpoint, "schemaVersion" | "createdAt">): Promise<PhaseCheckpoint> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may create checkpoints");
  assertId(input.phaseId, "phaseId"); assertId(input.contractVersion, "contractVersion");
  if (!/^[a-f0-9]{64}$/i.test(input.sourceSnapshotId)) throw new Error("Checkpoint sourceSnapshotId must be a SHA-256 fingerprint");
  const value: PhaseCheckpoint = { schemaVersion: 1, ...input, createdAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16_000) throw new Error("Checkpoint exceeds the 16KB compact handoff limit; replace optional detail with evidence references");
  const path = join(access.runDir, "checkpoints", `${input.phaseId}.json`);
  await mkdirSafe(access.stateRoot, dirname(path));
  if (existsSync(path)) throw new Error(`Checkpoint already exists for phase ${input.phaseId}`);
  await publishExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/**
 * @notice Loads and validates an authorized phase checkpoint.
 * @returns The requested phase checkpoint.
 */
export async function readPhaseCheckpoint(access: RunAccess, phaseId: string): Promise<PhaseCheckpoint> {
  await authenticate(access.runDir, access.token); assertId(phaseId, "phaseId");
  const value = JSON.parse(await readFile(join(access.runDir, "checkpoints", `${phaseId}.json`), "utf8")) as PhaseCheckpoint;
  if (value.schemaVersion !== 1 || value.phaseId !== phaseId) throw new Error("Invalid phase checkpoint");
  return value;
}

export type CleanupPreview = { previewId: string; artifactIds: string[]; retainedArtifactIds: string[]; createdAt: string };
async function protectedArtifactIds(access: RunAccess, artifacts: StoredArtifact[]): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  const taskRoot = join(access.runDir, "tasks");
  if (existsSync(taskRoot)) for (const task of await readdir(taskRoot)) for (const file of await readdir(join(taskRoot, task))) {
    const state = JSON.parse(await readFile(join(taskRoot, task, file), "utf8")) as TaskAttemptState;
    // Every task's sole report/review remains required evidence until the owner
    // records an explicit terminal disposition. Terminal status alone is never
    // permission to erase validation or recovery evidence.
    if (!state.evidenceDisposition) { if (state.reportArtifactId) protectedIds.add(state.reportArtifactId); if (state.reviewArtifactId) protectedIds.add(state.reviewArtifactId); }
  }
  const checkpointRoot = join(access.runDir, "checkpoints");
  if (existsSync(checkpointRoot)) for (const file of await readdir(checkpointRoot)) {
    const checkpoint = JSON.parse(await readFile(join(checkpointRoot, file), "utf8")) as PhaseCheckpoint;
    checkpoint.evidenceArtifactIds?.forEach(id => protectedIds.add(id));
  }
  const replies = resolvingReplyIds(artifacts);
  for (const item of artifacts) if (item.kind === "message" && item.blocking && !replies.has(item.artifactId)) protectedIds.add(item.artifactId);
  return protectedIds;
}
/**
 * @notice Computes an immutable cleanup preview without deleting protected evidence.
 * @param artifactIds Candidate artifact identifiers, bounded to one cleanup operation.
 * @returns Deletable and retained artifact identifiers under a preview ID.
 */
export async function previewArtifactCleanup(access: RunAccess, artifactIds: string[]): Promise<CleanupPreview> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may preview cleanup");
  const requested = [...new Set(artifactIds)];
  if (requested.length > 200) throw new Error("Cleanup preview accepts at most 200 artifact IDs per bounded operation");
  requested.forEach(id => assertId(id, "artifactId"));
  const artifacts = await allArtifacts(access);
  const byId = new Map(artifacts.map(item => [item.artifactId, item]));
  const protectedIds = await protectedArtifactIds(access, artifacts);
  for (const id of requested) if (!byId.has(id)) throw new Error(`Unknown artifact: ${id}`);
  const deletable = requested.filter(id => !protectedIds.has(id));
  const preview: CleanupPreview = { previewId: `cleanup-${randomUUID()}`, artifactIds: deletable, retainedArtifactIds: requested.filter(id => protectedIds.has(id)), createdAt: new Date().toISOString() };
  const path = join(access.runDir, "cleanup", `${preview.previewId}.preview.json`); await mkdirSafe(access.stateRoot, dirname(path));
  await publishExclusive(path, `${JSON.stringify(preview, null, 2)}\n`); return preview;
}

/**
 * @notice Executes a prior cleanup preview after rechecking current evidence protection.
 * @param previewId Immutable cleanup preview to execute.
 * @returns The deletion receipt and any newly retained artifacts.
 */
export async function finalizeArtifactCleanup(access: RunAccess, previewId: string): Promise<{ previewId: string; deletedArtifactIds: string[]; retainedArtifactIds?: string[] }> {
  const { capability } = await authenticate(access.runDir, access.token);
  if (!capability.owner) throw new Error("Only the run owner may finalize cleanup"); assertId(previewId, "previewId");
  return withStateLock(access, "cleanup", async () => {
    const dir = join(access.runDir, "cleanup"); const receiptPath = join(dir, `${previewId}.receipt.json`);
    if (existsSync(receiptPath)) return JSON.parse(await readFile(receiptPath, "utf8"));
    const preview = JSON.parse(await readFile(join(dir, `${previewId}.preview.json`), "utf8")) as CleanupPreview;
    const artifacts = await allArtifacts(access); const protectedNow = await protectedArtifactIds(access, artifacts);
    const pending = preview.artifactIds.filter(id => !protectedNow.has(id));
    const retainedArtifactIds = preview.artifactIds.filter(id => protectedNow.has(id));
    const journalPath = join(dir, `${previewId}.journal.json`);
    await writeReplacement(journalPath, { schemaVersion: 1, previewId, pending, retainedArtifactIds, startedAt: new Date().toISOString() });
    const deletedArtifactIds: string[] = [];
    for (const artifactId of pending) { const path = join(access.runDir, "artifacts", `${artifactId}.json`); if (existsSync(path)) await unlink(path); deletedArtifactIds.push(artifactId); }
    const receipt = { previewId, deletedArtifactIds, retainedArtifactIds, completedAt: new Date().toISOString() };
    await publishExclusive(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); await rm(journalPath, { force: true }); return receipt;
  });
}
