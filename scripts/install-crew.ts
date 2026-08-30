const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const home = os.homedir();

const links = [
  {
    kind: "extension",
    source: path.join(repoRoot, "extensions", "crew"),
    target: path.join(home, ".pi", "agent", "extensions", "crew"),
  },
  {
    kind: "skill",
    source: path.join(repoRoot, "skills", "crew"),
    target: path.join(home, ".pi", "agent", "skills", "crew"),
  },
];

function ensureSource(source: string): void {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing source: ${source}`);
  }
}

function installLink(source: string, target: string, kind: string): void {
  ensureSource(source);
  const parent = path.dirname(target);

  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const current = path.resolve(parent, fs.readlinkSync(target));
      if (current === source) {
        console.log(`ok - ${kind} already linked: ${target} -> ${source}`);
        return;
      }
      if (!force) {
        console.warn(`skip - ${kind} already links elsewhere: ${target} -> ${current} (use --force to replace)`);
        return;
      }
    } else if (!force) {
      console.warn(`skip - ${kind} already exists and is not a symlink: ${target} (use --force to replace)`);
      return;
  }
    }

  console.log(`${dryRun ? "would link" : "link"} - ${kind}: ${target} -> ${source}`);
  if (dryRun) return;
  fs.mkdirSync(parent, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(source, target, "dir");
}

for (const link of links) {
  installLink(link.source, link.target, link.kind);
}

console.log("done - reload or restart Pi to pick up crew skill/extension");
