import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWorkspace,
  fetchUpstream,
  fetchUpstreamIntoWorkspace,
  git,
  initializeProject,
  integrationHead,
  prepareCandidate,
  prepareUpstream,
  publishCandidate,
  type Project,
  type TaskWorkspace,
} from "../src/git.ts";

async function repository(): Promise<{ root: string; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "bq-git-test-"));
  const source = join(root, "source");
  const integration = join(root, "integration");
  await mkdir(source);
  await git(source, ["init", "--initial-branch", "main"]);
  await git(source, ["config", "user.name", "test"]);
  await git(source, ["config", "user.email", "test@example.com"]);
  await writeFile(join(source, ".gitignore"), ".env\ncache/\n");
  await writeFile(join(source, "app.txt"), "integration\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  await writeFile(join(source, ".git", "info", "exclude"), "*.secret\n");
  await writeFile(join(source, ".env"), "TOKEN=secret\n");
  await mkdir(join(source, "cache", "empty"), { recursive: true });
  await writeFile(join(source, "cache", "dependency"), "cached\n");
  await writeFile(join(source, "local.txt"), "local\n");
  await writeFile(join(source, "private.secret"), "private\n");
  await writeFile(join(source, "app.txt"), "dirty source\n");
  const project = { id: 1, source, branch: "main", integration };
  await initializeProject(project);
  return { root, project };
}

async function commit(path: string, message: string, file: string, content: string): Promise<void> {
  await writeFile(join(path, file), content);
  await git(path, ["add", file]);
  await git(path, ["commit", "-m", message]);
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("workspace copies local environment and prepares a clean candidate", async () => {
  const { root, project } = await repository();
  try {
    const path = join(root, "task");
    const metadata = await createWorkspace(project, path);
    assert.ok(metadata.ignored.includes(".env"));
    assert.ok(metadata.ignored.includes("cache"));
    assert.ok((await stat(join(path, "cache", "empty"))).isDirectory());
    assert.ok(metadata.untracked.includes("local.txt"));
    assert.ok(metadata.ignored.includes("private.secret"));
    assert.equal(await readFile(join(path, "app.txt"), "utf8"), "integration\n");
    assert.equal(await readFile(join(path, ".env"), "utf8"), "TOKEN=secret\n");
    assert.equal(await readFile(join(path, "local.txt"), "utf8"), "local\n");
    assert.equal(await readFile(join(path, "private.secret"), "utf8"), "private\n");
    assert.equal(await readFile(join(path, ".git", "info", "exclude"), "utf8"), "*.secret\n");
    await writeFile(join(path, "app.txt"), "task-only\n");
    await git(path, ["config", "bq.task-only", "yes"]);
    assert.equal(await readFile(join(project.integration, "app.txt"), "utf8"), "integration\n");
    await assert.rejects(git(project.integration, ["config", "--get", "bq.task-only"]));
    await writeFile(join(path, "app.txt"), "integration\n");

    await commit(path, "task change", "feature.txt", "feature\n");
    await writeFile(join(path, "cache", "generated"), "installed during task\n");
    const candidatePath = join(root, "candidate");
    const workspace: TaskWorkspace = { path, base: metadata.base };
    const candidate = await prepareCandidate(project, workspace, candidatePath, metadata.ignored, metadata.untracked);
    assert.equal(candidate.status, "ready");
    if (candidate.status !== "ready") return;
    assert.equal(await readFile(join(candidatePath, "feature.txt"), "utf8"), "feature\n");
    assert.equal(await readFile(join(candidatePath, ".env"), "utf8"), "TOKEN=secret\n");
    assert.equal(await readFile(join(candidatePath, "cache", "generated"), "utf8"), "installed during task\n");
    assert.ok((await stat(join(candidatePath, "cache", "empty"))).isDirectory());
    assert.equal(await readFile(join(candidatePath, "app.txt"), "utf8"), "integration\n");
    assert.equal(await publishCandidate(project, candidate.head, candidate.base, candidatePath), true);
    assert.equal(await integrationHead(project), candidate.head);
  } finally {
    await cleanup(root);
  }
});

test("committed ignored inputs and new untracked files require repair", async () => {
  const { root, project } = await repository();
  try {
    const path = join(root, "task");
    const metadata = await createWorkspace(project, path);
    await git(path, ["add", "-f", ".env"]);
    await git(path, ["commit", "-m", "mistake"]);
    const workspace: TaskWorkspace = { path, base: metadata.base };
    const committed = await prepareCandidate(project, workspace, join(root, "candidate"), metadata.ignored, metadata.untracked);
    assert.equal(committed.status, "repair");
    assert.match(committed.status === "repair" ? committed.reason : "", /ignored input was committed/);
    await git(path, ["rm", ".env"]);
    await git(path, ["commit", "-m", "delete leaked file"]);
    const deleted = await prepareCandidate(project, workspace, join(root, "candidate"), metadata.ignored, metadata.untracked);
    assert.equal(deleted.status, "repair");
    assert.match(deleted.status === "repair" ? deleted.reason : "", /ignored input was committed/);

    await git(path, ["reset", "--soft", metadata.base]);
    await git(path, ["reset"]);
    await writeFile(join(path, "new.txt"), "new\n");
    const untracked = await prepareCandidate(project, workspace, join(root, "candidate"), metadata.ignored, metadata.untracked);
    assert.equal(untracked.status, "repair");
    assert.match(untracked.status === "repair" ? untracked.reason : "", /new untracked/);
  } finally {
    await cleanup(root);
  }
});

test("conflicting candidates never leave integration conflicted", async () => {
  const { root, project } = await repository();
  try {
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    const firstMeta = await createWorkspace(project, firstPath);
    const secondMeta = await createWorkspace(project, secondPath, firstMeta.base);
    await commit(firstPath, "first", "app.txt", "first\n");
    await commit(secondPath, "second", "app.txt", "second\n");
    const first = await prepareCandidate(project, { path: firstPath, base: firstMeta.base }, join(root, "first-candidate"), firstMeta.ignored, firstMeta.untracked);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.equal(await publishCandidate(project, first.head, first.base, join(root, "first-candidate")), true);
    const head = await integrationHead(project);
    const second = await prepareCandidate(project, { path: secondPath, base: secondMeta.base }, join(root, "second-candidate"), secondMeta.ignored, secondMeta.untracked);
    assert.equal(second.status, "repair");
    assert.equal(await integrationHead(project), head);
  } finally {
    await cleanup(root);
  }
});

test("publishing uses compare-and-swap", async () => {
  const { root, project } = await repository();
  try {
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    const firstMeta = await createWorkspace(project, firstPath);
    await commit(firstPath, "first", "first.txt", "first\n");
    const firstCandidatePath = join(root, "first-candidate");
    const first = await prepareCandidate(project, { path: firstPath, base: firstMeta.base }, firstCandidatePath, firstMeta.ignored, firstMeta.untracked);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;

    const secondMeta = await createWorkspace(project, secondPath);
    await commit(secondPath, "second", "second.txt", "second\n");
    const secondCandidatePath = join(root, "second-candidate");
    const second = await prepareCandidate(project, { path: secondPath, base: secondMeta.base }, secondCandidatePath, secondMeta.ignored, secondMeta.untracked);
    assert.equal(second.status, "ready");
    if (second.status !== "ready") return;
    assert.equal(await publishCandidate(project, second.head, second.base, secondCandidatePath), true);
    assert.equal(await publishCandidate(project, first.head, first.base, firstCandidatePath), false);
  } finally {
    await cleanup(root);
  }
});

test("upstream revisions are fetched into resolver workspaces and candidates", async () => {
  const { root, project } = await repository();
  try {
    await git(project.source, ["reset", "--hard", "HEAD"]);
    await commit(project.source, "upstream", "upstream.txt", "upstream\n");
    const upstream = await fetchUpstream(project);
    const candidatePath = join(root, "upstream-candidate");
    const candidate = await prepareUpstream(project, upstream, candidatePath);
    assert.equal(candidate.status, "ready");
    if (candidate.status !== "ready") return;
    assert.equal(await readFile(join(candidatePath, "upstream.txt"), "utf8"), "upstream\n");
    assert.equal(await publishCandidate(project, candidate.head, candidate.base, candidatePath), true);

    const path = join(root, "resolver");
    const metadata = await createWorkspace(project, path);
    assert.equal(await fetchUpstreamIntoWorkspace(project, path, upstream), upstream);
    assert.equal(await git(path, ["rev-parse", `refs/remotes/upstream/${project.branch}`]), upstream);
    assert.equal(metadata.base, await git(path, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(root);
  }
});

test("source symlinks do not replace tracked candidate directories", async () => {
  const { root, project } = await repository();
  try {
    await mkdir(join(project.source, "tracked"));
    await writeFile(join(project.source, "tracked", "file"), "tracked\n");
    await git(project.source, ["add", "tracked/file"]);
    await git(project.source, ["commit", "-m", "tracked directory"]);
    const upstream = await fetchUpstream(project);
    const upstreamCandidatePath = join(root, "tracked-candidate");
    const upstreamCandidate = await prepareUpstream(project, upstream, upstreamCandidatePath);
    assert.equal(upstreamCandidate.status, "ready");
    if (upstreamCandidate.status !== "ready") return;
    assert.equal(await publishCandidate(project, upstreamCandidate.head, upstreamCandidate.base, upstreamCandidatePath), true);
    await rm(join(project.source, "tracked"), { recursive: true, force: true });
    await symlink("local.txt", join(project.source, "tracked"));
    const metadata = await createWorkspace(project, join(root, "task"));
    assert.equal(metadata.base, await integrationHead(project));
    assert.equal(await readFile(join(root, "task", "tracked", "file"), "utf8"), "tracked\n");
  } finally {
    await cleanup(root);
  }
});
