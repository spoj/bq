import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Project = {
  id: number;
  source: string;
  branch: string;
  integration: string;
};

export type TaskWorkspace = {
  path: string;
  base: string;
};

export type Candidate =
  | { status: "ready"; head: string; base: string }
  | { status: "repair"; reason: string }
  | { status: "noop"; head: string };

type CommandResult = { stdout: string; stderr: string; code: number };

class GitFailure extends Error {
  readonly code: number;

  constructor(command: string, result: CommandResult) {
    super(`git ${command} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.code = result.code;
  }
}

function run(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString() + (signal ? ` (${signal})` : ""),
        code: code ?? 1,
      });
    });
  });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trimEnd();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd);
  if (result.code !== 0) throw new GitFailure(args.join(" "), result);
  return result.stdout;
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return (await run("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd)).code === 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function configureRepository(path: string): Promise<void> {
  await git(path, ["config", "user.name", "bq"]);
  await git(path, ["config", "user.email", "bq@localhost"]);
}

function refForBranch(prefix: string, branch: string): string {
  return `${prefix}/${branch}`;
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function ensureIntegrationBranch(project: Project, path: string, initial: boolean): Promise<void> {
  await configureRepository(path);
  const upstreamRef = refForBranch("refs/remotes/origin", project.branch);
  if (!(await gitSucceeds(path, ["show-ref", "--verify", "--quiet", upstreamRef]))) {
    await git(path, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${project.branch}:${upstreamRef}`,
    ]);
  }
  const integrationRef = "refs/heads/bq-integration";
  if (initial) {
    await git(path, ["update-ref", integrationRef, upstreamRef]);
  } else if (!(await gitSucceeds(path, ["show-ref", "--verify", "--quiet", integrationRef]))) {
    await git(path, ["branch", "bq-integration", upstreamRef]);
  }
  await git(path, ["symbolic-ref", "HEAD", integrationRef]);
}

async function materializeIntegration(path: string): Promise<void> {
  await git(path, ["reset", "--hard", "refs/heads/bq-integration"]);
  await git(path, ["clean", "-fdx"]);
}

async function copyIntegration(project: Project, destination: string, base: string): Promise<void> {
  await materializeIntegration(project.integration);
  await mkdir(dirname(destination), { recursive: true });
  const result = await run("cp", ["--archive", "--reflink=auto", "--", project.integration, destination]);
  if (result.code !== 0) {
    throw new Error(`copying integration workspace failed (${result.code}): ${result.stderr.trim()}`);
  }
  await configureRepository(destination);
  await git(destination, ["remote", "set-url", "origin", project.integration]);
  await git(destination, ["checkout", "--detach", base]);
}

export async function initializeProject(project: Project): Promise<void> {
  const parent = dirname(project.integration);
  await mkdir(parent, { recursive: true });
  if (!(await exists(project.integration))) {
    const name = project.integration.slice(parent.length + 1);
    const prefix = `.${name}.bq-clone-`;
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(prefix)) await removeIfPresent(join(parent, entry));
    }
    const temporary = join(parent, `${prefix}${randomUUID()}`);
    try {
      await git(parent, [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        project.source,
        temporary,
      ]);
      await ensureIntegrationBranch(project, temporary, true);
      await materializeIntegration(temporary);
      await rename(temporary, project.integration);
    } catch (error) {
      await removeIfPresent(temporary);
      throw error;
    }
    return;
  }
  if (!(await exists(join(project.integration, ".git")))) {
    throw new Error(`integration path is not a Git repository: ${project.integration}`);
  }
  await ensureIntegrationBranch(project, project.integration, false);
  await materializeIntegration(project.integration);
}

export async function fetchUpstream(project: Project): Promise<string> {
  const upstreamRef = refForBranch("refs/remotes/origin", project.branch);
  await git(project.integration, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${project.branch}:${upstreamRef}`,
  ]);
  return git(project.integration, ["rev-parse", upstreamRef]);
}

export async function integrationHead(project: Project): Promise<string> {
  return git(project.integration, ["rev-parse", "refs/heads/bq-integration"]);
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

async function listSourcePaths(source: string, ignored: boolean): Promise<string[]> {
  const args = ["ls-files", "-z", "--others", "--directory", "--exclude-standard"];
  if (ignored) args.push("--ignored");
  return splitNul(await gitRaw(source, args)).map(path => path.replace(/\/$/, ""));
}

async function trackedAt(path: string, base: string): Promise<Set<string>> {
  const paths = splitNul(await gitRaw(path, ["ls-tree", "-r", "-z", "--name-only", base]));
  return new Set(paths);
}

function trackedPrefixes(tracked: Set<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const path of tracked) {
    let prefix = path;
    while (prefix.includes("/")) {
      prefix = prefix.slice(0, prefix.lastIndexOf("/"));
      prefixes.add(prefix);
    }
  }
  return prefixes;
}

function isTrackedCollision(path: string, tracked: Set<string>): boolean {
  if (tracked.has(path)) return true;
  let parent = path;
  while (parent.includes("/")) {
    parent = parent.slice(0, parent.lastIndexOf("/"));
    if (tracked.has(parent)) return true;
  }
  return false;
}

async function copyFiles(source: string, destination: string, paths: string[], tracked: Set<string>): Promise<string[]> {
  const prefixes = trackedPrefixes(tracked);
  const copyable: string[] = [];
  const pending = [...paths];
  for (const path of pending) {
    if (isTrackedCollision(path, tracked)) continue;
    let stat;
    try {
      stat = await lstat(join(source, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (prefixes.has(path)) {
      if (stat.isDirectory()) pending.push(...(await readdir(join(source, path))).map(name => `${path}/${name}`));
      continue;
    }
    copyable.push(path);
  }

  for (let start = 0; start < copyable.length;) {
    const batch: string[] = [];
    let size = destination.length + 64;
    while (start < copyable.length && batch.length < 512) {
      const path = copyable[start];
      if (batch.length > 0 && size + path.length + 1 > 180_000) break;
      batch.push(path);
      size += path.length + 1;
      start++;
    }
    await runCopy(source, destination, batch);
  }
  return copyable;
}

async function runCopy(source: string, destination: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const result = await run("cp", ["--archive", "--reflink=auto", "--parents", "--", ...paths, destination], source);
  if (result.code !== 0) {
    throw new Error(`copying local environment failed (${result.code}): ${result.stderr.trim()}`);
  }
}

async function copyExclude(source: string, destination: string): Promise<void> {
  const sourceExclude = resolve(source, await git(source, ["rev-parse", "--git-path", "info/exclude"]));
  if (!(await exists(sourceExclude))) return;
  const targetExclude = resolve(destination, await git(destination, ["rev-parse", "--git-path", "info/exclude"]));
  const result = await run("cp", ["--archive", "--reflink=auto", "--", sourceExclude, targetExclude]);
  if (result.code !== 0) {
    throw new Error(`copying Git exclude file failed (${result.code}): ${result.stderr.trim()}`);
  }
}

async function copyEnvironment(
  source: string,
  destination: string,
  paths: string[],
  tracked: Set<string>,
): Promise<void> {
  await copyFiles(source, destination, paths, tracked);
  await copyExclude(source, destination);
}

async function copySourceEnvironment(project: Project, candidatePath: string): Promise<void> {
  const tracked = await trackedAt(candidatePath, "HEAD");
  const ignored = await listSourcePaths(project.source, true);
  const untracked = await listSourcePaths(project.source, false);
  await copyEnvironment(project.source, candidatePath, [...ignored, ...untracked], tracked);
}

export async function createWorkspace(
  project: Project,
  path: string,
  base?: string,
): Promise<{ base: string; ignored: string[]; untracked: string[] }> {
  if (await exists(path)) throw new Error(`workspace already exists: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  const workspaceBase = base ?? (await integrationHead(project));
  await copyIntegration(project, path, workspaceBase);
  await git(path, ["switch", "-c", "bq-task"]);

  const tracked = await trackedAt(path, workspaceBase);
  const sourceIgnored = await listSourcePaths(project.source, true);
  const sourceUntracked = await listSourcePaths(project.source, false);
  const ignored = await copyFiles(project.source, path, sourceIgnored, tracked);
  const untracked = await copyFiles(project.source, path, sourceUntracked, tracked);
  await copyExclude(project.source, path);
  return { base: workspaceBase, ignored, untracked };
}

function under(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function statusPaths(status: string): Array<{ code: string; path: string }> {
  const tokens = status.split("\0").filter(Boolean);
  const result: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const path = token.slice(3);
    result.push({ code, path });
    if (code.includes("R") || code.includes("C")) index++;
  }
  return result;
}

async function validateWorkspace(
  workspace: TaskWorkspace,
  ignored: string[],
  untracked: string[],
): Promise<string | undefined> {
  const added = splitNul(await gitRaw(workspace.path, [
    "log",
    "-m",
    "--no-renames",
    "--format=",
    "--name-only",
    "-z",
    "--diff-filter=A",
    `${workspace.base}..refs/heads/bq-task`,
  ]));
  for (const path of added) {
    if (under(path, ignored)) return `ignored input was committed to the task: ${path}`;
  }
  const status = statusPaths(await gitRaw(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  for (const entry of status) {
    if (entry.code === "??") {
      if (!under(entry.path, untracked) && !under(entry.path, ignored)) {
        return `new untracked file is not part of the workspace baseline: ${entry.path}`;
      }
      continue;
    }
    if (under(entry.path, ignored)) {
      return `ignored input was added to the task: ${entry.path}`;
    }
    return `task workspace has uncommitted changes: ${entry.path}`;
  }
  return undefined;
}

async function copyCandidate(project: Project, candidatePath: string, base: string): Promise<void> {
  await removeIfPresent(candidatePath);
  await copyIntegration(project, candidatePath, base);
}

export async function prepareCandidate(
  project: Project,
  workspace: TaskWorkspace,
  candidatePath: string,
  ignored: string[],
  untracked: string[],
): Promise<Candidate> {
  const branch = await gitSucceeds(workspace.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ? await git(workspace.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    : "";
  if (branch !== "bq-task") return { status: "repair", reason: "task workspace is not on bq-task" };
  const reason = await validateWorkspace(workspace, ignored, untracked);
  if (reason) return { status: "repair", reason };

  const task = await git(workspace.path, ["rev-parse", "refs/heads/bq-task"]);
  const current = await integrationHead(project);
  if (!(await gitSucceeds(workspace.path, ["merge-base", "--is-ancestor", workspace.base, task]))) {
    return { status: "repair", reason: "task branch no longer descends from its workspace base" };
  }
  if (task === workspace.base || (await gitSucceeds(project.integration, ["merge-base", "--is-ancestor", task, current]))) {
    return { status: "noop", head: current };
  }

  try {
    await copyCandidate(project, candidatePath, current);
    await git(candidatePath, [
      "fetch",
      "--no-tags",
      workspace.path,
      `+refs/heads/bq-task:refs/remotes/bq-task`,
    ]);
    await git(candidatePath, ["merge", "--no-ff", "--no-edit", task]);
    await copyEnvironment(
      workspace.path,
      candidatePath,
      [...await listSourcePaths(workspace.path, true), ...await listSourcePaths(workspace.path, false)],
      await trackedAt(candidatePath, "HEAD"),
    );
    return { status: "ready", head: await git(candidatePath, ["rev-parse", "HEAD"]), base: current };
  } catch (error) {
    await removeIfPresent(candidatePath);
    if (error instanceof GitFailure && error.code === 1) return { status: "repair", reason: error.message };
    throw error;
  }
}

export async function publishCandidate(
  project: Project,
  head: string,
  expectedBase: string,
  candidatePath: string,
): Promise<boolean> {
  const candidateHead = await git(candidatePath, ["rev-parse", head === "HEAD" ? "HEAD" : head]);
  const temporaryRef = `refs/bq-candidates/${randomUUID()}`;
  try {
    await git(project.integration, [
      "fetch",
      "--no-tags",
      candidatePath,
      `+${candidateHead}:${temporaryRef}`,
    ]);
    try {
      await git(project.integration, ["update-ref", "refs/heads/bq-integration", temporaryRef, expectedBase]);
    } catch (error) {
      if (await integrationHead(project) !== expectedBase) return false;
      throw error;
    }
    return true;
  } finally {
    await gitSucceeds(project.integration, ["update-ref", "-d", temporaryRef]);
  }
}

export async function updateTaskIntegration(project: Project, workspace: TaskWorkspace): Promise<string> {
  const remotes = (await git(workspace.path, ["remote"])).split("\n").filter(Boolean);
  if (!remotes.includes("integration")) {
    await git(workspace.path, ["remote", "add", "integration", project.integration]);
  } else {
    await git(workspace.path, ["remote", "set-url", "integration", project.integration]);
  }
  const ref = "refs/remotes/integration/bq-integration";
  await git(workspace.path, [
    "fetch",
    "--no-tags",
    "integration",
    `+refs/heads/bq-integration:${ref}`,
  ]);
  return git(workspace.path, ["rev-parse", ref]);
}

async function fetchExactUpstream(project: Project, path: string, oid: string): Promise<void> {
  const ref = `refs/remotes/upstream/${project.branch}`;
  await git(path, [
    "fetch",
    "--no-tags",
    project.integration,
    `+${oid}:${ref}`,
  ]);
  const fetched = await git(path, ["rev-parse", ref]);
  if (fetched !== oid) throw new Error(`canonical upstream object did not match ${oid}, got ${fetched}`);
}

export async function prepareUpstream(
  project: Project,
  upstream: string,
  candidatePath: string,
): Promise<Candidate> {
  const current = await integrationHead(project);
  if (await gitSucceeds(project.integration, ["merge-base", "--is-ancestor", upstream, current])) {
    return { status: "noop", head: current };
  }
  try {
    await copyCandidate(project, candidatePath, current);
    await fetchExactUpstream(project, candidatePath, upstream);
    await git(candidatePath, ["merge", "--no-ff", "--no-edit", upstream]);
    await copySourceEnvironment(project, candidatePath);
    return { status: "ready", head: await git(candidatePath, ["rev-parse", "HEAD"]), base: current };
  } catch (error) {
    await removeIfPresent(candidatePath);
    if (error instanceof GitFailure && error.code === 1) return { status: "repair", reason: error.message };
    throw error;
  }
}

export async function fetchUpstreamIntoWorkspace(
  project: Project,
  path: string,
  oid: string,
): Promise<string> {
  await fetchExactUpstream(project, path, oid);
  return git(path, ["rev-parse", `refs/remotes/upstream/${project.branch}`]);
}
