# bq

`bq` is a Git-integrated queue for Pi coding agents. It runs each task in a
Podman container, gives it a private copy-on-write workspace, and accepts its
commits into a bq-owned `bq-integration` branch only after the harness checks
them.

The original repository is never modified by bq. The integration branch is an
output that you can inspect and merge into your own branch when ready.

## Requirements

Install bq from a checkout before the first build. Either compile and run the
local CLI directly:

```sh
npm run build
./dist/cli.js build
```

or install the package under `~/.local` and use its `bq` executable:

```sh
npm install --global --prefix "$HOME/.local" .
bq build
```

- Linux
- Node.js 24.12 or newer
- Git
- Rootless Podman, with subordinate UID/GID ranges in `/etc/subuid` and `/etc/subgid`
- GNU `cp` and `flock` (from the standard coreutils/util-linux packages)
- Btrfs (recommended, for reflink-backed task workspaces)

Check rootless setup with `bq podman info`. If it reports missing subordinate
IDs, have an administrator allocate unused ranges to your user, then run
`bq podman system migrate` before building the image.

The bundled agent image contains Pi and its basic command-line dependencies.
The worker uses Podman's `--pull=never`, so build the image locally (or pull it
explicitly with `bq podman pull`) before queueing work:

```sh
bq build
```

`bq build` uses bq's private persistent Podman store, separate from your other
Podman images. Inspect it with the same store using `bq podman ps`,
`bq podman images`, or any other Podman arguments. The store is under
`${XDG_DATA_HOME:-~/.local/share}/bq/podman/`; transient runtime files are
under `${XDG_RUNTIME_DIR:-/run/user/$UID}/bq/`.

The image tag defaults to `bq-agent:local`. Source files are TypeScript for
development, but `npm run build` compiles the executable to `dist/`; the
published/global package points at that JavaScript build because Node does not
strip TypeScript inside installed packages.

## Register a project

```sh
cd ~/project_a
bq init . \
  --branch main \
  --image bq-agent:local \
  --model anthropic/claude-sonnet-4-5 \
  --check 'npm test'
```

`--model` is the model identifier passed to Pi. Other useful options are:

```text
--thinking medium       Pi reasoning level (default: medium)
--env NAME               pass a named host environment variable to containers; repeatable
--pi-config PATH         Pi configuration directory (default: ~/.pi/agent)
--max-repairs N          automatic repair attempts (default: 3)
```

Each task copies `auth.json` and `models.json` from the selected Pi configuration
directory once. Its private copies and session persist across resumptions. Global
Pi extensions, skills, and packages are not loaded; the container uses the bundled
Pi and the project's context files. Environment variables are passed only when
listed with `--env`.

The project must be a normal, non-bare Git repository and the upstream branch
must already exist locally. Re-running `init` updates the image, model, checks,
environment names, and repair limit; changing the registered branch is
rejected.

## Queue and run work

```sh
bq add --cwd ~/project_a 'Add a health endpoint and tests'
bq list
bq worker
bq show 1
```

`bq worker` is normally run as a user service. A single worker is enforced by
an OS lock, so starting a second worker is harmless. The worker starts as many
containers as the runtime scheduler allows and waits for them to finish.

Cancel or retry a task:

```sh
bq cancel 1
bq retry 1
```

A task is complete only when its commits have been accepted into
`bq-integration`. A clean agent exit is not by itself completion. If an agent
leaves uncommitted changes, if integration conflicts, or if the configured
checks fail, bq wakes Pi again with the concrete repair request. Failed repair
loops eventually become `blocked`; `retry` resumes their saved workspace and session.
Cancellation is refused once the short final publication step has begun. Stopping
the worker leaves running containers intact; restarting it recovers them.

## Average concurrency

The scheduler targets average simultaneous container concurrency, not a money
balance. Fractions are valid:

```sh
bq concurrency 0.2
bq concurrency 1.5
bq concurrency 3.14
bq concurrency
```

Usage is measured internally in container milliseconds; `bq concurrency`
reports the current balance in seconds. Idle time accrues bounded credit; the
bound is one minute of target concurrency, so a machine cannot accumulate an
unlimited burst after sitting idle. Running containers are never preempted.
The instantaneous default ceiling is `ceil(target)`, and repair, conflict
resolution, and checks consume the same runtime allowance. Set the target to
zero to pause new starts without stopping running work:

```sh
bq concurrency 0
bq concurrency 0.2
```

This is a long-run average: for example, target `0.2` permits about ten minutes
of work followed by about forty minutes of repayment when there is one task
running.

## Git and local files

For each registered repository bq keeps an integration clone under:

```text
${XDG_DATA_HOME:-~/.local/share}/bq/integrations/
```

It creates and owns the local `bq-integration` branch there. Each task gets a
private workspace made from the integration snapshot. Btrfs reflinks make
unchanged file contents share storage; when reflinks are unavailable bq falls
back to regular copies.

Tracked files come from `bq-integration`. All untracked and ignored files in
the original project are copied into a new task workspace, including `.env`,
local credentials, dependencies, and caches. Copying is isolated: task edits
cannot modify the original directory or another task. New tasks snapshot the
current local files; resumed tasks keep their existing workspace.

Uncommitted edits to tracked files in the original directory are deliberately
not copied. Untracked and ignored files are copied as local environment inputs,
but are not automatically integrated: ignored inputs cannot be committed by a
task, while an untracked file can be explicitly committed if the task requires
it. Copying is not an atomic filesystem snapshot, so avoid changing local files
while a task is being created. Host dependencies are available to the task but
may need to be rebuilt for the container image. The agent is trusted with any
secrets present in those files.

Agents work in parallel on independent task branches. The harness serializes
acceptance into `bq-integration`, tests candidate merges in disposable Git
checkouts, and never leaves the canonical integration clone conflicted. If the
source branch changes, bq fetches it when a task starts or `bq sync` is run. A
conflict creates a resolution task rather than damaging the integration branch.

To consume the result manually:

```sh
cd ~/project_a
git fetch /path/to/integration-clone bq-integration
git merge FETCH_HEAD
```

The integration clone path is shown by `bq list` and in the `project` object
printed by `bq show`.

## Configuration and state

By default:

```text
${XDG_DATA_HOME:-~/.local/share}/bq/       integration clones and workspaces
${XDG_STATE_HOME:-~/.local/state}/bq/     queue.sqlite, logs, and locks
```

Use `BQ_DATA_HOME` and `BQ_STATE_HOME` to override those roots. The new queue
uses `queue.sqlite`; it does not read the database from the old Python
implementation.

## Run continuously

Install the local package and enable the user service yourself:

```sh
./deploy-local.sh
journalctl --user -u bq-worker -f
```

`deploy-local.sh` does not push, install a remote package, or enable anything
until you run it. It installs the executable under `~/.local/bin` and updates
the user service definition.

## Development

```sh
npm test
npm run build
```

The implementation intentionally uses Node's built-in TypeScript stripping and
SQLite APIs; there are no runtime or development package dependencies.
