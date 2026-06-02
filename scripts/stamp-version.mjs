#!/usr/bin/env node
// stamp-version.mjs — build-time version stamper for @w-gitops/jinn-cli (DEC-061)
// Format (SemVer 2.0): <upstreamM.M.P>-wgitops.<SEQ>+<shortSHA>   e.g. 0.17.1-wgitops.0042+a1b2c3d
//   upstream M.M.P : upstream package.json version (or --base) ; wgitops : our pre-release id
//   SEQ            : 4-digit zero-padded monotonic build no. (github.run_number, env BUILD_SEQ)
//   shortSHA       : 7-char commit (env GIT_SHA / GITHUB_SHA, else `git rev-parse`)
// Also enforces name=@w-gitops/jinn-cli, private:true, bin.jinn (never published to npm).
// Usage: node stamp-version.mjs [--base <upstreamVer>] [--channel dev|prod] [--pkg <path>]
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const pkgPath = opt("--pkg", "packages/jinn/package.json");
const channel = opt("--channel", process.env.JINN_CHANNEL || "dev");
let base = opt("--base", process.env.UPSTREAM_VERSION || "");

// derive upstream base if not provided: read upstream/main package.json via git
if (!base) {
  try {
    base = execSync("git show upstream/main:packages/jinn/package.json", { encoding: "utf8" });
    base = JSON.parse(base).version;
  } catch {
    // fallback: current pkg's numeric core (strip any existing prerelease/build)
    base = JSON.parse(readFileSync(pkgPath, "utf8")).version.split("-")[0].split("+")[0];
  }
}
const core = String(base).split("-")[0].split("+")[0]; // M.M.P only
if (!/^\d+\.\d+\.\d+$/.test(core)) { console.error(`bad base version: ${base}`); process.exit(1); }

const seqRaw = process.env.BUILD_SEQ || process.env.GITHUB_RUN_NUMBER || "0";
const seq = String(parseInt(seqRaw, 10) || 0).padStart(4, "0");

let sha = process.env.GIT_SHA || process.env.GITHUB_SHA || "";
if (!sha) { try { sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { sha = "0000000"; } }
sha = sha.slice(0, 7);

// SemVer 2.0 rule 9: a purely-numeric prerelease id must not have a leading zero.
// Prefix with "seq" so the zero-padded build number stays SemVer-legal + sortable.
const version = `${core}-wgitops.seq${seq}+${sha}`;

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = "@w-gitops/jinn-cli";     // enforce (never published; private fork)
pkg.private = true;
pkg.bin = pkg.bin && pkg.bin.jinn ? pkg.bin : { jinn: "./dist/bin/jinn.js" };
pkg.version = version;
// machine-readable build provenance for /api/status
pkg.wgitops = { channel, buildSeq: seq, upstreamBase: core, shortSha: sha, stampedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`stamped ${pkgPath}: version=${version} channel=${channel} (name=${pkg.name} private=${pkg.private})`);
