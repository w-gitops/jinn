import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Dynamic engine-binary resolution.
 *
 * Jinn ships to other users' machines, so engine binaries must NEVER be
 * hardcoded to an absolute path. We resolve a binary the same way a shell
 * would (search PATH), plus a few common install dirs that aren't always on
 * a daemon's PATH (notably `~/.local/bin`, where the Antigravity installer
 * drops `agy`). An optional config override (`engines.<name>.bin`) wins.
 */

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Common install locations not guaranteed to be on a daemon's PATH. */
export function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"), // npm global prefix (common override)
    "/opt/homebrew/lib/node_modules/.bin", // homebrew node global bins
  ];
}

/**
 * Resolve an engine binary to an absolute path.
 *
 * Resolution order:
 *   1. `override` that looks like a path (contains a separator) → returned
 *      verbatim, even if missing, so a wrong config surfaces a clear spawn error.
 *   2. `override` that is a bare name → resolved as if it were `name`.
 *   3. First match on `$PATH`.
 *   4. First match in {@link commonBinDirs}.
 *   5. Fallback: the bare `name`, letting `spawn`/`pty.spawn` try its own PATH.
 */
export function resolveBin(name: string, override?: string): string {
  if (override && override.trim()) {
    const o = override.trim();
    if (o.includes("/") || o.includes(path.sep)) {
      return o; // explicit path — honor it as-is
    }
    name = o; // bare-name override → resolve that name instead
  }

  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  for (const dir of [...pathDirs, ...commonBinDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }

  return name; // let the OS try to resolve it on spawn
}
