#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Store } from "./store.ts";
import { notify, work } from "./worker.ts";
import { podmanArgs } from "./container.ts";

const program = fileURLToPath(import.meta.url);

type Parsed = ReturnType<typeof parseArgs>;

function options(args: string[], definitions: ParseArgsConfig["options"], allowPositionals = true): Parsed {
  return parseArgs({ args, options: definitions, allowPositionals, strict: true });
}

function stringOption(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function numberOption(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a number`);
  return result;
}

function repoRoot(path: string): string {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${path} is not a Git repository`);
  }
}

function branchAt(path: string): string {
  try {
    return execFileSync("git", ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${path} is in detached HEAD state; specify --branch`);
  }
}

function requireBranch(path: string, branch: string): void {
  try {
    execFileSync("git", ["-C", path, "show-ref", "--verify", `refs/heads/${branch}`], { stdio: "ignore" });
  } catch {
    throw new Error(`branch does not exist in ${path}: ${branch}`);
  }
}

function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function onePositional(parsed: Parsed, name: string): string {
  if (parsed.positionals.length !== 1) throw new Error(`${name} requires exactly one argument`);
  return parsed.positionals[0];
}

function noPositionals(parsed: Parsed, name: string): void {
  if (parsed.positionals.length) throw new Error(`${name} does not accept positional arguments`);
}

function piConfig(value: unknown): string {
  const input = typeof value === "string" && value.length ? value : "~/.pi/agent";
  return resolve(input.startsWith("~/") ? `${homedir()}/${input.slice(2)}` : input === "~" ? homedir() : input);
}

const USAGE = `Usage: bq <command> [options]

Commands:
  init [PATH]              register a Git project
  add --cwd PATH PROMPT    queue work for a project
  list                     list projects and tasks
  show ID                  show a task
  cancel ID                cancel a task
  retry ID                 retry a blocked or canceled task
  concurrency [TARGET]     show or set average concurrency
  sync [PATH]              request an upstream sync
  worker                   run the worker
  build                    build the Podman image
  podman ARGS...           run Podman against bq's private store`;

async function init(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {
    branch: { type: "string" },
    image: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string", default: "medium" },
    check: { type: "string" },
    env: { type: "string", multiple: true },
    "pi-config": { type: "string" },
    "max-repairs": { type: "string", default: "3" },
  });
  if (parsed.positionals.length > 1) throw new Error("init accepts at most one project path");
  const source = repoRoot(String(parsed.positionals[0] ?? "."));
  const branch = String(parsed.values.branch ?? branchAt(source));
  requireBranch(source, branch);
  const image = String(parsed.values.image ?? "bq-agent:local");
  const model = stringOption(parsed.values.model, "--model");
  const maxRepairs = numberOption(parsed.values["max-repairs"], "--max-repairs");
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) throw new Error("--max-repairs must be a non-negative integer");
  const project = store.register({
    source,
    branch,
    image,
    model,
    thinking: String(parsed.values.thinking),
    checkCommand: parsed.values.check ? String(parsed.values.check) : null,
    env: (parsed.values.env as string[] | undefined) ?? [],
    piConfig: piConfig(parsed.values["pi-config"]),
    maxRepairs,
  });
  json(project);
  await notify(store.stateDir);
}

async function add(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, { cwd: { type: "string", default: "." } });
  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) throw new Error("task prompt is required");
  const source = repoRoot(String(parsed.values.cwd));
  const project = store.projectFor(source);
  const task = store.add(project.id, prompt);
  json(task);
  await notify(store.stateDir);
}

async function list(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  noPositionals(parsed, "list");
  json({ projects: store.listProjects(), tasks: store.tasks() });
}

async function show(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  const id = Number(onePositional(parsed, "show"));
  if (!Number.isInteger(id) || id < 1) throw new Error("task ID must be a positive integer");
  const task = store.task(id);
  json({ ...task, project: store.project(task.projectId), runs: store.runs(id) });
}

async function cancel(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  const id = Number(onePositional(parsed, "cancel"));
  if (!Number.isInteger(id) || id < 1) throw new Error("task ID must be a positive integer");
  store.cancel(id);
  await notify(store.stateDir);
}

async function retry(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  const id = Number(onePositional(parsed, "retry"));
  if (!Number.isInteger(id) || id < 1) throw new Error("task ID must be a positive integer");
  store.retry(id);
  await notify(store.stateDir);
}

async function concurrency(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  if (parsed.positionals.length > 1) throw new Error("concurrency accepts at most one target");
  if (parsed.positionals.length) {
    const target = numberOption(parsed.positionals[0], "target concurrency");
    if (!(target >= 0)) throw new Error("target concurrency must be non-negative");
    store.setConcurrency(target);
  }
  const state = store.concurrency();
  json({ target: state.target, balanceSeconds: state.balance / 1000, running: state.running });
  if (parsed.positionals.length) await notify(store.stateDir);
}

async function sync(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {}, true);
  if (parsed.positionals.length > 1) throw new Error("sync accepts at most one project path");
  const source = repoRoot(String(parsed.positionals[0] ?? "."));
  const project = store.projectFor(source);
  store.requestSync(project.id);
  await notify(store.stateDir);
}

function podmanCommand(): string {
  return process.env.BQ_PODMAN || "podman";
}

function build(store: Store, args: string[]): void {
  const parsed = options(args, { tag: { type: "string", default: "bq-agent:local" } });
  noPositionals(parsed, "build");
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(podmanCommand(), [...podmanArgs(store.dataDir), "build", "-f", `${root}Containerfile`, "-t", String(parsed.values.tag), root], { stdio: "inherit" });
}

function podman(store: Store, args: string[]): void {
  execFileSync(podmanCommand(), [...podmanArgs(store.dataDir), ...args], { stdio: "inherit" });
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const cleanup = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    child.once("error", error => { cleanup(); rejectProcess(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`worker exited with ${signal ?? `code ${code}`}`));
    });
  });
}

async function runWorker(store: Store, locked: boolean): Promise<void> {
  if (locked) {
    await work(store);
    return;
  }
  await runProcess("flock", ["--no-fork", "--nonblock", `${store.stateDir}/worker.lock`, process.execPath, program, "worker", "--locked"]);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h" || (command !== "podman" && (args.includes("--help") || args.includes("-h")))) {
    console.log(USAGE);
    return;
  }
  const store = new Store();
  try {
    switch (command) {
      case "init": await init(store, args); break;
      case "add": await add(store, args); break;
      case "list": await list(store, args); break;
      case "show": await show(store, args); break;
      case "cancel": await cancel(store, args); break;
      case "retry": await retry(store, args); break;
      case "concurrency": await concurrency(store, args); break;
      case "sync": await sync(store, args); break;
      case "build": build(store, args); break;
      case "podman": podman(store, args); break;
      case "worker": {
        const parsed = options(args, { locked: { type: "boolean", default: false } });
        noPositionals(parsed, "worker");
        await runWorker(store, Boolean(parsed.values.locked));
        break;
      }
      default: throw new Error(`unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
