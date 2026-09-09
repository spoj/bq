#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { Store, type Project, type ProjectSettings } from './store.ts';
import { notify, work } from './worker.ts';
import { buildImage, DEFAULT_IMAGE, podmanArgs, podmanEnv } from './container.ts';

const program = fileURLToPath(import.meta.url);
const common = { json: { type: 'boolean' as const }, cwd: { type: 'string' as const, default: '.' } };
const labels: Record<string, string> = { running: 'working', publishing: 'integrating' };
const usage = `Usage:
  bq                          see the queue
  bq add "Fix the login bug"   queue work in the current Git repository
  bq run --concurrency 1.5     process the queue in the foreground
  bq show 12                  inspect progress, results, or a problem
  bq cancel 12                cancel a task
  bq retry 12                 resume a blocked or canceled task
  bq config                   see this project's settings

Use --json for structured output, bq config --help for settings,
or bq help --all for advanced commands.`;
const configHelp = `Usage: bq config [options]

Without options, show this project's settings. Changes preserve other settings.
  --model PROVIDER/MODEL     choose the pi model
  --check COMMAND            check proposed merges (empty string disables)
  --concurrency NUMBER       average concurrency for the entire queue; 0 pauses
  --global                   show/change defaults for new projects

Advanced:
  --image IMAGE              use a custom agent image
  --thinking LEVEL          off, minimal, low, medium, high, xhigh, max
  --pi-config PATH          source of pi credentials and model definitions
  --max-repairs NUMBER       automatic repair attempts
  --env NAME                 explicitly pass a host variable; repeatable; '' clears
  --cwd PATH                 select a project without changing directory
  --json                     structured output

Examples:
  bq config --check 'npm test'
  bq config --global --model anthropic/claude-sonnet-4-5`;

function options(args: string[], definitions: ParseArgsConfig['options'] = {}) {
  return parseArgs({ args, options: definitions, allowPositionals: true, strict: true });
}

function argumentCount(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new Error(`Usage: ${usage}`);
}

function print(value: unknown, text: string, json: unknown): void {
  console.log(json ? JSON.stringify(value, null, 2) : text);
}

function repoRoot(path: string): string {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('Run this command in a Git repository, or use --cwd PATH. For defaults, use bq config --global.');
  }
}

function branchAt(source: string): string {
  try {
    const branch = execFileSync('git', ['-C', source, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['-C', source, 'show-ref', '--verify', `refs/heads/${branch}`], { stdio: 'ignore' });
    return branch;
  } catch {
    throw new Error('Check out a branch with at least one commit before adding this project.');
  }
}

function number(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a nonnegative number`);
  return result;
}

function model(value: string): string {
  if (!/^[^/\s]+\/\S+$/.test(value)) throw new Error('Use a model in provider/model form');
  return value;
}

function piSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaults(store: Store, source?: string, changes: Partial<ProjectSettings> = {}) {
  const saved = { ...store.defaults(), ...changes };
  const piConfig = saved.piConfig ?? join(homedir(), '.pi/agent');
  const pi = { ...piSettings(join(piConfig, 'settings.json')), ...(source ? piSettings(join(source, '.pi/settings.json')) : {}) };
  const selected = saved.model ?? (pi.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : null);
  return {
    image: saved.image ?? DEFAULT_IMAGE,
    model: selected as string | null,
    thinking: saved.thinking ?? pi.modelThinkingLevels?.[selected] ?? pi.defaultThinkingLevel ?? 'medium',
    checkCommand: saved.checkCommand ?? null,
    env: saved.env ?? [],
    piConfig,
    maxRepairs: saved.maxRepairs ?? 3,
  };
}

async function project(store: Store, source: string, json: unknown, changes: Partial<ProjectSettings> = {}): Promise<Project> {
  const existing = store.projectFor(source);
  if (existing && !Object.keys(changes).length) return existing;
  const branch = existing?.branch ?? branchAt(source);
  const settings = existing ? { ...existing, ...changes } : defaults(store, source, changes);
  if (!settings.model) {
    if (json || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error('No model configured. Run bq config --global --model provider/model, or save a default model in pi.');
    }
    const input = createInterface({ input: process.stdin, output: process.stderr });
    try {
      settings.model = model((await input.question('Model (provider/model): ')).trim());
      store.setDefaults({ model: settings.model });
    } finally { input.close(); }
  }
  return store.register({ ...settings, model: model(settings.model), source, branch });
}

function status(store: Store, args: string[]): void {
  const parsed = options(args, { json: common.json });
  argumentCount(parsed.positionals, 0, 'bq [--json]');
  const projects = store.listProjects();
  const tasks = store.tasks();
  const current = store.concurrency();
  const concurrency = { target: current.target, balanceSeconds: current.balance / 1000, running: current.running };
  if (parsed.values.json) { print({ concurrency, projects, tasks }, '', true); return; }
  const active = tasks.filter(task => !['done', 'canceled'].includes(task.status));
  const recent = tasks.filter(task => ['done', 'canceled'].includes(task.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const visible = [...active, ...recent].slice(0, 20);
  const queued = active.filter(task => ['queued', 'integrating'].includes(task.status)).length;
  const blocked = active.filter(task => task.status === 'blocked');
  console.log(`Concurrency ${current.target}${current.target === 0 ? ' (paused)' : ''} · ${current.running} running · ${queued} queued · ${blocked.length} blocked`);
  if (!tasks.length) { console.log('\nQueue empty. Use bq run and bq add "task", in either order.'); return; }
  for (const entry of projects) {
    const rows = visible.filter(task => task.projectId === entry.id);
    if (!rows.length) continue;
    console.log(`\n${basename(entry.source)} · ${entry.branch}`);
    for (const task of rows) {
      const text = task.prompt.replace(/\s+/g, ' ');
      console.log(`${String(task.id).padEnd(4)} ${(labels[task.status] ?? task.status).padEnd(12)} ${text.length > 70 ? `${text.slice(0, 67)}…` : text}`);
    }
  }
  if (active.length > visible.length) console.log(`\n${active.length - visible.length} more active tasks. Use bq --json for the full queue.`);
  if (blocked.length) console.log(`\nUse bq show ${blocked[0].id} for details.`);
}

async function config(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, {
    ...common, global: { type: 'boolean' }, model: { type: 'string' }, thinking: { type: 'string' },
    check: { type: 'string' }, image: { type: 'string' }, concurrency: { type: 'string' },
    'pi-config': { type: 'string' }, 'max-repairs': { type: 'string' }, env: { type: 'string', multiple: true },
  });
  argumentCount(parsed.positionals, 0, 'bq config [options]');
  const values = parsed.values;
  const changes: Partial<ProjectSettings> = {};
  if (values.model !== undefined) changes.model = model(String(values.model));
  if (values.thinking !== undefined) {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(values.thinking))) throw new Error('Unknown thinking level');
    changes.thinking = String(values.thinking);
  }
  if (values.check !== undefined) changes.checkCommand = String(values.check) || null;
  if (values.image !== undefined) {
    if (!values.image) throw new Error('Image must not be empty');
    changes.image = String(values.image);
  }
  if (values['pi-config'] !== undefined) {
    const path = String(values['pi-config']);
    if (!path) throw new Error('Pi configuration path must not be empty');
    changes.piConfig = resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  }
  if (values['max-repairs'] !== undefined) {
    changes.maxRepairs = number(values['max-repairs'], 'Repair limit');
    if (!Number.isInteger(changes.maxRepairs)) throw new Error('Repair limit must be an integer');
  }
  if (values.env !== undefined) {
    const names = values.env as string[];
    changes.env = names.length === 1 && names[0] === '' ? [] : names;
    if (changes.env.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Use environment variable names, not NAME=value');
  }
  const target = values.concurrency === undefined ? undefined : number(values.concurrency, 'Concurrency');
  const onlyConcurrency = target !== undefined && Object.keys(changes).length === 0;
  let scope: string;
  let settings;
  let branch: string | undefined;
  if (values.global || onlyConcurrency) {
    scope = 'defaults';
    if (Object.keys(changes).length) store.setDefaults(changes);
    settings = defaults(store);
  } else {
    const source = repoRoot(String(values.cwd));
    scope = source;
    const existing = store.projectFor(source);
    if (Object.keys(changes).length) {
      const updated = await project(store, source, values.json, changes);
      settings = updated;
      branch = updated.branch;
    } else {
      settings = existing ?? defaults(store, source);
      branch = existing?.branch ?? branchAt(source);
    }
  }
  if (target !== undefined) store.setConcurrency(target);
  const concurrency = store.concurrency().target;
  const output = {
    scope, branch, concurrency, model: settings.model, thinking: settings.thinking,
    checkCommand: settings.checkCommand, image: settings.image, piConfig: settings.piConfig,
    env: settings.env, maxRepairs: settings.maxRepairs,
  };
  print(output, [
    scope === 'defaults' ? 'Defaults for new projects' : `${basename(scope)} · ${branch}`,
    `Model        ${settings.model ?? '(not set)'}`,
    `Checks       ${settings.checkCommand ?? '(none)'}`,
    `Concurrency  ${concurrency} (entire queue)`,
    `Thinking     ${settings.thinking}`,
    `Image        ${settings.image}`,
    `Pi config    ${settings.piConfig}`,
    `Environment  ${settings.env.join(', ') || '(none inherited)'}`,
    `Repairs      ${settings.maxRepairs}`,
  ].join('\n'), values.json);
  if (Object.keys(changes).length || target !== undefined) await notify(store.stateDir);
}

async function taskCommand(store: Store, command: string, args: string[]): Promise<void> {
  const parsed = options(args, { json: common.json });
  argumentCount(parsed.positionals, 1, `bq ${command} ID [--json]`);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Task ID must be a positive integer');
  if (command === 'cancel' || command === 'retry') {
    if (command === 'cancel') store.cancel(id); else store.retry(id);
    await notify(store.stateDir);
    print(store.task(id), `${command === 'cancel' ? 'Canceled' : 'Queued to resume'} #${id}.`, parsed.values.json);
    return;
  }
  const task = store.task(id);
  const project = store.project(task.projectId);
  const runs = store.runs(id);
  if (parsed.values.json) { print({ ...task, project, runs }, '', true); return; }
  console.log(`#${id} · ${labels[task.status] ?? task.status} · ${basename(project.source)} (${project.branch})\n\n${task.prompt}`);
  if (task.error) console.log(`\nReason: ${task.error}`);
  if (task.status === 'checking') console.log(`\nCheck: ${project.checkCommand}`);
  const agent = runs.findLast(run => run.kind === 'agent');
  if (agent) {
    const log = join(task.stateDir, `run-${agent.name}.stdout.log`);
    let activity = '';
    if (existsSync(log)) {
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'tool_execution_start') activity = `Using ${event.toolName}`;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const text = event.message.content?.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
          if (text) activity = text;
        }
      }
    }
    if (activity) console.log(`\n${activity.length > 600 ? `${activity.slice(0, 597)}…` : activity}`);
  }
  if (task.result) {
    const integration = "'" + project.integration.replaceAll("'", "'\\''") + "'";
    console.log(`\nIntegrated: ${task.result}\nFrom your project: git fetch ${integration} bq-integration && git merge FETCH_HEAD`);
  }
  if (existsSync(task.workspace)) console.log(`\nWorkspace: ${task.workspace}`);
  if (runs.length) console.log(`Logs: ${task.stateDir}`);
  if (task.status === 'blocked') console.log(`\nUse bq retry ${id} to try again.`);
}

async function run(store: Store, args: string[]): Promise<void> {
  const parsed = options(args, { concurrency: { type: 'string' }, locked: { type: 'boolean' } });
  argumentCount(parsed.positionals, 0, 'bq run [--concurrency NUMBER]');
  const target = parsed.values.concurrency === undefined ? undefined : number(parsed.values.concurrency, 'Concurrency');
  if (parsed.values.locked) {
    if (target !== undefined) store.setConcurrency(target);
    console.log(`Processing the entire queue · concurrency ${store.concurrency().target}\nCtrl+C stops the runner; running containers are left intact.`);
    await work(store);
    return;
  }
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '75', `${store.stateDir}/worker.lock`, process.execPath, program, 'run', '--locked', ...(target === undefined ? [] : ['--concurrency', String(target)])], { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const cleanup = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolveRun();
      else reject(new Error(code === 75 ? 'Another bq run is already processing this queue.' : `Runner exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const args = command ? argv.slice(1) : argv;
  const flags = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  if (command === 'help' || (command !== 'podman' && (flags.includes('--help') || flags.includes('-h')))) {
    if (command === 'config' || (command === 'help' && args.includes('config'))) console.log(configHelp);
    else {
      console.log(usage);
      if (flags.includes('--all')) console.log('\nAdvanced:\n  bq sync [--cwd PATH]       fetch and integrate upstream changes\n  bq build [--tag IMAGE]     explicitly rebuild an image\n  bq podman ARGS...          inspect/control bq\'s private Podman store\n\nadd, config, and sync accept --cwd PATH.');
    }
    return;
  }
  if (!['', 'add', 'run', 'show', 'cancel', 'retry', 'config', 'sync', 'build', 'podman'].includes(command)) {
    throw new Error(`Unknown command: ${command}. Use bq --help.`);
  }
  const store = new Store();
  try {
    switch (command) {
      case '': status(store, args); break;
      case 'add': {
        const parsed = options(args, common);
        const prompt = parsed.positionals.join(' ').trim();
        if (!prompt) throw new Error('Usage: bq add "task"');
        const entry = await project(store, repoRoot(String(parsed.values.cwd)), parsed.values.json);
        const task = store.add(entry.id, prompt);
        print(task, `Queued #${task.id} · ${basename(entry.source)}\n${prompt}`, parsed.values.json);
        await notify(store.stateDir);
        break;
      }
      case 'show': case 'cancel': case 'retry': await taskCommand(store, command, args); break;
      case 'config': await config(store, args); break;
      case 'run': await run(store, args); break;
      case 'sync': {
        const parsed = options(args, common);
        argumentCount(parsed.positionals, 0, 'bq sync [--cwd PATH]');
        const source = repoRoot(String(parsed.values.cwd));
        const entry = store.projectFor(source);
        if (!entry) throw new Error('No project here yet. Use bq add "task" first.');
        store.requestSync(entry.id);
        await notify(store.stateDir);
        print({ projectId: entry.id, status: 'queued' }, `Queued upstream sync · ${basename(source)}`, parsed.values.json);
        break;
      }
      case 'build': {
        const parsed = options(args, { tag: { type: 'string', default: DEFAULT_IMAGE } });
        argumentCount(parsed.positionals, 0, 'bq build [--tag IMAGE]');
        await buildImage(store.dataDir, String(parsed.values.tag));
        break;
      }
      case 'podman': execFileSync(process.env.BQ_PODMAN || 'podman', [...podmanArgs(store.dataDir), ...args], { env: podmanEnv(), stdio: 'inherit' }); break;
    }
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
