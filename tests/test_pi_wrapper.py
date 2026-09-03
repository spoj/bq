import importlib.machinery
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

pi_wrapper = importlib.machinery.SourceFileLoader("pi_wrapper", "examples/bq-pi").load_module()


def message(entry_id, role, cost=None, **fields):
    value = {
        "type": "message",
        "id": entry_id,
        "timestamp": entry_id,
        "message": {"role": role, **fields},
    }
    if cost is not None:
        value["message"]["usage"] = {"cost": {"total": cost}}
    return value


def write_session(path, entries):
    path.write_text("\n".join(json.dumps(entry) for entry in [{"type": "session"}, *entries]) + "\n")


class PiWrapperTest(unittest.TestCase):
    def test_invocation_runs_pi_and_charges_the_task(self):
        pi_result = unittest.mock.Mock(returncode=7)
        with (
            patch.dict("os.environ", {"BQ_TASK_ID": "12"}, clear=True),
            patch("sys.argv", ["bq-pi", "-p", "fix it"]),
            patch.object(pi_wrapper, "session_cost", return_value=Decimal("1.25")),
            patch("subprocess.run", side_effect=[pi_result, unittest.mock.Mock()]) as run,
        ):
            self.assertEqual(pi_wrapper.main(), 7)

        pi_command = run.call_args_list[0]
        self.assertEqual(pi_command.args[0][:2], ["pi", "--extension"])
        self.assertEqual(pi_command.args[0][3:], ["-p", "fix it"])
        self.assertIn("BQ_PI_MANIFEST", pi_command.kwargs["env"])
        run.assert_any_call(["bq", "charge", "12", "1.25"], check=True)

    def test_cost_follows_forks_without_history_or_unrelated_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            parent = directory / "parent.jsonl"
            child = directory / "child.jsonl"
            unrelated = directory / "unrelated.jsonl"
            old = message("old", "assistant", "10")
            parent_use = message("parent", "assistant", "1.25")
            fork = message(
                "fork",
                "toolResult",
                toolName="Fork",
                details={"transcriptPath": str(child)},
            )
            delegated = message("task", "user", content="<delegated-task>work</delegated-task>")
            child_use = message("child", "assistant", "2.5")
            write_session(parent, [old, parent_use, fork])
            write_session(child, [old, parent_use, delegated, child_use])
            write_session(unrelated, [message("unrelated", "assistant", "100")])
            manifest = directory / "manifest"
            manifest.write_text(json.dumps({"path": str(parent), "entryIds": ["old"]}) + "\n")

            self.assertEqual(pi_wrapper.session_cost(manifest), Decimal("3.75"))


if __name__ == "__main__":
    unittest.main()
