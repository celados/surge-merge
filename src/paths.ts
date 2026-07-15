import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default Surge profiles directory on macOS. */
export const DEFAULT_PROFILES_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Surge/Profiles",
);

/** Package root (projects/surge-merge), independent of process.cwd(). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Default user config lives in-repo; personal credentials stay private. */
export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, "config/default.ts");

/** Expand `~/` and resolve to absolute path. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve profilesDir: expand home, default to DEFAULT_PROFILES_DIR. */
export function resolveProfilesDir(profilesDir?: string): string {
  return path.resolve(expandHome(profilesDir ?? DEFAULT_PROFILES_DIR));
}

/**
 * Resolve a path relative to base (profilesDir or package root).
 * Absolute paths and `~/` expand first; relative paths join base.
 */
export function resolveUnder(base: string, p: string): string {
  const expanded = expandHome(p);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(base, expanded);
}

/** Resolve config path: relative paths join package root, not cwd. */
export function resolveConfigPath(configPath?: string): string {
  if (!configPath) return DEFAULT_CONFIG_PATH;
  const expanded = expandHome(configPath);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  // Relative config paths are package-root relative so agents can run from anywhere.
  return path.resolve(PACKAGE_ROOT, expanded);
}
