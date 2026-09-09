import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.ts';
import { work, notify } from '../src/worker.ts';

const exec = promisify(execFile);
const fakePodman = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
while (['--root', '--runroot', '--tmpdir'].includes(args[0])) args.splice(0, 2);
const root = process.env.FAKE_PODMAN_STATE;
const file = name => path.join(root, name + '.json');
const load = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const save = (name, state) => fs.writeFileSync(file(name), JSON.stringify(state));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const op = args[0];
  if (op === 'image' && args[1] === 'exists') return;
  if (op === 'inspect') {
    const name = args.at(-1);
    if (!fs.existsSync(file(name))) { console.error('no such container'); process.exitCode=1; return; }
    console.log(JSON.stringify([{State:load(name)}])); return;
  }
  if (op === 'rm') { fs.rmSync(file(args.at(-1)), {force:true}); return; }
  if (op === 'stop') {
    const name = args.at(-1), state = load(name);
    if (state.Status === 'running') { try { process.kill(state.Pid, 'SIGTERM'); } catch {} }
    return;
  }
  if (op === 'wait') {
    for (;;) {
      const state = load(args[1]);
      if (state.Status === 'exited') { console.log(state.ExitCode); return; }
      await pause(10);
    }
  }
  if (op === 'logs') return;
  if (op !== 'run') throw new Error('Unexpected podman command: ' + args.join(' '));
  const name = args[args.indexOf('--name') + 1];
  const volumes = args.flatMap((a,i) => a === '--volume' ? [args[i+1]] : []);
  const workspace = volumes.find(v=>v.includes(':/work:')).split(':/work:')[0];
  const stateDir = volumes.find(v=>v.includes(':/bq:')).split(':/bq:')[0];
  const git = (...a) => cp.execFileSync('git', ['-C', workspace, ...a], {encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const state = {Status:'running', StartedAt:new Date().toISOString(), FinishedAt:'0001-01-01T00:00:00Z', ExitCode:0, Pid:process.pid};
  save(name,state);
  const finish = code => { state.Status='exited'; state.ExitCode=code; state.FinishedAt=new Date().toISOString(); save(name,state); };
  process.on('SIGTERM',()=>{finish(143);process.exit(143);});
  const prompt = args.at(-1);
  await pause(prompt.includes('slow') ? 500 : 30);
  let code = 0;
  if (args.includes('/bin/sh')) {
    const result = cp.spawnSync('/bin/sh',['-c',prompt],{cwd:workspace,encoding:'utf8'});
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    code=result.status ?? 1;
  } else {
    fs.appendFileSync(path.join(stateDir,'session.jsonl'), JSON.stringify({prompt})+'\\n');
    const apiError = prompt.includes('API failure');
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:apiError?'error':'stop',errorMessage:apiError?'Connection error.':undefined}}));
    if (!prompt.includes('no changes') && !apiError) {
      const upstream = prompt.match(/Also merge upstream revision ([0-9a-f]+)/);
      if (upstream) {
        try { git('merge','--no-edit',upstream[1]); } catch {
          for (const conflict of git('diff','--name-only','--diff-filter=U').trim().split('\\n').filter(Boolean)) {
            fs.writeFileSync(path.join(workspace,conflict),'resolved upstream and integration\\n');
          }
        }
      } else {
        const filename = prompt.match(/file:([a-z.]+)/)?.[1] || 'result.txt';
        fs.writeFileSync(path.join(workspace,filename),'task result\\n');
      }
      const dirty = path.join(stateDir,'dirty-once');
      if (prompt.includes('leave dirty') && !fs.existsSync(dirty)) fs.writeFileSync(dirty,'1');
      else {
        git('add','-A');
        if (git('status','--porcelain').trim()) git('-c','user.name=Test','-c','user.email=test@example.com','commit','-m','task result');
      }
    }
  }
  finish(code); process.exitCode=code;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`;

async function until(predicate: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for worker state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, checkCommand: string | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'bq-worker-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', '-b', 'main', source]);
  await exec('git', ['-C', source, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(source, 'shared.txt'), 'initial\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-m', 'initial']);
  const podman = join(root, 'podman');
  await writeFile(podman, fakePodman, { mode: 0o755 });
  const previous = { BQ_PODMAN: process.env.BQ_PODMAN, FAKE_PODMAN_STATE: process.env.FAKE_PODMAN_STATE };
  process.env.BQ_PODMAN = podman;
  process.env.FAKE_PODMAN_STATE = join(root, 'containers');
  await mkdir(process.env.FAKE_PODMAN_STATE);
  const store = new Store({ dataDir: join(root, 'data'), stateDir: join(root, 'state') });
  const project = store.register({ source, branch: 'main', image: 'test', model: 'test/model', thinking: 'medium', env: [], piConfig: join(root, 'pi'), checkCommand, maxRepairs: 2 });
  let controller = new AbortController();
  let worker: Promise<void> | undefined;
  const start = () => {
    if (controller.signal.aborted) controller = new AbortController();
    return worker = work(store, { signal: controller.signal });
  };
  t.after(async () => {
    controller.abort();
    await worker;
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { store, project, start, get controller() { return controller; }, root };
}

test('agent changes are committed, checked, integrated, and cleaned up', async t => {
  const { store, project, start } = await fixture(t, 'test -f result.txt');
  const task = store.add(project.id, 'write a result');
  start();
  await until(() => ['done', 'blocked'].includes(store.task(task.id).status));
  assert.equal(store.task(task.id).status, 'done', store.task(task.id).error ?? '');
  assert.deepEqual(store.runs(task.id).map(run => run.kind), ['agent', 'check']);
  const { stdout } = await exec('git', ['-C', project.integration, 'show', 'bq-integration:result.txt']);
  assert.equal(stdout, 'task result\n');
  assert.equal(await readFile(join(project.source, 'shared.txt'), 'utf8'), 'initial\n');
  await assert.rejects(readFile(join(project.source, 'result.txt')));
  assert.ok((await readFile(join(task.stateDir, 'session.jsonl'), 'utf8')).includes('write a result'));
});

test('a pi API failure is blocked even if its process exits zero', async t => {
  const { store, project, start } = await fixture(t);
  const task = store.add(project.id, 'API failure');
  start();
  await until(() => ['done', 'blocked'].includes(store.task(task.id).status));
  assert.equal(store.task(task.id).status, 'blocked');
  assert.match(store.task(task.id).error!, /Connection error/);
});

test('dirty completion resumes the same task instead of claiming success', async t => {
  const { store, project, start } = await fixture(t);
  const task = store.add(project.id, 'leave dirty');
  start();
  await until(() => ['done', 'blocked'].includes(store.task(task.id).status));
  assert.equal(store.task(task.id).status, 'done', store.task(task.id).error ?? '');
  assert.equal(store.runs(task.id).length, 2);
  assert.equal(store.task(task.id).repairs, 1);
  assert.equal((await readFile(join(task.stateDir, 'session.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('failed checks exhaust repair attempts and retain the workspace', async t => {
  const { store, project, start } = await fixture(t, 'exit 1');
  const task = store.add(project.id, 'write a result');
  start();
  await until(() => store.task(task.id).status === 'blocked');
  assert.equal(store.task(task.id).repairs, 2);
  assert.match(store.task(task.id).error!, /repair limit/);
  assert.equal(await readFile(join(task.workspace, 'result.txt'), 'utf8'), 'task result\n');
  await assert.rejects(exec('git', ['-C', project.integration, 'show', 'bq-integration:result.txt']));
});

test('explicit cancellation stops its running container', async t => {
  const { store, project, start } = await fixture(t);
  const task = store.add(project.id, 'slow task');
  start();
  await until(() => store.task(task.id).status === 'running');
  await new Promise(resolve => setTimeout(resolve, 100));
  store.cancel(task.id);
  await notify(store.stateDir);
  await until(() => store.activeRuns().length === 0);
  assert.equal(store.task(task.id).status, 'canceled');
  assert.notEqual(store.runs(task.id)[0].exitCode, 0);
});


test('coordinator restart recovers a running container without launching another agent', async t => {
  const f = await fixture(t);
  const task = f.store.add(f.project.id, 'slow task');
  const firstWorker = f.start();
  await until(() => f.store.task(task.id).status === 'running');
  await new Promise(resolve => setTimeout(resolve, 100));
  f.controller.abort();
  await firstWorker;
  assert.equal(f.store.activeRuns().length, 1);
  f.start();
  await until(() => ['done', 'blocked'].includes(f.store.task(task.id).status));
  assert.equal(f.store.task(task.id).status, 'done', f.store.task(task.id).error ?? '');
  assert.equal(f.store.runs(task.id).length, 1);
});

test('parallel candidates are rechecked after integration advances without charging a repair', async t => {
  const { store, project, start } = await fixture(t, 'sleep 0.5; test -f shared.txt');
  store.setConcurrency(2);
  const first = store.add(project.id, 'write file:first.txt');
  const second = store.add(project.id, 'write file:second.txt');
  start();
  await until(() => [first, second].every(task => ['done', 'blocked'].includes(store.task(task.id).status)));
  for (const task of [first, second]) {
    assert.equal(store.task(task.id).status, 'done', store.task(task.id).error ?? '');
    assert.equal(store.task(task.id).repairs, 0);
  }
  assert.ok([first, second].some(task => store.runs(task.id).filter(run => run.kind === 'check').length > 1));
  for (const filename of ['first.txt', 'second.txt']) {
    await exec('git', ['-C', project.integration, 'show', `bq-integration:${filename}`]);
  }
});

test('upstream conflict creates one resolver and preserves both histories', async t => {
  const { store, project, start } = await fixture(t);
  const task = store.add(project.id, 'write a result');
  start();
  await until(() => store.task(task.id).status === 'done');
  const previousIntegration = store.task(task.id).result!;
  await writeFile(join(project.source, 'result.txt'), 'upstream result\n');
  await exec('git', ['-C', project.source, 'add', '.']);
  await exec('git', ['-C', project.source, 'commit', '-m', 'upstream result']);
  const upstream = (await exec('git', ['-C', project.source, 'rev-parse', 'HEAD'])).stdout.trim();
  store.requestSync(project.id);
  await notify(store.stateDir);
  await until(() => store.tasks().some(task => task.kind === 'upstream' && ['done', 'blocked'].includes(task.status)));
  const syncs = store.tasks().filter(task => task.kind === 'upstream');
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].status, 'done', syncs[0].error ?? '');
  assert.equal(store.runs(syncs[0].id).length, 1);
  for (const ancestor of [previousIntegration, upstream]) {
    await exec('git', ['-C', project.integration, 'merge-base', '--is-ancestor', ancestor, 'bq-integration']);
  }
  const content = (await exec('git', ['-C', project.integration, 'show', 'bq-integration:result.txt'])).stdout;
  assert.equal(content, 'resolved upstream and integration\n');
});
