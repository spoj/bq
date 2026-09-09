import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentArgs,
  buildCheckArgs,
  inspectContainer,
  startAgent,
  podmanArgs,
  podmanEnv,
} from "../src/container.ts";

const config = {
  image: "localhost/bq-agent:dev",
  model: "anthropic/claude-sonnet",
  thinking: "medium",
  env: ["ANTHROPIC_API_KEY"],
  piConfig: "/host/pi/agent",
};

function indexOf(args: string[], value: string): number {
  const index = args.indexOf(value);
  assert.notEqual(index, -1, `${value} missing from ${args.join(" ")}`);
  return index;
}

test("agent and check commands use isolated mounts and explicit policy", () => {
  const agent = buildAgentArgs({
    name: "bq-task-7",
    workspace: "/tmp/work space",
    stateDir: "/tmp/bq state",
    dataDir: "/tmp/bq data",
    prompt: "Fix the tests",
    config,
  });
  assert.equal(agent[0], "--root");
  assert.deepEqual(agent.slice(0, 6), ["--root", "/tmp/bq data/podman/storage", "--runroot", agent[3], "--tmpdir", agent[5]]);
  assert.equal(agent[6], "run");
  assert.equal(agent.includes("--detach"), false);
  assert.deepEqual(agent.slice(indexOf(agent, "--volume"), indexOf(agent, "--env")), [
    "--volume", "/tmp/work space:/work:rw",
    "--volume", "/tmp/bq state:/bq:rw",
    "--volume", "/tmp/bq state/pi:/pi:rw",
  ]);
  assert.ok(agent.includes("--userns=keep-id"));
  assert.ok(agent.includes("--cap-drop=all"));
  assert.ok(agent.includes("--http-proxy=false"));
  assert.ok(agent.includes("--security-opt=no-new-privileges"));
  assert.deepEqual(agent.slice(-2), ["--", "Fix the tests"]);
  assert.equal(agent[indexOf(agent, "--env") + 1], "HOME=/pi");
  assert.ok(agent.includes("ANTHROPIC_API_KEY"));
  assert.ok(agent.includes("--no-approve"));

  const check = buildCheckArgs({
    name: "bq-check-7",
    workspace: "/tmp/work",
    stateDir: "/tmp/state",
    dataDir: "/tmp/data",
    command: "npm test",
    config,
  });
  assert.deepEqual(check.slice(-3), ["/bin/sh", "-lc", "npm test"]);
});

test("Podman does not inherit host proxy settings", () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://host-only.invalid:8888";
  try {
    assert.equal(podmanEnv().HTTPS_PROXY, undefined);
    assert.equal(process.env.HTTPS_PROXY, "http://host-only.invalid:8888");
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});

test("agent launch returns before the foreground container exits and copies credentials once", async () => {
  const root = await mkdtemp(join(tmpdir(), "bq-container-test-"));
  const fakePodman = join(root, "podman");
  await writeFile(fakePodman, `#!/bin/sh
while [ "$1" = "--root" ] || [ "$1" = "--runroot" ] || [ "$1" = "--tmpdir" ]; do shift 2; done
case "$1" in
  run) sleep 0.2 ;;
  wait) sleep 0.01 ;;
  inspect) printf '[{"State":{"Status":"exited","StartedAt":"2026-01-01T00:00:00Z","FinishedAt":"2026-01-01T00:00:01Z","ExitCode":0}}]' ;;
  *) exit 0 ;;
esac
`);
  await chmod(fakePodman, 0o755);
  const piConfig = join(root, "pi");
  await mkdir(piConfig);
  await writeFile(join(piConfig, "auth.json"), "auth-v1");
  await writeFile(join(piConfig, "models.json"), "models-v1");
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  await mkdir(workspace);
  const oldPodman = process.env.BQ_PODMAN;
  process.env.BQ_PODMAN = fakePodman;
  try {
    const started = Date.now();
    const running = await startAgent({
      name: "task/7",
      workspace,
      stateDir,
      dataDir: join(root, "data"),
      prompt: "work",
      config: { ...config, piConfig },
    });
    assert.ok(Date.now() - started < 180);
    assert.equal(await readFile(join(stateDir, "pi/auth.json"), "utf8"), "auth-v1");
    assert.equal(await readFile(join(stateDir, "pi/models.json"), "utf8"), "models-v1");
    assert.ok((await readFile(join(stateDir, "run-task_7.stdout.log"), "utf8")) !== undefined);
    assert.deepEqual(await running.done, { exitCode: 0 });

    await writeFile(join(piConfig, "auth.json"), "auth-v2");
    const second = await startAgent({
      name: "task-8",
      workspace,
      stateDir,
      dataDir: join(root, "data"),
      prompt: "continue",
      config: { ...config, piConfig },
    });
    assert.equal(await readFile(join(stateDir, "pi/auth.json"), "utf8"), "auth-v1");
    await second.done;
  } finally {
    if (oldPodman === undefined) delete process.env.BQ_PODMAN;
    else process.env.BQ_PODMAN = oldPodman;
  }
});

test("private podman storage is derived from bq data and isolated by project", async () => {
  const first = podmanArgs("/tmp/bq-data");
  const second = podmanArgs("/tmp/other-data");
  assert.deepEqual(first.slice(0, 2), ["--root", "/tmp/bq-data/podman/storage"]);
  assert.deepEqual(first.slice(4, 6), ["--tmpdir", first[5]]);
  assert.notEqual(first[3], second[3]);
  assert.match(first[3], /\/bq\/[^/]+\/run$/);
  assert.match(first[5], /\/bq\/[^/]+\/tmp$/);
});

test("inspection treats a missing container as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "bq-container-test-"));
  const fakePodman = join(root, "podman");
  await writeFile(fakePodman, "#!/bin/sh\necho 'no such container' >&2\nexit 125\n");
  await chmod(fakePodman, 0o755);
  const oldPodman = process.env.BQ_PODMAN;
  process.env.BQ_PODMAN = fakePodman;
  try {
    assert.equal(await inspectContainer("missing", join(root, "data")), null);
  } finally {
    if (oldPodman === undefined) delete process.env.BQ_PODMAN;
    else process.env.BQ_PODMAN = oldPodman;
  }
});
