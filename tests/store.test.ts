import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'bq-store-'));
  const store = new Store({ dataDir: join(root, 'data'), stateDir: join(root, 'state') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.register({ source: '/project', branch: 'main', image: 'test', model: 'test/model', thinking: 'medium', checkCommand: null, env: [], piConfig: '/pi', maxRepairs: 3 });
  return { store, project };
}

test('project registration updates config without changing upstream history', t => {
  const { store, project } = fixture(t);
  assert.equal(store.projectFor('/project').id, project.id);
  assert.throws(() => store.register({ ...project, branch: 'other' }), /different upstream/);
  assert.equal(store.register({ ...project, model: 'other/model' }).model, 'other/model');
});

test('task state persists; cancellation does not stop unrelated runs', t => {
  const { store, project } = fixture(t);
  const task = store.add(project.id, 'Make it work');
  const second = store.add(project.id, 'Another task');
  const run = store.startRun(task, 'agent');
  store.cancel(task.id);
  assert.equal(store.task(task.id).status, 'canceled');
  assert.equal(store.task(second.id).status, 'queued');
  assert.throws(() => store.retry(task.id), /stop/);
  store.finishRun(run, 143, null);
  store.retry(task.id);
  assert.equal(store.task(task.id).status, 'queued');
  assert.equal(store.runs(task.id).length, 1);
});

test('cancellation cannot interrupt the final publication step', t => {
  const { store, project } = fixture(t);
  const task = store.add(project.id, 'Work');
  store.updateTask(task.id, { status: 'publishing' });
  assert.throws(() => store.cancel(task.id), /publishing/);
  assert.equal(store.task(task.id).status, 'publishing');
});

test('upstream synchronization is deduplicated even when blocked', t => {
  const { store, project } = fixture(t);
  const sync = store.add(project.id, 'Resolve upstream', 'abc');
  store.updateTask(sync.id, { status: 'blocked' });
  assert.throws(() => store.add(project.id, 'Duplicate', 'def'), /UNIQUE/);
  store.updateTask(sync.id, { status: 'done' });
  assert.equal(store.add(project.id, 'Next upstream', 'def').kind, 'upstream');
});

test('runtime debt and concurrency survive reopening', t => {
  const { store, project } = fixture(t);
  store.setConcurrency(0.2);
  const task = store.add(project.id, 'Work');
  const run = store.startRun(task, 'agent');
  const start = 1_000_000;
  store.db.prepare('UPDATE scheduling SET balance=0,accountedAt=?,totalUsage=0').run(start);
  store.db.prepare('UPDATE runs SET startedAt=?,finishedAt=? WHERE id=?').run(start, start + 600_000, run.id);
  assert.equal(store.account(start + 600_000).balance, -480_000);
  const reopened = new Store({ dataDir: store.dataDir, stateDir: store.stateDir });
  assert.equal(reopened.account(start + 3_000_000).balance, 0);
  assert.equal(reopened.task(task.id).status, 'running');
  reopened.close();
});

test('invalid target is rejected; zero pauses admission', t => {
  const { store } = fixture(t);
  for (const target of [-1, NaN, Infinity]) assert.throws(() => store.setConcurrency(target));
  store.setConcurrency(0);
  assert.equal(store.concurrency().target, 0);
});
