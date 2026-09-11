import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { relative, resolve } from "node:path";

export const ADVISORY_DELEGATION_BYTES = 8_000;
export const ADVISORY_SUMMARY_BYTES = 3_200;
export const ADVISORY_CHECKPOINT_BYTES = 8_000;
export const CONTEXT_WARN_TOKENS = 75_000;
export const CONTEXT_CHECKPOINT_TOKENS = 125_000;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export type PayloadAssessment = { bytes: number; advisoryBytes: number; overBudget: boolean; advice?: string };
/**
 * @notice Measures a handoff payload against its advisory byte budget.
 * @param kind Payload class used to select the advisory limit.
 * @returns Byte usage, limit, and narrowing advice when over budget.
 */
export function assessPayload(content: string, kind: "delegation" | "summary" | "checkpoint"): PayloadAssessment {
  const advisoryBytes = kind === "delegation" ? ADVISORY_DELEGATION_BYTES : kind === "summary" ? ADVISORY_SUMMARY_BYTES : ADVISORY_CHECKPOINT_BYTES;
  const bytes = Buffer.byteLength(content, "utf8");
  return {
    bytes,
    advisoryBytes,
    overBudget: bytes > advisoryBytes,
    advice: bytes > advisoryBytes ? `Advisory ${kind} budget exceeded (${bytes}/${advisoryBytes} bytes). Narrow or split optional detail and reference immutable evidence; never omit mandatory requirements.` : undefined,
  };
}

export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  currentContextTokens: number;
  cost: number | null;
};
function nonnegative(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
/**
 * @notice Normalizes provider-specific usage fields into crew context accounting.
 * @param usage Pi usage data with either canonical or token-suffixed fields.
 * @returns Non-negative token portions, current context estimate, and cost.
 */
export function normalizeUsage(usage: any): NormalizedUsage {
  const input = nonnegative(usage?.input ?? usage?.inputTokens);
  const output = nonnegative(usage?.output ?? usage?.outputTokens);
  const cacheRead = nonnegative(usage?.cacheRead ?? usage?.cacheReadTokens);
  const cacheWrite = nonnegative(usage?.cacheWrite ?? usage?.cacheWriteTokens);
  // Pi's input is the non-cached input portion. Cache fields are additional input
  // portions, while reasoning is already represented in output by pi-ai.
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    currentContextTokens: input + cacheRead + cacheWrite,
    cost: typeof usage?.cost?.total === "number" ? usage.cost.total : typeof usage?.cost === "number" ? usage.cost : null,
  };
}

/**
 * @notice Selects a context-pressure warning level with threshold hysteresis.
 * @param previous Previously emitted level used to prevent threshold flapping.
 * @returns The current warning level.
 */
export function contextWarningLevel(tokens: number, previous: "none" | "warn" | "checkpoint" = "none"): "none" | "warn" | "checkpoint" {
  // 10K-token hysteresis prevents repeated notices when estimates hover near a threshold.
  if (previous === "checkpoint" && tokens >= CONTEXT_CHECKPOINT_TOKENS - 10_000) return "checkpoint";
  if (tokens >= CONTEXT_CHECKPOINT_TOKENS) return "checkpoint";
  if (previous === "warn" && tokens >= CONTEXT_WARN_TOKENS - 10_000) return "warn";
  if (tokens >= CONTEXT_WARN_TOKENS) return "warn";
  return "none";
}

export type SourceSnapshot = { id: string; baseSha: string; paths: string[]; dirtyPaths: string[]; bytes: number };
function assertSnapshotPath(cwd: string, path: string): string {
  if (!path || path.includes("\0")) throw new Error("Snapshot paths must be non-empty safe strings");
  const absolute = resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("../")) throw new Error(`Snapshot path escapes or names the repository root: ${path}`);
  return rel;
}
function git(cwd: string, args: string[]): Buffer { return execFileSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }); }

/**
 * @notice Fingerprints HEAD, index, worktree, deletions, and untracked bytes for an explicit source scope.
 * @param cwd Repository worktree containing the requested paths.
 * @param requestedPaths Repository-relative paths included in the review boundary.
 * @returns The exact source fingerprint and supporting scope metadata.
 */
export function captureSourceSnapshot(cwd: string, requestedPaths: string[]): SourceSnapshot {
  if (!requestedPaths.length) throw new Error("A managed review snapshot requires at least one explicit source path");
  const paths = [...new Set(requestedPaths.map(path => assertSnapshotPath(cwd, path)))].sort();
  const baseSha = git(cwd, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const dirtyPaths = status.toString("utf8").split("\0").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line).sort();
  const indexEntries = git(cwd, ["ls-files", "--stage", "-z", "--", ...paths]);
  const worktreeDiff = git(cwd, ["diff", "--binary", "--no-ext-diff", "--", ...paths]);
  const untrackedNames = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update("crew-source-snapshot-v2\0");
  hash.update(baseSha); hash.update("\0paths\0");
  for (const path of paths) { hash.update(path); hash.update("\0"); }
  // Index entries contain exact blob IDs and modes, so staged-only changes and
  // staged deletions remain visible even when worktree bytes match HEAD.
  hash.update("index\0"); hash.update(indexEntries); hash.update("\0worktree-diff\0"); hash.update(worktreeDiff);
  let bytes = indexEntries.length + worktreeDiff.length;
  hash.update("\0untracked\0");
  for (const name of untrackedNames) {
    const absolute = resolve(cwd, name);
    hash.update(name); hash.update("\0");
    if (!existsSync(absolute)) { hash.update("missing\0"); continue; }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { hash.update(`symlink:${readlinkSync(absolute)}\0`); continue; }
    if (!stat.isFile()) { hash.update(`non-file:${stat.mode}\0`); continue; }
    const body = readFileSync(absolute); bytes += body.length;
    hash.update(body); hash.update("\0");
  }
  return { id: hash.digest("hex"), baseSha, paths, dirtyPaths, bytes };
}
