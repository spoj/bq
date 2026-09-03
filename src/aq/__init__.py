import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from decimal import Decimal
from pathlib import Path

MICROS = Decimal("1000000")
SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    argv TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    exit_code INTEGER
);
CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def db_path() -> Path:
    if path := os.environ.get("AQ_DB"):
        return Path(path)
    state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state / "aq/aq.db"


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def micros(value: str) -> int:
    amount = Decimal(value)
    if amount < 0:
        raise SystemExit("amount must not be negative")
    return int(amount * MICROS)


def money(value: int) -> str:
    return f"{Decimal(value) / MICROS:.6f}".rstrip("0").rstrip(".")


def setting(db: sqlite3.Connection, key: str) -> int | None:
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return int(row["value"]) if row else None


def balance(db: sqlite3.Connection, now: int | None = None) -> tuple[int, int, int]:
    epoch = setting(db, "budget_epoch")
    rate = setting(db, "hourly_credit")
    initial = setting(db, "initial_balance")
    if epoch is None or rate is None or initial is None:
        raise SystemExit("budget is not configured; run: aq budget set RATE")
    now = int(time.time()) if now is None else now
    credits = max(0, (now - epoch) // 3600) * rate
    spent = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM charges WHERE created_at >= ?",
        (epoch,),
    ).fetchone()["total"]
    return initial + credits - spent, credits, spent


def set_budget(args: argparse.Namespace) -> None:
    now = int(time.time())
    values = {
        "budget_epoch": now,
        "hourly_credit": micros(args.rate),
        "initial_balance": micros(args.initial if args.initial is not None else args.rate),
    }
    with connect() as db:
        db.executemany(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(key, str(value)) for key, value in values.items()],
        )
    show_budget(args)


def show_budget(_args: argparse.Namespace) -> None:
    with connect() as db:
        current, credits, spent = balance(db)
        rate = setting(db, "hourly_credit")
        initial = setting(db, "initial_balance")
    print(f"balance\t{money(current)}")
    print(f"rate/hour\t{money(rate or 0)}")
    print(f"initial\t{money(initial or 0)}")
    print(f"credited\t{money(credits)}")
    print(f"spent\t{money(spent)}")


def add(args: argparse.Namespace) -> None:
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise SystemExit("missing command after --")
    cwd = str(Path(args.cwd).expanduser().resolve())
    if not Path(cwd).is_dir():
        raise SystemExit(f"working directory does not exist: {cwd}")
    now = int(time.time())
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO tasks(argv, cwd, status, created_at) VALUES(?, ?, 'queued', ?)",
            (json.dumps(command), cwd, now),
        )
    print(cursor.lastrowid)


def list_tasks(_args: argparse.Namespace) -> None:
    with connect() as db:
        rows = db.execute(
            "SELECT id, status, created_at, argv FROM tasks ORDER BY id"
        ).fetchall()
    print("ID\tSTATUS\tCOMMAND")
    for row in rows:
        print(f"{row['id']}\t{row['status']}\t{' '.join(json.loads(row['argv']))}")


def get_task(db: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        raise SystemExit(f"task {task_id} not found")
    return row


def show(args: argparse.Namespace) -> None:
    with connect() as db:
        row = get_task(db, args.task_id)
        charged = db.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM charges WHERE task_id = ?",
            (args.task_id,),
        ).fetchone()["total"]
    fields = dict(row)
    fields["argv"] = json.loads(fields["argv"])
    fields["charged"] = money(charged)
    fields["unit"] = f"aq-task-{args.task_id}.service"
    print(json.dumps(fields, indent=2))


def cancel(args: argparse.Namespace) -> None:
    with connect() as db:
        row = get_task(db, args.task_id)
        if row["status"] not in ("queued", "running"):
            raise SystemExit(f"task {args.task_id} is {row['status']}")
        db.execute(
            "UPDATE tasks SET status = 'canceled', finished_at = ? WHERE id = ?",
            (int(time.time()), args.task_id),
        )
    if row["status"] == "running":
        subprocess.run(
            ["systemctl", "--user", "stop", f"aq-task-{args.task_id}.service"],
            check=False,
        )


def retry(args: argparse.Namespace) -> None:
    with connect() as db:
        row = get_task(db, args.task_id)
        if row["status"] not in ("failed", "canceled"):
            raise SystemExit(f"task {args.task_id} is {row['status']}")
        db.execute(
            "UPDATE tasks SET status = 'queued', started_at = NULL, finished_at = NULL, "
            "exit_code = NULL WHERE id = ?",
            (args.task_id,),
        )


def charge(args: argparse.Namespace) -> None:
    amount = micros(args.amount)
    if amount < 0:
        raise SystemExit("charge must not be negative")
    now = int(time.time())
    with connect() as db:
        get_task(db, args.task_id)
        db.execute(
            "INSERT INTO charges(task_id, amount, created_at) VALUES(?, ?, ?)",
            (args.task_id, amount, now),
        )
        current, _, _ = balance(db, now)
    print(money(current))


def claim() -> sqlite3.Row | None:
    db = connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        current, _, _ = balance(db)
        if current <= 0:
            db.rollback()
            return None
        row = db.execute(
            "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at, id LIMIT 1"
        ).fetchone()
        if not row:
            db.rollback()
            return None
        db.execute(
            "UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?",
            (int(time.time()), row["id"]),
        )
        db.commit()
        return row
    finally:
        db.close()


def recover_running() -> None:
    now = int(time.time())
    with connect() as db:
        rows = db.execute("SELECT id FROM tasks WHERE status = 'running'").fetchall()
        for row in rows:
            subprocess.run(
                ["systemctl", "--user", "stop", f"aq-task-{row['id']}.service"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        db.execute(
            "UPDATE tasks SET status = 'failed', finished_at = ?, exit_code = NULL "
            "WHERE status = 'running'",
            (now,),
        )


def run_task(task: sqlite3.Row, direct: bool = False) -> None:
    argv = json.loads(task["argv"])
    env = os.environ.copy()
    env["AQ_TASK_ID"] = str(task["id"])
    env["AQ_DB"] = str(db_path())
    if direct:
        result = subprocess.run(argv, cwd=task["cwd"], env=env, check=False)
    else:
        command = [
            "systemd-run",
            "--user",
            "--wait",
            "--quiet",
            f"--unit=aq-task-{task['id']}",
            f"--working-directory={task['cwd']}",
            f"--setenv=AQ_TASK_ID={task['id']}",
            f"--setenv=AQ_DB={db_path()}",
            "--",
            *argv,
        ]
        result = subprocess.run(command, check=False)
    status = "succeeded" if result.returncode == 0 else "failed"
    with connect() as db:
        current = get_task(db, task["id"])
        if current["status"] == "running":
            db.execute(
                "UPDATE tasks SET status = ?, finished_at = ?, exit_code = ? WHERE id = ?",
                (status, int(time.time()), result.returncode, task["id"]),
            )


def worker(args: argparse.Namespace) -> None:
    recover_running()
    while True:
        task = claim()
        if task:
            run_task(task, args.direct)
            if args.once:
                return
            continue
        if args.once:
            return
        time.sleep(args.poll_interval)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="aq", description="Budget-aware command queue")
    commands = root.add_subparsers(dest="subcommand", required=True)

    add_parser = commands.add_parser("add", help="enqueue a command")
    add_parser.add_argument("--cwd", default=".")
    add_parser.add_argument("command", nargs=argparse.REMAINDER)
    add_parser.set_defaults(func=add)

    commands.add_parser("list", help="list tasks").set_defaults(func=list_tasks)

    show_parser = commands.add_parser("show", help="show a task")
    show_parser.add_argument("task_id", type=int)
    show_parser.set_defaults(func=show)

    cancel_parser = commands.add_parser("cancel", help="cancel a task")
    cancel_parser.add_argument("task_id", type=int)
    cancel_parser.set_defaults(func=cancel)

    retry_parser = commands.add_parser("retry", help="requeue a failed or canceled task")
    retry_parser.add_argument("task_id", type=int)
    retry_parser.set_defaults(func=retry)

    charge_parser = commands.add_parser("charge", help="record task cost")
    charge_parser.add_argument("task_id", type=int)
    charge_parser.add_argument("amount", help="decimal cost, for example 1.37")
    charge_parser.set_defaults(func=charge)

    budget_parser = commands.add_parser("budget", help="show or configure the budget")
    budget_commands = budget_parser.add_subparsers(dest="budget_command")
    budget_parser.set_defaults(func=show_budget)
    budget_set = budget_commands.add_parser("set", help="reset the budget epoch and rate")
    budget_set.add_argument("rate", help="credits added per hour")
    budget_set.add_argument("--initial", help="initial balance; defaults to one hour")
    budget_set.set_defaults(func=set_budget)

    worker_parser = commands.add_parser("worker", help="run queued commands")
    worker_parser.add_argument("--once", action="store_true")
    worker_parser.add_argument("--direct", action="store_true", help="run without systemd")
    worker_parser.add_argument("--poll-interval", type=float, default=5)
    worker_parser.set_defaults(func=worker)
    return root


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
