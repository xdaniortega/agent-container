/**
 * @notice Verifies model catalog parsing, reserve computation, and settings merging for configure-compaction.
 */
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { computeOverrides, mergeSettings, parseArgs, parseContextSize, parseModelCatalog, parseModelsFromTiers, validateFraction, writeSettingsAtomic } = require("./configure-compaction.ts");

const output = `provider      model                 context  max-out  thinking  images
anthropic     claude-opus-5-5       1M       128K     yes       yes
google        gemini-3.8-flash      1.0M     65.5K    yes       yes
anthropic     claude-haiku-4-5      200K     64K      yes       yes
odd           small-model           8192     1K       no        no
`;

assert.equal(parseContextSize("1M"), 1_000_000);
assert.equal(parseContextSize("1.5M"), 1_500_000);
assert.equal(parseContextSize("65.5K"), 65_500);
assert.equal(parseContextSize("nope"), undefined);

const catalog = parseModelCatalog(output);
assert.equal(catalog.size, 4);
assert.equal(catalog.get("anthropic/claude-opus-5-5"), 1_000_000);
assert.equal(catalog.get("google/gemini-3.8-flash"), 1_000_000);
assert.equal(catalog.get("anthropic/claude-haiku-4-5"), 200_000);

const { overrides, warnings } = computeOverrides(["anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "x/missing", "anthropic/claude-opus-5-5"], catalog, 0.5);
assert.deepEqual(overrides, { "anthropic/claude-opus-5-5": { reserveTokens: 500_000 }, "anthropic/claude-haiku-4-5": { reserveTokens: 100_000 } });
assert.equal(warnings.length, 1);
assert.match(warnings[0], /x\/missing/);
assert.equal(computeOverrides(["odd/small-model"], catalog, 0.33).overrides["odd/small-model"].reserveTokens, 2703);

assert.throws(() => validateFraction(0.01));
assert.throws(() => validateFraction(0.95));
assert.throws(() => validateFraction(NaN));
assert.equal(validateFraction(0.5), 0.5);

const merged = mergeSettings({ theme: "dark", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, modelOverrides: { "a/b": { reserveTokens: 5 }, "anthropic/claude-opus-5-5": { reserveTokens: 1, other: true } } } }, overrides) as any;
assert.equal(merged.theme, "dark");
assert.deepEqual(merged.retry, { enabled: false });
assert.equal(merged.compaction.enabled, true);
assert.equal(merged.compaction.keepRecentTokens, 1);
assert.deepEqual(merged.compaction.modelOverrides["a/b"], { reserveTokens: 5 });
assert.deepEqual(merged.compaction.modelOverrides["anthropic/claude-opus-5-5"], { reserveTokens: 500_000, other: true });
assert.deepEqual((mergeSettings({}, {}) as any).compaction, { enabled: true, modelOverrides: {} });

assert.deepEqual(parseModelsFromTiers({ models: { frontier: "a/b", small: "c/d", bad: "nope" } }), ["a/b", "c/d"]);

const parsed = parseArgs(["--model", "a/b", "--fraction", "0.4", "--write", "--settings", "/tmp/x.json"], { PI_CODING_AGENT_DIR: "/agent" } as any, "/cwd");
assert.deepEqual([parsed.models, parsed.fraction, parsed.write, parsed.settings, parsed.configCwd], [["a/b"], 0.4, true, "/tmp/x.json", "/cwd"]);
assert.equal(parseArgs([], { PI_CODING_AGENT_DIR: "/agent" } as any, "/cwd").settings, "/agent/settings.json");
assert.throws(() => parseArgs(["--fraction", "2"]));
assert.throws(() => parseArgs(["--model", "bad"]));
assert.throws(() => parseArgs(["--wat"]));

const dir = mkdtempSync(join(tmpdir(), "configure-compaction-"));
try {
  const path = join(dir, "settings.json");
  writeFileSync(path, '{"theme":"dark"}');
  const backup = writeSettingsAtomic(path, { theme: "dark", compaction: { enabled: true } }, new Date("2026-01-02T03:04:05.000Z"));
  assert.ok(backup && existsSync(backup));
  assert.equal(readFileSync(backup, "utf8"), '{"theme":"dark"}');
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "dark", compaction: { enabled: true } });
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith(".tmp")), []);
  const fresh = join(dir, "new", "settings.json");
  assert.equal(writeSettingsAtomic(fresh, { a: 1 }), undefined);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log("configure-compaction tests passed");
