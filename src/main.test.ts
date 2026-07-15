import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

const PROJECT_DIR = dirname(import.meta.dir);
const ENTRY = join(PROJECT_DIR, "src", "main.ts");

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: PROJECT_DIR,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("@schema lists build", async () => {
  const { stdout, stderr, exitCode } = await run("@schema");
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("build");
  expect(stdout).not.toContain("hello(");
});

test("build dryRun smoke", async () => {
  const { stdout, stderr, exitCode } = await run("build", "{ dryRun: true, verbose: false }");
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toMatch(/dryRun:\s*true/);
  expect(stdout).toMatch(/bytes:\s*\d+/);
  expect(stdout).toMatch(/path:/);
  // dryRun must not claim a successful write
  expect(stderr).toMatch(/dryRun/i);
});
