import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { accrue } from './policy.ts';

export interface Project {
  id: number;
  source: string;
  branch: string;
  integration: string;
  image: string;
  model: string;
  thinking: string;
  checkCommand: string | null;
  env: string[];
  piConfig: string;
  maxRepairs: number;
  syncRequested: number;
}

export interface Task {
  id: number;
  projectId: number;
  kind: 'work' | 'upstream';
  prompt: string;
  nextPrompt: string | null;
  status: 'queued' | 'running' | 'integrating' | 'checking' | 'publishing' | 'blocked' | 'done' | 'canceled';
  workspace: string;
  stateDir: string;
  base: string | null;
  ignored: string[];
  untracked: string[];
  upstreamOid: string | null;
  repairs: number;
  candidateHead: string | null;
  candidateBase: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: number;
  taskId: number;
  kind: 'agent' | 'check';
  name: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

type Registration = Omit<Project, 'id' | 'integration' | 'syncRequested'>;

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly stateDir: string;

  constructor(options: { dataDir?: string; stateDir?: string } = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.BQ_DATA_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'bq'));
    this.stateDir = resolve(options.stateDir ?? process.env.BQ_STATE_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'bq'));
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.stateDir, 'queue.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL UNIQUE, branch TEXT NOT NULL,
        integration TEXT NOT NULL, image TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT NOT NULL,
        checkCommand TEXT, env TEXT NOT NULL, piConfig TEXT NOT NULL, maxRepairs INTEGER NOT NULL,
        syncRequested INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, projectId INTEGER NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL DEFAULT 'work', prompt TEXT NOT NULL, nextPrompt TEXT,
        status TEXT NOT NULL DEFAULT 'queued', workspace TEXT NOT NULL DEFAULT '', stateDir TEXT NOT NULL DEFAULT '',
        base TEXT, ignored TEXT NOT NULL DEFAULT '[]', untracked TEXT NOT NULL DEFAULT '[]', upstreamOid TEXT,
        repairs INTEGER NOT NULL DEFAULT 0, candidateHead TEXT, candidateBase TEXT,
        result TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_upstream ON tasks(projectId)
        WHERE kind = 'upstream' AND status NOT IN ('done', 'canceled');
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, taskId INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE, startedAt INTEGER NOT NULL, finishedAt INTEGER, exitCode INTEGER, error TEXT
      );
      CREATE TABLE IF NOT EXISTS scheduling (
        id INTEGER PRIMARY KEY CHECK(id = 1), target REAL NOT NULL, balance REAL NOT NULL,
        accountedAt INTEGER NOT NULL, totalUsage REAL NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO scheduling VALUES (1, 1, 0, ?, 0)').run(Date.now());
  }

  register(input: Registration): Project {
    const existing = this.db.prepare('SELECT * FROM projects WHERE source = ?').get(input.source);
    if (existing) {
      if (existing.branch !== input.branch) throw new Error('Project is already registered with a different upstream branch');
      this.db.prepare(`UPDATE projects SET image=?, model=?, thinking=?, checkCommand=?, env=?, piConfig=?, maxRepairs=?, syncRequested=1 WHERE id=?`)
        .run(input.image, input.model, input.thinking, input.checkCommand, JSON.stringify(input.env), input.piConfig, input.maxRepairs, existing.id);
      return this.project(Number(existing.id));
    }
    const suffix = createHash('sha256').update(input.source).digest('hex').slice(0, 12);
    const integration = join(this.dataDir, 'integrations', `${basename(input.source)}-${suffix}`);
    const row = this.db.prepare(`INSERT INTO projects (source,branch,integration,image,model,thinking,checkCommand,env,piConfig,maxRepairs) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(input.source, input.branch, integration, input.image, input.model, input.thinking, input.checkCommand, JSON.stringify(input.env), input.piConfig, input.maxRepairs);
    return this.project(Number(row.lastInsertRowid));
  }

  project(id: number): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new Error(`No project ${id}`);
    return { ...row, env: JSON.parse(String(row.env)) } as unknown as Project;
  }

  projectFor(source: string): Project {
    const row = this.db.prepare('SELECT id FROM projects WHERE source=?').get(source);
    if (!row) throw new Error('Project is not registered; run bq init first');
    return this.project(Number(row.id));
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT id FROM projects ORDER BY id').all().map(row => this.project(Number(row.id)));
  }

  add(projectId: number, prompt: string, upstreamOid: string | null = null): Task {
    const now = Date.now();
    const row = this.db.prepare('INSERT INTO tasks (projectId,kind,prompt,status,upstreamOid,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(projectId, upstreamOid ? 'upstream' : 'work', prompt, upstreamOid ? 'integrating' : 'queued', upstreamOid, now, now);
    const id = Number(row.lastInsertRowid);
    this.db.prepare('UPDATE tasks SET workspace=?,stateDir=? WHERE id=?')
      .run(join(this.dataDir, 'tasks', String(id), 'work'), join(this.stateDir, 'tasks', String(id)), id);
    return this.task(id);
  }

  task(id: number): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error(`No task ${id}`);
    return { ...row, ignored: JSON.parse(String(row.ignored)), untracked: JSON.parse(String(row.untracked)) } as unknown as Task;
  }

  tasks(): Task[] {
    return this.db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row => this.task(Number(row.id)));
  }

  updateTask(id: number, fields: Partial<Omit<Task, 'id'>>): void {
    const entries = Object.entries({ ...fields, updatedAt: Date.now() });
    this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([, value]) => Array.isArray(value) ? JSON.stringify(value) : value as string | number | null), id);
  }

  cancel(id: number): void {
    const result = this.db.prepare("UPDATE tasks SET status='canceled',updatedAt=? WHERE id=? AND status NOT IN ('done','canceled','publishing')").run(Date.now(), id);
    if (!result.changes) throw new Error(`Task ${id} is ${this.task(id).status}`);
  }

  retry(id: number): void {
    const task = this.task(id);
    if (!['blocked', 'canceled'].includes(task.status)) throw new Error(`Task ${id} is ${task.status}`);
    if (this.activeRuns().some(run => run.taskId === id)) throw new Error('Wait for the canceled container to stop before retrying');
    this.updateTask(id, {
      status: task.kind === 'upstream' && !task.base ? 'integrating' : 'queued',
      repairs: 0,
      error: null,
      nextPrompt: task.nextPrompt ?? (task.base ? `Continue the task and finish any incomplete work:\n${task.prompt}` : null),
    });
  }

  requestSync(projectId: number): void {
    this.db.prepare('UPDATE projects SET syncRequested=1 WHERE id=?').run(projectId);
  }

  activeRuns(): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE finishedAt IS NULL ORDER BY id').all() as unknown as Run[];
  }

  runs(taskId: number): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE taskId=? ORDER BY id').all(taskId) as unknown as Run[];
  }

  startRun(task: Task, kind: Run['kind']): Run {
    this.account();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.task(task.id).status === 'canceled') throw new Error('Task was canceled');
      const row = this.db.prepare('INSERT INTO runs (taskId,kind,name,startedAt) VALUES (?,?,?,?)')
        .run(task.id, kind, `pending-${task.id}`, Date.now());
      const id = Number(row.lastInsertRowid);
      const namespace = createHash('sha256').update(this.stateDir).digest('hex').slice(0, 10);
      const name = `bq-${namespace}-${id}`;
      this.db.prepare('UPDATE runs SET name=? WHERE id=?').run(name, id);
      this.updateTask(task.id, { status: kind === 'agent' ? 'running' : 'checking' });
      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishRun(run: Run, exitCode: number, error: string | null, startedAt?: number | null, finishedAt?: number | null): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE runs SET startedAt=?,finishedAt=?,exitCode=?,error=? WHERE id=?')
        .run(startedAt ?? run.startedAt, finishedAt ?? Date.now(), exitCode, error, run.id);
      if (this.task(run.taskId).status !== 'canceled') this.updateTask(run.taskId, { status: 'integrating' });
      this.db.exec('COMMIT');
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
    this.account();
  }

  account(now = Date.now()): { target: number; balance: number; running: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const settings = this.db.prepare('SELECT * FROM scheduling WHERE id=1').get()!;
      const usage = Number(this.db.prepare('SELECT COALESCE(SUM(MAX(0, MIN(COALESCE(finishedAt, ?), ?) - startedAt)), 0) AS usage FROM runs').get(now, now)!.usage);
      const target = Number(settings.target);
      const balance = accrue(Number(settings.balance), target, Math.max(0, now - Number(settings.accountedAt)), usage - Number(settings.totalUsage));
      this.db.prepare('UPDATE scheduling SET balance=?,accountedAt=?,totalUsage=? WHERE id=1').run(balance, now, usage);
      const running = Number(this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE finishedAt IS NULL').get()!.n);
      this.db.exec('COMMIT');
      return { target, balance, running };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setConcurrency(target: number): void {
    if (!Number.isFinite(target) || target < 0) throw new Error('Concurrency must be a finite nonnegative number');
    this.account();
    this.db.prepare('UPDATE scheduling SET target=?,balance=MIN(balance,?) WHERE id=1').run(target, target * 60_000);
  }

  concurrency(): { target: number; balance: number; running: number } {
    return this.account();
  }

  close(): void {
    this.db.close();
  }
}
