import { createConnection, createServer } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Store, type Project, type Task, type Run } from './store.ts';
import { canStart, nextAdmission } from './policy.ts';
import {
  initializeProject, fetchUpstream, integrationHead, createWorkspace, prepareCandidate,
  prepareUpstream, publishCandidate, updateTaskIntegration, fetchUpstreamIntoWorkspace, git,
} from './git.ts';
import { startAgent, startCheck, inspectContainer, removeContainer, stopContainer, waitContainer } from './container.ts';

export async function notify(stateDir: string): Promise<void> {
  await new Promise<void>(resolve => {
    const socket = createConnection(join(stateDir, 'worker.sock'));
    socket.on('connect', () => socket.end('wake'));
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
  });
}

export async function work(store: Store, options: { signal?: AbortSignal } = {}): Promise<void> {
  const socketPath = join(store.stateDir, 'worker.sock');
  await rm(socketPath, { force: true });
  let pending = true;
  let stopping = false;
  let resume: (() => void) | undefined;
  const wake = () => {
    pending = true;
    resume?.();
  };
  const stop = () => { stopping = true; wake(); };
  const server = createServer(socket => {
    socket.on('data', wake);
    socket.on('error', () => {});
    socket.end();
    wake();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();

  const completions: { run: Run; exitCode: number; error?: string }[] = [];
  const stoppingRuns = new Set<number>();
  const watch = (run: Run, done: Promise<{ exitCode: number; error?: string }>) => {
    void done.then(result => { completions.push({ run, ...result }); wake(); }, error => {
      completions.push({ run, exitCode: -1, error: String(error) });
      wake();
    });
  };
  const candidatePath = (task: Task) => join(dirname(task.workspace), 'candidate');
  const blocked = (task: Task, error: unknown) => {
    if (!['done', 'canceled'].includes(store.task(task.id).status)) store.updateTask(task.id, { status: 'blocked', error: String(error) });
    console.error(`Task ${task.id}: ${error}`);
  };

  const synchronize = async (project: Project) => {
    store.db.prepare('UPDATE projects SET syncRequested=0 WHERE id=?').run(project.id);
    await initializeProject(project);
    const upstream = await fetchUpstream(project);
    if (Number(await git(project.integration, ['rev-list', '--count', `refs/heads/bq-integration..${upstream}`])) === 0) return;
    if (store.tasks().some(task => task.projectId === project.id && task.kind === 'upstream' && !['done', 'canceled'].includes(task.status))) return;
    const task = store.add(project.id, `Integrate upstream ${project.branch} at ${upstream}. Preserve both upstream changes and accepted task work.`, upstream);
    console.log(`Task ${task.id}: upstream synchronization queued`);
    wake();
  };

  const workspace = async (task: Task, project: Project): Promise<Task> => {
    if (task.base) return task;
    await rm(task.workspace, { recursive: true, force: true });
    const state = await createWorkspace(project, task.workspace);
    store.updateTask(task.id, state);
    if (task.upstreamOid) await fetchUpstreamIntoWorkspace(project, task.workspace, task.upstreamOid);
    return store.task(task.id);
  };

  const repair = async (task: Task, project: Project, reason: string) => {
    if (store.task(task.id).status === 'canceled') return;
    if (task.repairs >= project.maxRepairs) {
      blocked(task, `Automatic repair limit reached: ${reason}`);
      return;
    }
    task = await workspace(task, project);
    const head = await updateTaskIntegration(project, { path: task.workspace, base: task.base! });
    if (task.upstreamOid) await fetchUpstreamIntoWorkspace(project, task.workspace, task.upstreamOid);
    const prompt = `${reason}\n\nThe current integration revision is ${head}, available as refs/remotes/integration/bq-integration. Merge it into your task branch if needed; preserve both sets of changes.${task.upstreamOid ? ` Also merge upstream revision ${task.upstreamOid}.` : ''}\nCommit the result and leave no unfinished changes. Do not push.`;
    if (store.task(task.id).status !== 'canceled') {
      store.updateTask(task.id, { status: 'queued', repairs: task.repairs + 1, nextPrompt: prompt, error: reason, candidateHead: null, candidateBase: null });
    }
  };

  const accept = async (task: Task, project: Project) => {
    const claimed = store.db.prepare("UPDATE tasks SET status='publishing',updatedAt=? WHERE id=? AND status='integrating'").run(Date.now(), task.id);
    if (!claimed.changes) return;
    if (!await publishCandidate(project, task.candidateHead!, task.candidateBase!, candidatePath(task))) {
      store.updateTask(task.id, { status: 'integrating', candidateHead: null, candidateBase: null });
      return;
    }
    store.updateTask(task.id, { status: 'done', result: task.candidateHead, error: null });
    console.log(`Task ${task.id}: integrated ${task.candidateHead}`);
    await rm(dirname(task.workspace), { recursive: true, force: true });
    store.requestSync(project.id);
  };

  const launch = async (task: Task, project: Project, kind: Run['kind']) => {
    const run = store.startRun(task, kind);
    await mkdir(task.stateDir, { recursive: true });
    try {
      const container = kind === 'agent'
        ? await startAgent({ name: run.name, dataDir: store.dataDir, workspace: task.workspace, stateDir: task.stateDir, prompt: task.nextPrompt ?? task.prompt, config: project })
        : await startCheck({ name: run.name, dataDir: store.dataDir, workspace: candidatePath(task), stateDir: task.stateDir, command: project.checkCommand!, config: project });
      watch(run, container.done);
      console.log(`Task ${task.id}: ${kind} started (${run.name})`);
    } catch (error) {
      completions.push({ run, exitCode: -1, error: String(error) });
      wake();
    }
  };

  try {
    store.db.prepare("UPDATE tasks SET status='integrating' WHERE status='publishing'").run();
    for (const run of store.activeRuns()) {
      const container = await inspectContainer(run.name, store.dataDir);
      if (!container) {
        completions.push({ run, exitCode: -1, error: 'Container missing after worker restart; retry the task to continue' });
      } else if (['running', 'paused', 'stopping'].includes(container.status)) {
        watch(run, waitContainer(run.name, store.dataDir));
      } else {
        completions.push({ run, exitCode: container.exitCode, error: container.status === 'created' ? 'Container never started' : undefined });
      }
    }

    while (!stopping) {
      pending = false;
      const synced = new Set<number>();
      for (const completion of completions.splice(0)) {
        const { run } = completion;
        let task = store.task(run.taskId);
        const project = store.project(task.projectId);
        const container = await inspectContainer(run.name, store.dataDir);
        if (container && ['running', 'paused', 'stopping'].includes(container.status)) {
          if (completion.error) throw new Error(`Cannot observe running container ${run.name}: ${completion.error}`);
          watch(run, waitContainer(run.name, store.dataDir));
          continue;
        }
        if (!container || !['exited', 'stopped'].includes(container.status)) {
          completion.error ??= 'Container did not finish; retry the task to continue';
        }
        const exitCode = completion.error ? -1 : container!.exitCode;
        store.finishRun(run, exitCode, completion.error ?? null, container?.startedAt, container?.finishedAt);
        await removeContainer(run.name, store.dataDir);
        if (store.task(task.id).status === 'canceled') continue;
        task = store.task(task.id);
        try {
          await synchronize(project);
          synced.add(project.id);
          if (completion.error || (run.kind === 'agent' && exitCode !== 0)) {
            blocked(task, completion.error ?? `pi exited with code ${exitCode}; see ${task.stateDir}/run-${run.name}.stderr.log`);
          } else if (run.kind === 'check') {
            const head = await integrationHead(project);
            if (head !== task.candidateBase) {
              store.updateTask(task.id, { status: 'integrating', candidateHead: null, candidateBase: null });
            } else if (exitCode !== 0) {
              await repair(task, project, `The proposed merged result failed project checks (exit ${exitCode}). Logs: /bq/run-${run.name}.stdout.log and /bq/run-${run.name}.stderr.log. Fix the failure in your task branch.`);
            } else if ((await git(candidatePath(task), ['rev-parse', 'HEAD'])).trim() !== task.candidateHead || (await git(candidatePath(task), ['status', '--porcelain', '--untracked-files=no'])).trim()) {
              blocked(task, 'Project checks modified the candidate commit or tracked files');
            } else {
              await accept(task, project);
            }
          }
        } catch (error) { blocked(task, error); }
      }

      for (const run of store.activeRuns()) {
        if (store.task(run.taskId).status === 'canceled' && !stoppingRuns.has(run.id)) {
          try {
            await stopContainer(run.name, store.dataDir);
            stoppingRuns.add(run.id);
          } catch (error) { console.error(String(error)); }
        }
      }

      for (const project of store.listProjects().filter(project => project.syncRequested)) {
        try {
          await synchronize(project);
          synced.add(project.id);
        } catch (error) {
          console.error(`Project ${project.source}: ${error}`);
        }
      }

      const tasks = store.tasks().filter(task => ['queued', 'integrating'].includes(task.status))
        .sort((a, b) => Number(b.kind === 'upstream') - Number(a.kind === 'upstream') || a.id - b.id);
      for (let task of tasks) {
        if (stopping) break;
        const project = store.project(task.projectId);
        try {
          if (!synced.has(project.id)) {
            await synchronize(project);
            synced.add(project.id);
          }
          task = store.task(task.id);
          if (!['queued', 'integrating'].includes(task.status)) continue;
          if (task.kind === 'work' && store.tasks().some(other => other.projectId === project.id && other.kind === 'upstream' && !['done', 'canceled'].includes(other.status))) continue;
          if (task.status === 'queued') {
            const allowance = store.account();
            if (!canStart(allowance.target, allowance.balance, allowance.running)) continue;
            task = await workspace(task, project);
            if (store.task(task.id).status === 'canceled') continue;
            if (task.base) await updateTaskIntegration(project, { path: task.workspace, base: task.base });
            await launch(task, project, 'agent');
          } else {
            if (project.checkCommand) {
              const allowance = store.account();
              if (!canStart(allowance.target, allowance.balance, allowance.running)) continue;
            }
            if (task.upstreamOid && task.base && Number(await git(task.workspace, ['rev-list', '--count', `HEAD..${task.upstreamOid}`])) > 0) {
              await repair(task, project, `Upstream revision ${task.upstreamOid} has not been merged into your task branch.`);
              wake();
              continue;
            }
            const candidate = task.kind === 'upstream' && !task.base
              ? await prepareUpstream(project, task.upstreamOid!, candidatePath(task))
              : await prepareCandidate(project, { path: task.workspace, base: task.base! }, candidatePath(task), task.ignored, task.untracked);
            if (candidate.status === 'repair') {
              await repair(task, project, candidate.reason);
              wake();
            } else if (candidate.status === 'noop') {
              const completed = store.db.prepare("UPDATE tasks SET status='done',result=?,error=NULL,updatedAt=? WHERE id=? AND status='integrating'").run(candidate.head, Date.now(), task.id);
              if (completed.changes) await rm(dirname(task.workspace), { recursive: true, force: true });
            } else {
              store.updateTask(task.id, { candidateHead: candidate.head, candidateBase: candidate.base });
              task = store.task(task.id);
              if (project.checkCommand) await launch(task, project, 'check');
              else { await accept(task, project); wake(); }
            }
          }
        } catch (error) { blocked(task, error); }
      }

      if (stopping) break;
      if (pending) continue;
      const allowance = store.account();
      const actionable = store.tasks().some(task => ['queued', 'integrating'].includes(task.status) &&
        (task.kind === 'upstream' || !store.tasks().some(other => other.projectId === task.projectId && other.kind === 'upstream' && !['done', 'canceled'].includes(other.status))));
      let delay = actionable ? nextAdmission(allowance.target, allowance.balance, allowance.running) : null;
      if (store.activeRuns().some(run => store.task(run.taskId).status === 'canceled' && !stoppingRuns.has(run.id))) {
        delay = Math.min(delay ?? 5_000, 5_000);
      }
      await new Promise<void>(resolve => {
        let timer: NodeJS.Timeout | undefined;
        resume = () => { clearTimeout(timer); resolve(); };
        if (delay !== null) timer = setTimeout(resume, Math.min(Math.max(delay, 10), 2_147_483_647));
        if (pending || stopping) resume();
      });
      resume = undefined;
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    options.signal?.removeEventListener('abort', stop);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
}
