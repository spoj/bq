import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAgent, startCheck, inspectContainer, removeContainer, waitContainer, agentError } from '../src/container.ts';
import { git, initializeProject, createWorkspace, prepareCandidate, publishCandidate } from '../src/git.ts';

test('real Podman and pi: mounts, session repair, checked integration, recovery, cancellation', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bq-podman-smoke-'));
  const dataDir = resolve(process.env.BQ_DATA_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'bq'));
  const names: string[] = [];
  const token = randomUUID();
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const messages = JSON.parse(body).messages;
    requests++;
    const finished = messages.at(-1).role === 'tool';
    const resume = JSON.stringify(messages.filter((message: { role: string }) => message.role === 'user').at(-1)).includes('Commit smoke result');
    const command = resume ? 'git add result.txt && git commit -m smoke' : 'test "$(cat .env)" = smoke-secret && printf "smoke result\\n" > result.txt';
    const delta = finished ? { content: 'Smoke step complete.' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }],
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }]) {
      response.write(`data: ${JSON.stringify({ id: `smoke_${requests}`, object: 'chat.completion.chunk', created: 0, model: 'smoke', choices: [choice] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  t.after(async () => {
    await Promise.all(names.map(name => removeContainer(name, dataDir)));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as { port: number }).port;
  const source = join(root, 'source');
  const piConfig = join(root, 'pi');
  const stateDir = join(root, 'state');
  await mkdir(source);
  await mkdir(piConfig);
  await writeFile(join(piConfig, 'models.json'), JSON.stringify({ providers: { smoke: {
    baseUrl: `http://host.containers.internal:${port}/v1`, api: 'openai-completions', apiKey: token,
    models: [{ id: 'smoke', contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Smoke']);
  await git(source, ['config', 'user.email', 'smoke@localhost']);
  await writeFile(join(source, '.gitignore'), '.env\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'initial']);
  await writeFile(join(source, '.env'), 'smoke-secret\n');
  const project = { id: 1, source, branch: 'main', integration: join(root, 'integration') };
  await initializeProject(project);
  const path = join(root, 'task');
  const baseline = await createWorkspace(project, path);
  const workspace = { path, base: baseline.base };
  const config = { image: 'bq-agent:local', model: 'smoke/smoke', thinking: 'off', env: [], piConfig };
  const name = () => { const value = `bq-smoke-${randomUUID()}`; names.push(value); return value; };
  for (const prompt of ['First smoke run', 'Commit smoke result']) {
    const container = await startAgent({ name: name(), dataDir, workspace: path, stateDir, prompt, config });
    const result = await container.done;
    assert.equal(result.exitCode, 0, await readFile(join(stateDir, `run-${container.name}.stderr.log`), 'utf8'));
    assert.equal(await agentError(stateDir, container.name), null);
    if (prompt === 'First smoke run') {
      assert.equal((await prepareCandidate(project, workspace, join(root, 'candidate'), baseline.ignored, baseline.untracked)).status, 'repair', await readFile(join(stateDir, `run-${container.name}.stdout.log`), 'utf8'));
    }
  }
  assert.equal(requests, 4);
  const session = await readFile(join(stateDir, 'session.jsonl'), 'utf8');
  assert.ok(session.includes('First smoke run') && session.includes('Commit smoke result'));
  const candidatePath = join(root, 'candidate');
  const candidate = await prepareCandidate(project, workspace, candidatePath, baseline.ignored, baseline.untracked);
  assert.equal(candidate.status, 'ready');
  if (candidate.status !== 'ready') return;
  const check = await startCheck({ name: name(), dataDir, workspace: candidatePath, stateDir, command: 'test -z "${HTTPS_PROXY+x}${HTTP_PROXY+x}${ALL_PROXY+x}${https_proxy+x}" && ' + `test "$(id -u)" = ${process.getuid()} && test "$(cat .env)" = smoke-secret && test "$(cat result.txt)" = "smoke result" && pi --version`, config });
  assert.equal((await check.done).exitCode, 0);
  assert.equal(await publishCandidate(project, candidate.head, candidate.base, candidatePath), true);
  assert.equal(await git(project.integration, ['show', 'bq-integration:result.txt']), 'smoke result');
  await assert.rejects(readFile(join(source, 'result.txt')));
  const recovery = await startCheck({ name: name(), dataDir, workspace: path, stateDir, command: 'sleep 2', config });
  while (!(await inspectContainer(recovery.name, dataDir))) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await waitContainer(recovery.name, dataDir)).exitCode, 0);
  assert.equal((await recovery.done).exitCode, 0);
  const canceled = await startCheck({ name: name(), dataDir, workspace: path, stateDir, command: 'sleep 60', config });
  while ((await inspectContainer(canceled.name, dataDir))?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20));
  await canceled.stop();
  assert.notEqual((await canceled.done).exitCode, 0);
});
