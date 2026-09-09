import { closeSync, existsSync, openSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface ContainerConfig {
  image: string;
  model: string;
  thinking: string;
  env: string[];
  piConfig: string;
}

export interface RunSpec {
  name: string;
  workspace: string;
  stateDir: string;
  dataDir: string;
  prompt: string;
  config: ContainerConfig;
}

export interface RunningContainer {
  name: string;
  done: Promise<{ exitCode: number; error?: string }>;
  stop(): Promise<void>;
}

export interface ContainerInspection {
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number;
}

const copiedPiFiles = ["auth.json", "models.json"];

function podman(): string {
  return process.env.BQ_PODMAN || "podman";
}

export function podmanArgs(dataDir: string): string[] {
  const runtime = join(
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    "bq",
    createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16),
  );
  return [
    "--root", join(dataDir, "podman/storage"),
    "--runroot", join(runtime, "run"),
    "--tmpdir", join(runtime, "tmp"),
  ];
}

function absolute(path: string): string {
  return resolve(path.replace(/^~(?=\/|$)/, process.env.HOME || ""));
}

function checkEnvironmentNames(names: string[]): void {
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid inherited environment variable: ${name}`);
    }
  }
}

function inheritedEnvironmentArgs(names: string[]): string[] {
  checkEnvironmentNames(names);
  return names.flatMap((name) => ["--env", name]);
}

function mounts(spec: { name: string; workspace: string; stateDir: string }): string[] {
  const workspace = absolute(spec.workspace);
  const stateDir = absolute(spec.stateDir);
  return [
    "--volume", `${workspace}:/work:rw`,
    "--volume", `${stateDir}:/bq:rw`,
    "--volume", `${join(stateDir, "pi")}:/pi:rw`,
  ];
}

function commonRunArgs(spec: { name: string; workspace: string; stateDir: string; dataDir: string; config: ContainerConfig }): string[] {
  return [
    ...podmanArgs(spec.dataDir),
    "run",
    "--name", spec.name,
    "--pull=never",
    "--sig-proxy=false",
    "--userns=keep-id",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--workdir", "/work",
    ...mounts(spec),
    "--env", "HOME=/pi",
    "--env", "PI_CODING_AGENT_DIR=/pi",
    "--env", "PI_OFFLINE=1",
    "--env", "PI_SKIP_VERSION_CHECK=1",
    ...inheritedEnvironmentArgs(spec.config.env),
    spec.config.image,
  ];
}

export function buildAgentArgs(spec: RunSpec): string[] {
  return [
    ...commonRunArgs(spec),
    "pi",
    "--print",
    "--mode", "json",
    "--session", "/bq/session.jsonl",
    "--model", spec.config.model,
    "--thinking", spec.config.thinking,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--append-system-prompt", "Work on the bq-task branch. Commit your task changes and leave tracked files clean. Do not push. Existing ignored and untracked files are local environment; do not add them unless the task requires it.",
    "--",
    spec.prompt,
  ];
}

export interface CheckSpec {
  name: string;
  workspace: string;
  stateDir: string;
  dataDir: string;
  command: string;
  config: ContainerConfig;
}

export function buildCheckArgs(spec: CheckSpec): string[] {
  return [
    ...commonRunArgs(spec),
    "/bin/sh",
    "-lc",
    spec.command,
  ];
}

function runProcess(dataDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  args = [...podmanArgs(dataDir), ...args];
  return new Promise((resolveProcess) => {
    const child = spawn(podman(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolveProcess({ code: -1, stdout, stderr: error.message }));
    child.once("close", (code) => resolveProcess({ code: code ?? -1, stdout, stderr }));
  });
}

async function requireProcess(dataDir: string, args: string[]): Promise<string> {
  const result = await runProcess(dataDir, args);
  if (result.code !== 0) {
    throw new Error(`podman ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function copyPiConfig(config: ContainerConfig, stateDir: string): Promise<void> {
  const sourceDir = absolute(config.piConfig);
  const targetDir = join(absolute(stateDir), "pi");
  await mkdir(targetDir, { recursive: true });
  for (const file of copiedPiFiles) {
    const source = join(sourceDir, file);
    const target = join(targetDir, file);
    if (!existsSync(source) || existsSync(target)) continue;
    await cp(source, target, { force: false, preserveTimestamps: true });
  }
}

function logFiles(stateDir: string, name: string): [number, number] {
  const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  const output = join(absolute(stateDir), `run-${safeName}.stdout.log`);
  const error = join(absolute(stateDir), `run-${safeName}.stderr.log`);
  return [openSync(output, "a"), openSync(error, "a")];
}

async function launchContainer(args: string[], stateDir: string, name: string): Promise<{ done: Promise<{ exitCode: number; error?: string }> }> {
  const [stdout, stderr] = logFiles(stateDir, name);
  const child = spawn(podman(), args, {
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  let resolveDone!: (result: { exitCode: number; error?: string }) => void;
  const done = new Promise<{ exitCode: number; error?: string }>(resolve => {
    resolveDone = resolve;
  });
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
    child.once("error", error => {
      resolveDone({ exitCode: -1, error: error.message });
      rejectLaunch(error);
    });
    child.once("close", code => resolveDone({ exitCode: code ?? -1 }));
  });
  return { done };
}

export function waitContainer(name: string, dataDir: string): Promise<{ exitCode: number; error?: string }> {
  return new Promise((resolveWait) => {
    const child = spawn(podman(), [...podmanArgs(dataDir), "wait", name], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.once("error", (error) => resolveWait({ exitCode: -1, error: error.message }));
    child.once("close", async (code) => {
      try {
        const inspection = await inspectContainer(name, dataDir);
        if (inspection) {
          resolveWait({
            exitCode: inspection.exitCode,
            ...(code === 0 ? {} : { error: `podman wait exited ${code}` }),
          });
          return;
        }
        resolveWait({ exitCode: -1, error: `container ${name} could not be inspected` });
      } catch (error) {
        resolveWait({ exitCode: -1, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

async function start(spec: RunSpec | CheckSpec, args: string[]): Promise<RunningContainer> {
  await mkdir(absolute(spec.stateDir), { recursive: true });
  await copyPiConfig(spec.config, spec.stateDir);
  const launched = await launchContainer(args, spec.stateDir, spec.name);
  const done = launched.done;
  return {
    name: spec.name,
    done,
    stop: () => stopContainer(spec.name, spec.dataDir),
  };
}

export function startAgent(spec: RunSpec): Promise<RunningContainer> {
  return start(spec, buildAgentArgs(spec));
}

export function startCheck(spec: CheckSpec): Promise<RunningContainer> {
  return start(spec, buildCheckArgs(spec));
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value || value.startsWith("0001-")) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export async function inspectContainer(name: string, dataDir: string): Promise<ContainerInspection | null> {
  const result = await runProcess(dataDir, ["inspect", name]);
  if (result.code !== 0) {
    const missing = /no such container|does not exist|not found/i.test(result.stderr);
    if (missing) return null;
    throw new Error(`podman inspect ${name} failed (${result.code}): ${result.stderr.trim()}`);
  }
  try {
    const state = JSON.parse(result.stdout)[0]?.State;
    if (!state) return null;
    return {
      status: String(state.Status),
      startedAt: parseTimestamp(state.StartedAt),
      finishedAt: parseTimestamp(state.FinishedAt),
      exitCode: Number(state.ExitCode),
    };
  } catch {
    return null;
  }
}

export async function stopContainer(name: string, dataDir: string): Promise<void> {
  await requireProcess(dataDir, ["stop", "--time", "10", name]);
}

export async function removeContainer(name: string, dataDir: string): Promise<void> {
  await requireProcess(dataDir, ["rm", "--force", "--ignore", name]);
}
