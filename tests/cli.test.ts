import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture(t: { after: (fn: () => void) => void }) {
  const temp = mkdtempSync(join('/tmp', 'bq-cli-'));
  const repo = join(temp, 'project');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'README'), 'project\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  const env = {
    ...process.env,
    HOME: join(temp, 'home'),
    BQ_DATA_HOME: join(temp, 'data'),
    BQ_STATE_HOME: join(temp, 'state'),
  };
  mkdirSync(env.HOME, { recursive: true });
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, repo, env };
}

function run(cli: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd: env.HOME, env, encoding: 'utf8', timeout: 5000 });
}

function fail(cli: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: env.HOME, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

function packaged(t: { after: (fn: () => void) => void }): string {
  const temp = mkdtempSync(join('/tmp', 'bq-package-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'ignore' });
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }).trim();
  const install = join(temp, 'install');
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', install, join(temp, archive)], { cwd: root, stdio: 'ignore' });
  return join(install, 'node_modules', 'bq', 'dist', 'cli.js');
}

test('bare status needs no project and help does not create state', t => {
  const { env } = fixture(t);
  const cli = packaged(t);
  assert.match(run(cli, env, '--help'), /bq add/);
  assert.match(run(cli, env, 'help', '--all'), /bq sync/);
  assert.equal(existsSync(join(env.BQ_STATE_HOME!, 'queue.sqlite')), false);
  const status = JSON.parse(run(cli, env, '--json'));
  assert.equal(status.concurrency.target, 1);
  assert.equal(status.concurrency.running, 0);
  assert.ok(status.concurrency.balanceSeconds >= 0 && status.concurrency.balanceSeconds <= 60);
  assert.deepEqual(status.projects, []);
  assert.deepEqual(status.tasks, []);
  assert.equal(existsSync(join(env.BQ_STATE_HOME!, 'queue.sqlite')), true);
});

test('add auto-registers the current branch and returns useful human or JSON output', t => {
  const { repo, env } = fixture(t);
  const cli = packaged(t);
  assert.match(fail(cli, env, 'add', '--cwd', repo, '--json', 'missing model'), /No model configured.*bq config --global --model/);
  assert.deepEqual(JSON.parse(run(cli, env, '--json')).projects, []);
  const settings = join(env.HOME!, '.pi', 'agent');
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, 'settings.json'), JSON.stringify({ defaultProvider: 'test', defaultModel: 'model', defaultThinkingLevel: 'low' }));
  const human = run(cli, env, 'add', '--cwd', repo, 'fix login');
  assert.match(human, /Queued #1/);
  const task = JSON.parse(run(cli, env, 'add', '--cwd', repo, '--json', 'fix tests'));
  assert.equal(task.id, 2);
  const registered = JSON.parse(run(cli, env, '--json')).projects[0];
  assert.equal(registered.branch, 'main');
  assert.equal(registered.model, 'test/model');
  assert.equal(registered.thinking, 'low');
  assert.match(run(cli, env), /project · main[\s\S]*queued[\s\S]*fix login/);
  assert.match(run(cli, env, 'show', '1'), /#1[\s\S]*fix login/);
  run(cli, env, 'cancel', '2');
  assert.equal(JSON.parse(run(cli, env, 'show', '2', '--json')).status, 'canceled');
  assert.equal(JSON.parse(run(cli, env, 'retry', '2', '--json')).status, 'queued');
  git(repo, 'checkout', '--detach');
  const remembered = JSON.parse(run(cli, env, 'add', '--cwd', repo, '--json', 'after checkout change'));
  assert.equal(remembered.id, 3);
  assert.equal(JSON.parse(run(cli, env, '--json')).projects[0].branch, 'main');
});

test('global and project config preserve unrelated settings', t => {
  const { repo, env } = fixture(t);
  const cli = packaged(t);
  run(cli, env, 'config', '--global', '--model', 'test/model', '--thinking', 'high', '--max-repairs', '5', '--env', 'HOME');
  const defaults = JSON.parse(run(cli, env, 'config', '--global', '--json'));
  assert.equal(defaults.model, 'test/model');
  assert.equal(defaults.thinking, 'high');
  assert.deepEqual(defaults.env, ['HOME']);
  run(cli, env, 'add', '--cwd', repo, 'first');
  run(cli, env, 'config', '--cwd', repo, '--check', 'npm test', '--image', 'custom:image');
  const config = JSON.parse(run(cli, env, 'config', '--cwd', repo, '--json'));
  assert.equal(config.checkCommand, 'npm test');
  assert.equal(config.image, 'custom:image');
  assert.equal(config.model, 'test/model');
  assert.equal(config.thinking, 'high');
  assert.equal(config.maxRepairs, 5);
  assert.deepEqual(config.env, ['HOME']);
  run(cli, env, 'config', '--global', '--model', 'other/model');
  assert.equal(JSON.parse(run(cli, env, 'config', '--cwd', repo, '--json')).model, 'test/model');
  assert.equal(JSON.parse(run(cli, env, 'config', '--concurrency', '0.2', '--json')).concurrency, 0.2);
  run(cli, env, 'config', '--cwd', repo, '--check', '', '--env', '');
  const cleared = JSON.parse(run(cli, env, 'config', '--cwd', repo, '--json'));
  assert.equal(cleared.checkCommand, null);
  assert.deepEqual(cleared.env, []);
});

test('run is independent of projects and concurrency zero pauses work', async t => {
  const { repo, env } = fixture(t);
  const cli = packaged(t);
  const runner = spawn(process.execPath, [cli, 'run', '--concurrency', '0'], { cwd: env.HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number>(resolve => runner.once('exit', code => resolve(code ?? 1)));
  const socket = join(env.BQ_STATE_HOME!, 'worker.sock');
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(socket), true);
    assert.match(fail(cli, env, 'run', '--concurrency', '9'), /already processing/);
    assert.equal(JSON.parse(run(cli, env, '--json')).concurrency.target, 0);
    run(cli, env, 'config', '--global', '--model', 'test/model');
    const task = JSON.parse(run(cli, env, 'add', '--cwd', repo, '--json', 'queued while paused'));
    const wakeDeadline = Date.now() + 5000;
    let status;
    do {
      await new Promise(resolve => setTimeout(resolve, 20));
      status = JSON.parse(run(cli, env, '--json'));
    } while (status.projects[0]?.syncRequested !== 0 && Date.now() < wakeDeadline);
    assert.equal(status.projects[0].syncRequested, 0, 'add must wake the already-running process');
    assert.equal(JSON.parse(run(cli, env, 'show', String(task.id), '--json')).status, 'queued');
  } finally {
    runner.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
  assert.equal(existsSync(socket), false);
});

test('removed old commands are rejected', t => {
  const { env } = fixture(t);
  const cli = packaged(t);
  for (const command of ['init', 'worker', 'list', 'concurrency']) assert.match(fail(cli, env, command), /Unknown command/);
});
