import argparse
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import aq


class AqTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "aq.db"
        self.env = patch.dict(os.environ, {"AQ_DB": str(self.db_path)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def configure(self, rate="5", initial=None):
        with patch("time.time", return_value=1000), patch("builtins.print"):
            aq.set_budget(argparse.Namespace(rate=rate, initial=initial))

    def add(self, command=None):
        command = command or ["python", "-c", "pass"]
        with patch("time.time", return_value=1000), patch("builtins.print"):
            aq.add(argparse.Namespace(cwd=self.temp.name, command=command))
        return 1

    def test_budget_accrues_hourly_and_subtracts_charges(self):
        self.configure(rate="2", initial="1")
        task_id = self.add()
        with patch("time.time", return_value=1000):
            aq.charge(argparse.Namespace(task_id=task_id, amount="1.5"))
        with aq.connect() as db:
            current, credits, spent = aq.balance(db, now=1000 + 2 * 3600 + 10)
        self.assertEqual(current, 3_500_000)
        self.assertEqual(credits, 4_000_000)
        self.assertEqual(spent, 1_500_000)

    def test_claim_is_fifo_and_requires_positive_balance(self):
        self.configure(rate="1", initial="1")
        self.add(["first"])
        with patch("time.time", return_value=1001), patch("builtins.print"):
            aq.add(argparse.Namespace(cwd=self.temp.name, command=["second"]))
        with patch("time.time", return_value=1002):
            task = aq.claim()
        self.assertEqual(task["id"], 1)
        with aq.connect() as db:
            db.execute(
                "INSERT INTO charges(task_id, amount, created_at) VALUES(1, 2000000, 1002)"
            )
        with patch("time.time", return_value=1003):
            self.assertIsNone(aq.claim())

    def test_direct_worker_records_success(self):
        self.configure()
        self.add()
        args = argparse.Namespace(once=True, direct=True, poll_interval=0)
        with patch("time.time", return_value=1001):
            aq.worker(args)
        with aq.connect() as db:
            task = aq.get_task(db, 1)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["exit_code"], 0)

    def test_retry_requeues_failed_task(self):
        self.configure()
        self.add()
        with aq.connect() as db:
            db.execute("UPDATE tasks SET status = 'failed' WHERE id = 1")
        aq.retry(argparse.Namespace(task_id=1))
        with aq.connect() as db:
            self.assertEqual(aq.get_task(db, 1)["status"], "queued")

    def test_parser_preserves_command_arguments(self):
        args = aq.parser().parse_args(
            ["add", "--cwd", self.temp.name, "--", "pi", "-p", "do work"]
        )
        with patch("builtins.print"):
            aq.add(args)
        with aq.connect() as db:
            argv = json.loads(aq.get_task(db, 1)["argv"])
        self.assertEqual(argv, ["pi", "-p", "do work"])


if __name__ == "__main__":
    unittest.main()
