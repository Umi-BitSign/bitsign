"""Exercise the killable admission boundary using one disposable fixture root."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


class AdmissionBoundaryTests(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ["BITSIGN_TEST_TMPDIR"])
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=root, prefix="admission-unit-")
        self.root = Path(self.temporary.name)
        source = Path(__file__).with_name("server.py").read_text()
        # Load only the real admission function: model startup and a real HTTP
        # listener are separately qualified in the actual Docker image.
        import ast
        tree = ast.parse(source)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "admit_video")
        self.namespace = {"subprocess": subprocess, "sys": sys, "os": os, "signal": __import__("signal"),
                          "json": json, "Path": Path, "APP_ROOT": self.root}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "server.py", "exec"), self.namespace)

    def tearDown(self):
        self.temporary.cleanup()

    def test_admission_timeout_kills_decoder_descendant(self):
        worker = self.root / "admit_video.py"
        worker.write_text('import pathlib,subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(120)"])\npathlib.Path(__file__).with_name("child.pid").write_text(str(p.pid))\ntime.sleep(120)\n')
        with self.assertRaisesRegex(ValueError, "video_admission_timeout"):
            self.namespace["admit_video"](self.root / "input.video", self.root, timeout_seconds=.3)
        pid = int((self.root / "child.pid").read_text())
        for _ in range(20):
            state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
            if not state or state.startswith("Z"):
                break
            time.sleep(.05)
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_admission_rejects_foreign_output_path(self):
        (self.root / "admit_video.py").write_text('print(\'{"path":"/outside/task.mp4","normalized":false}\')\n')
        with self.assertRaisesRegex(ValueError, "video_admission_failed"):
            self.namespace["admit_video"](self.root / "input.video", self.root)


if __name__ == "__main__":
    unittest.main()
