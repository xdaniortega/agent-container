// CommonJS-style TypeScript (the repo root package.json is type=commonjs); run with node --experimental-strip-types.
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

type Catalog = Map<string, number>;
const MIN_FRACTION = 0.05;
const MAX_FRACTION = 0.9;

/** Parses "200K", "1M", "1.0M", "65.5K" or "8192" into a token count. */
function parseContextSize(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([KkMm]?)$/.exec(text.trim());
  if (!match) return undefined;
  const factor = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(Number(match[1]) * factor);
}

/** Parses `pi --list-models` output into a map of "provider/model" -> context window. */
function parseModelCatalog(output: string): Catalog {
  const catalog: Catalog = new Map();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || (cols[0] === "provider" && cols[1] === "model")) continue;
    const window = parseContextSize(cols[2]);
    if (window !== undefined && window > 0) catalog.set(`${cols[0]}/${cols[1]}`, window);
  }
  return catalog;
}

function validateFraction(value: number): number {
  if (!Number.isFinite(value) || value < MIN_FRACTION || value > MAX_FRACTION) throw new Error(`--fraction must be between ${MIN_FRACTION} and ${MAX_FRACTION}`);
  return value;
}

function computeOverrides(models: Iterable<string>, catalog: Catalog, fraction: number): { overrides: Record<string, { reserveTokens: number }>; warnings: string[] } {
  validateFraction(fraction);
  const overrides: Record<string, { reserveTokens: number }> = {};
  const warnings: string[] = [];
  for (const model of new Set(models)) {
    const window = catalog.get(model);
    if (window === undefined) { warnings.push(`Skipping ${model}: not found in the Pi model catalog`); continue; }
    overrides[model] = { reserveTokens: Math.floor(window * fraction) };
  }
  return { overrides, warnings };
}

/** Returns new settings with compaction.enabled=true and the overrides merged; every other key is preserved. */
function mergeSettings(existing: Record<string, unknown>, overrides: Record<string, { reserveTokens: number }>): Record<string, unknown> {
  const compaction = existing.compaction && typeof existing.compaction === "object" && !Array.isArray(existing.compaction) ? existing.compaction as Record<string, unknown> : {};
  const oldOverrides = compaction.modelOverrides && typeof compaction.modelOverrides === "object" && !Array.isArray(compaction.modelOverrides) ? compaction.modelOverrides as Record<string, unknown> : {};
  const modelOverrides: Record<string, unknown> = { ...oldOverrides };
  for (const [key, value] of Object.entries(overrides)) {
    const prior = modelOverrides[key] && typeof modelOverrides[key] === "object" ? modelOverrides[key] as Record<string, unknown> : {};
    modelOverrides[key] = { ...prior, ...value };
  }
  return { ...existing, compaction: { ...compaction, enabled: true, modelOverrides } };
}

function parseModelsFromTiers(config: { models?: Record<string, unknown> } | undefined): string[] {
  return Object.values(config?.models ?? {}).filter((value): value is string => typeof value === "string" && value.includes("/"));
}

type Options = { configCwd: string; settings: string; models: string[]; fraction: number; write: boolean };

function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Options {
  const options: Options = { configCwd: cwd, settings: join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"), models: [], fraction: 0.5, write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} requires a value`); return v; };
    if (arg === "--write") options.write = true;
    else if (arg === "--config-cwd") options.configCwd = resolve(value());
    else if (arg === "--settings") options.settings = resolve(value());
    else if (arg === "--fraction") options.fraction = validateFraction(Number(value()));
    else if (arg === "--model") {
      const model = value();
      if (!/^[^/\s]+\/\S+$/.test(model)) throw new Error(`--model must be provider/id, got ${model}`);
      options.models.push(model);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as Record<string, unknown>;
}

function writeSettingsAtomic(path: string, settings: Record<string, unknown>, now = new Date()): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.${now.toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(path, backup);
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temp, path);
  return backup;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { loadModelTiers } = require("../extensions/crew/index.ts");
  const existing = readSettings(options.settings);
  const models = new Set<string>(parseModelsFromTiers(loadModelTiers(options.configCwd).config as any));
  if (typeof existing.defaultProvider === "string" && typeof existing.defaultModel === "string") models.add(`${existing.defaultProvider}/${existing.defaultModel}`);
  for (const model of options.models) models.add(model);
  const catalog = parseModelCatalog(execFileSync("pi", ["--list-models"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const { overrides, warnings } = computeOverrides(models, catalog, options.fraction);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  const merged = mergeSettings(existing, overrides);
  console.log(`Target: ${options.settings}`);
  console.log(`compaction.enabled = true (fraction ${options.fraction})`);
  for (const [model, value] of Object.entries(overrides)) console.log(`  ${model}: reserveTokens ${value.reserveTokens} (window ${catalog.get(model)})`);
  if (!options.write) { console.log("Dry run: no files changed. Re-run with --write to apply."); return; }
  const backup = writeSettingsAtomic(options.settings, merged);
  console.log(`Written.${backup ? ` Backup: ${backup}` : ""}`);
}

module.exports = { MIN_FRACTION, MAX_FRACTION, parseContextSize, parseModelCatalog, validateFraction, computeOverrides, mergeSettings, parseModelsFromTiers, parseArgs, writeSettingsAtomic };

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
