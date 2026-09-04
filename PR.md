# Crew Delegation Reliability & Complete Project-Scoped Session Isolation

This PR delivers comprehensive reliability improvements for Crew role delegation inside Herdr and completes project-scoped session isolation for `pic` / `pic-proxy`, enabling automatic host session and token discovery in agentsview.

The work is organized into two self-contained commits:

1. **`fix(crew): improve delegation reliability, tool enforcement, and test coverage`**
   - **Test runner path:** Repointed `package.json` test script to canonical `extensions/crew/index.test.ts`.
   - **Marker stitching integrity:** Discontinued blind concatenation across non-overlapping output snapshots when start markers scroll out of view; snapshot gaps are flagged as unreliable to prevent corrupted answers.
   - **Read-only enforcement:** Realized read-only role authority at launch with `--tools read,grep,find,ls` allowlists, denying editing and mutating bash tools while retaining full tools for editing roles.
   - **Config-driven writer queue:** Keyed the queue serializer on resolved project/global configuration authority rather than built-in role defaults, ensuring custom overrides (e.g. `scout: can-edit`) serialize correctly.
   - **Hard runtime ceiling:** Bounded total delegation runtime with an absolute cap (`hardCapMs`, default 2x `timeoutMs`), ending infinite polling loops on stuck "working" roles.
   - **Corroborated exit detection:** Required consecutive missing reads across a grace window before treating lookup failures as process exits, eliminating false completes from transient lookup hiccups and preventing unexpected vanishings from mapping to successful completion.
   - **Reused idle pane guard:** Prevented reused idle panes from completing prematurely on stale output from previous delegations; requires fresh execution evidence (observed `working` transition or current unique marker pair).
   - **Deterministic test suite:** Extracted testable seams (`runCrewPollingLoop`, `classifyDelegationResult`) and covered polling loop timeouts, hard caps, exit detection, reuse guards, heartbeats, and status classifications with a virtual clock.

2. **`feat(pic): persist and isolate project sessions for host agentsview visibility`**
   - **Project-scoped host persistence:** Persistent VirtioFS bind mount from host project-scoped namespace (`~/.pi/agent/sessions/<project-namespace>/`) into `/pi-sessions`, moving transcripts out of the working tree and into a location agentsview discovers automatically.
   - **Pruned config staging:** Staged host `~/.pi` configuration per-project outside the workspace tree (`~/.pic-container/pi-config/<id>`), excluding `agent/sessions` by construction to eliminate read-only exposure of unrelated project transcripts.
   - **Credential parity preserved:** Staged `auth.json` unconditionally so `entrypoint.sh`'s existing `PIC_EXCLUDE_AUTH=1` copy-time exclusion continues to govern whether it is installed into `/root/.pi`.
   - **Dedicated cache mounts:** Mounted host `npm` and `git` caches read-only on dedicated paths (`/host-pi-npm`, `/host-pi-git`) when present, retargeting `entrypoint.sh` symlinks.
   - **Container reuse detection:** Updated `findContainerWithMount` to require both the project sessions mount and the staged configuration mount, ensuring pre-existing wide-mount containers are rejected rather than reused.
   - **Mount invariant test suite:** Added `runner-utils.test.cjs` asserting namespace transform parity, project sessions targeting `/pi-sessions`, wide-mount invariant rejection, and zero `sessions` paths in staged trees.
   - **Documentation:** Updated README session isolation and configuration handling sections to document the delivered isolation boundary.

## Residual, by Design

- **Same-project session reach:** An agent can read its own project's sessions, including earlier and sibling-role sessions within the same container VM (unavoidable because `container exec` cannot alter mounts at runtime, and tools inherit Pi's container user privileges).
- **Session integrity:** `can-edit` roles can modify files in the project session directory, so transcripts are agent-authored data rather than a tamper-proof audit log; agentsview renders untrusted session content.
- **Herdr bridge cross-project channel:** `herdr agent list` connects across the host bridge and enumerates agents across workspaces, independent of container file mounts.
- **Trust paths:** `trust.json` contains trusted project directory paths across the host machine.
- **Provider credentials:** `auth.json` continues to be staged and mounted into `/host-pi` so that stored credentials remain functional, with `PIC_EXCLUDE_AUTH=1` skipping copy into `/root/.pi` as before.

## Validation

- `npm test`: Passes 44/44 tests cleanly across both suites (40 crew tests + 4 runner invariant & staging tests) with zero exit code.
- Static checks: `node --check pic-runner.cjs`, `node --check runner-utils.cjs`, and `sh -n entrypoint.sh` pass cleanly.
- In-container isolation verification (on a freshly started container):
  - `/host-pi/agent/sessions`: Absent by construction; no other project namespace directories are visible or traversable.
  - `/pi-sessions`: Only the active project's `.jsonl` files are present.
  - `mount` / `findmnt`: No mount exists with source `~/.pi` or `~/.pi/agent/sessions`.
  - Staging regression guard: Staged config tree contains zero directories or files named `sessions`.
- Host verification:
  - agentsview discovers this project's sessions with token/agent usage without manual steps.
  - Container reuse rejects containers created with the old wide mount.
