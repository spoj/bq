import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function project(t: { after: (fn: () => void) => void }): { repo: string; env: NodeJS.ProcessEnv } {
  const temp = mkdtempSync(join("/tmp", "bq-cli-"));
  const repo = join(temp, "project");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README"), "project\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const env = {
    ...process.env,
    HOME: join(temp, "home"),
    BQ_DATA_HOME: join(temp, "data"),
    BQ_STATE_HOME: join(temp, "state"),
  };
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { repo, env };
}

function run(cli: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

function fails(cli: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

function packagedCli(t: { after: (fn: () => void) => void }): string {
  const temp = mkdtempSync(join("/tmp", "bq-package-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root, stdio: "ignore" });
  const archive = execFileSync("npm", ["pack", "--silent", "--pack-destination", temp], { cwd: root, encoding: "utf8" }).trim();
  const install = join(temp, "install");
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", install, join(temp, archive)], { cwd: root, stdio: "ignore" });
  const cli = join(install, "node_modules", "bq", "dist", "cli.js");
  assert.equal(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"), true);
  return cli;
}

test("help works from the packaged JavaScript CLI without creating state", t => {
  const { env } = project(t);
  const state = env.BQ_STATE_HOME!;
  const cli = packagedCli(t);
  const output = run(cli, env, "--help");
  assert.match(output, /Usage: bq/);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bin.bq, "./dist/cli.js");
  assert.equal(existsSync(join(state, "queue.sqlite")), false);
  assert.match(run(cli, env, "help"), /concurrency/);
});

test("init, add, zero concurrency, cancel, retry, and show use the built CLI", t => {
  const { repo, env } = project(t);
  const cli = packagedCli(t);
  const registered = JSON.parse(run(cli, env, "init", repo, "--model", "test/model", "--pi-config", "~/agent-config"));
  assert.equal(registered.source, repo);
  assert.equal(registered.branch, "main");
  assert.equal(registered.piConfig, join(env.HOME!, "agent-config"));

  const task = JSON.parse(run(cli, env, "add", "--cwd", repo, "make", "a", "change"));
  assert.equal(task.status, "queued");
  const concurrency = JSON.parse(run(cli, env, "concurrency", "0"));
  assert.deepEqual(concurrency, { target: 0, balanceSeconds: 0, running: 0 });

  run(cli, env, "cancel", String(task.id));
  assert.equal(JSON.parse(run(cli, env, "show", String(task.id))).status, "canceled");
  run(cli, env, "retry", String(task.id));
  assert.equal(JSON.parse(run(cli, env, "show", String(task.id))).status, "queued");
  assert.match(fails(cli, env, "show", String(task.id), "extra"), /requires exactly one argument/);
});

test("single-value commands reject extra positionals", t => {
  const { repo, env } = project(t);
  const cli = packagedCli(t);
  assert.match(fails(cli, env, "init", repo, repo, "--model", "test/model"), /at most one/);
  assert.match(fails(cli, env, "concurrency", "1", "2"), /at most one/);
  assert.match(fails(cli, env, "sync", repo, repo), /at most one/);
});
