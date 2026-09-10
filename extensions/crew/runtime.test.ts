import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crewExtension, { rememberOwnerAccess } from "./index.ts";
import { appendPublicationChunk, beginPublication, createRunState, createTaskAttempt, createTaskCapability, finalizePublication, readInbox } from "./state.ts";

const repo = mkdtempSync(join(tmpdir(), "crew-fresh-runtime-repo-"));
const stateRoot = mkdtempSync(join(tmpdir(), "crew-fresh-runtime-state-"));
const previousStateRoot = process.env.CREW_STATE_ROOT; const previousHerdrEnv = process.env.HERDR_ENV; process.env.CREW_STATE_ROOT = stateRoot; process.env.HERDR_ENV = "1";
try {
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "runtime@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Runtime"]);
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", repo, "add", "source.ts"]); execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);

  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const events = new Map<string, any[]>(); const entries: any[] = []; const notices: any[] = []; const modelMessages: any[] = [];
  crewExtension({
    exec: async (command: string, args?: string[]) => command === "herdr" && args?.[0] === "pane" && args?.[1] === "current"
      ? ({ code: 0, stdout: JSON.stringify({ result: { pane: { foreground_cwd: repo, workspace_id: "runtime-workspace", tab_id: "runtime-tab" } } }), stderr: "" })
      : ({ code: 0, stdout: "", stderr: "" }),
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendMessage(message: unknown, options: unknown) { modelMessages.push({ message, options }); },
  } as any);
  assert.deepEqual([...tools.keys()], ["crew_launch", "crew_read_context", "crew_publish", "crew_read", "crew_control", "crew_rules"]);
  assert.ok(commands.has("crew-handoff"));

  const sessionId = "isolated-runtime-session";
  const access = await createRunState({ cwd: repo, stateRoot, runId: "runtime-run", ownerSessionId: sessionId }); rememberOwnerAccess(sessionId, access);
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => sessionId } };
  const control = tools.get("crew_control");
  const call = (params: any) => control.execute("runtime", { runId: access.runId, repositoryId: access.repositoryId, ...params }, undefined, undefined, ctx);
  await call({ action: "contract-publish", phaseId: "r4", contractVersion: "v1", content: "# Scope\nIsolated verification\n" });
  await call({ action: "plan-write", plan: { revision: 1, currentPhaseId: "r4", phases: [{ id: "r4", summary: "Runtime", status: "current", contractVersion: "v1" }] } });
  const phase = JSON.parse((await call({ action: "phase-read" })).content[0].text); assert.match(phase.contract, /Isolated verification/);
  const snapshot = JSON.parse((await call({ action: "snapshot", sourcePaths: ["source.ts"] })).content[0].text); assert.equal(snapshot.paths[0], "source.ts");

  const evidenceDraft = await beginPublication(access, { kind: "checkpoint", phaseId: "evidence" }); await appendPublicationChunk(access, evidenceDraft, 0, "retained evidence"); const evidence = await finalizePublication(access, evidenceDraft, 1);
  const preview = JSON.parse((await call({ action: "cleanup-preview", artifactIds: [evidence.artifactId] })).content[0].text);
  await call({ action: "checkpoint-create", checkpoint: { phaseId: "r4", contractVersion: "v1", sourceSnapshotId: snapshot.id, summary: "runtime passed", decisions: [], remainingPhaseIds: [], unresolvedBlockerIds: [], approvalState: "approved", evidenceArtifactIds: [evidence.artifactId] } });
  const cleanup = JSON.parse((await call({ action: "cleanup-finalize", previewId: preview.previewId })).content[0].text); assert.deepEqual(cleanup.retainedArtifactIds, [evidence.artifactId]);

  const messageEnd = events.get("message_end")![0];
  const warningCtx = { cwd: repo, getContextUsage: () => ({ tokens: 126000 }), sessionManager: { getSessionId: () => sessionId, getBranch: () => [] }, ui: { notify: (...args: any[]) => notices.push(args) } };
  await messageEnd({ message: { role: "assistant", usage: { input: 1000, cacheRead: 125000, output: 10, cost: { total: 2 } } } }, warningCtx);
  await messageEnd({ message: { role: "assistant", usage: { input: 1000, cacheRead: 125000, output: 10 } } }, warningCtx);
  assert.equal(notices.length, 1); assert.equal(entries.filter(entry => entry.type === "crew-context-warning").length, 1); assert.equal(entries.filter(entry => entry.type === "crew-usage").length, 2);
  assert.equal(modelMessages.length, 1); assert.equal(modelMessages[0].options.deliverAs, "nextTurn"); assert.match(modelMessages[0].message.content, /session=isolated-runtime-session run=parent-local task=parent-session/);

  await createTaskAttempt(access, { taskId: "runtime-child", attempt: 1, contractVersion: "v1", baseSha: "a".repeat(40) });
  const childToken = await createTaskCapability(access, { role: "executor", taskId: "runtime-child", attempt: 1 });
  const childPrompt = `Managed durable lifecycle is enabled.\nrunId: ${access.runId}\nrepositoryId: ${access.repositoryId}\ntaskId: runtime-child\nattempt: 1\ncapabilityToken: ${childToken}`;
  const childEvents = new Map<string, any[]>(); const childModelMessages: any[] = [];
  crewExtension({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), registerTool() {},
    on(name: string, handler: any) { childEvents.set(name, [...(childEvents.get(name) ?? []), handler]); },
    appendEntry() {}, sendMessage(message: unknown, options: unknown) { childModelMessages.push({ message, options }); },
  } as any);
  const childCtx = { cwd: repo, getContextUsage: () => ({ tokens: 76000 }), sessionManager: { getSessionId: () => "runtime-child-session", getBranch: () => [{ type: "message", id: "child-prompt", parentId: null, message: { role: "user", content: childPrompt } }] }, ui: { notify: (...args: any[]) => notices.push(args) } };
  childEvents.get("session_start")![0]({}, childCtx); await childEvents.get("message_end")![0]({ message: { role: "assistant", usage: { input: 76000, output: 1 } } }, childCtx);
  let inbox = await readInbox(access); assert.equal(inbox.messages.filter(message => message.category === "notification" && message.taskId === "runtime-child").length, 1);
  assert.equal(childModelMessages.length, 1, "child queues only its local warning"); assert.equal(modelMessages.length, 1, "parent instance has not shared the child's sendMessage mock");
  const lookalikeDraft = await beginPublication(access, { kind: "message", taskId: "runtime-child", attempt: 1, recipient: "executor", category: "notification", blocking: false });
  await appendPublicationChunk(access, lookalikeDraft, 0, "Crew context warn: non-brain lookalike");
  const lookalike = await finalizePublication(access, lookalikeDraft, 1);

  const launch = tools.get("crew_launch");
  const waitParams = { role: "executor", task: "Wait for the managed runtime child status.", durable: true, runId: access.runId, taskId: "runtime-child", attempt: 1, managedAction: "wait", waitMs: 1 };
  await launch.execute("runtime-wait-1", waitParams, undefined, undefined, ctx);
  assert.equal(modelMessages.length, 2); assert.equal(modelMessages[1].options.deliverAs, "nextTurn"); assert.equal(modelMessages[1].options.triggerTurn, false);
  assert.match(modelMessages[1].message.content, /session=runtime-child-session run=runtime-run task=runtime-child/);
  inbox = await readInbox(access);
  assert.equal(inbox.messages.find(message => message.artifactId !== lookalike.artifactId && message.taskId === "runtime-child")?.acknowledged, true);
  assert.equal(inbox.messages.find(message => message.artifactId === lookalike.artifactId)?.acknowledged, false, "non-brain warning lookalike remains unacknowledged");
  await launch.execute("runtime-wait-2", waitParams, undefined, undefined, ctx); assert.equal(modelMessages.length, 2, "acknowledged child warning is not queued twice and non-brain lookalike is not forwarded");
  inbox = await readInbox(access); assert.equal(inbox.messages.find(message => message.artifactId === lookalike.artifactId)?.acknowledged, false);
  console.log("ok - distinct parent/child extension runtimes deliver brain warnings once while ignoring and not acknowledging non-brain lookalikes");
  console.log("ok - isolated fresh extension runtime exercises compact restore, exact snapshot, warning propagation, hysteresis, and cleanup revalidation");
} finally {
  if (previousStateRoot === undefined) delete process.env.CREW_STATE_ROOT; else process.env.CREW_STATE_ROOT = previousStateRoot;
  if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdrEnv;
  rmSync(repo, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true });
}
