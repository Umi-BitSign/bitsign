"""Adapter tests; real model parity is separately qualified on actual videos."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from warm_worker import CachedRuntimeFactory, RepeatableInteropThreads, WarmEntrypoint
from warm_worker_client import WarmWorkerClient

TASK_SCRATCH = Path(os.environ.get("BITSIGN_TEST_TMPDIR", tempfile.gettempdir()))
MODEL_ROOT = Path(__file__).resolve().parents[2] / "model/c5-winner/artifact/model"


class WarmAdapterTests(unittest.TestCase):
    def test_entrypoint_failure_restores_stdout_and_allows_another_capture(self):
        TASK_SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TASK_SCRATCH, prefix="capture-unit-") as scratch:
            video = Path(scratch) / "fixture.video"
            video.write_bytes(b"unit fixture")
            entrypoint = WarmEntrypoint.__new__(WarmEntrypoint)
            entrypoint.model_root = Path(scratch)
            def broken():
                os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
                raise RuntimeError("fixture failure")
            entrypoint.entrypoint = types.SimpleNamespace(main=broken)
            before = os.fstat(sys.stdout.fileno())
            with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                entrypoint.translate(video)
            after = os.fstat(sys.stdout.fileno())
            self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
            entrypoint.entrypoint.main = lambda: os.write(sys.stdout.fileno(), b"fixture capture")
            self.assertEqual(entrypoint.translate(video), "fixture capture")

    def test_runtime_refuses_changed_arguments_and_resets_generate(self):
        class Translator:
            def generate(self):
                return "original"

        class Runtime:
            def __init__(self, root, *, device="cpu"):
                self._translator = Translator()

        factory = CachedRuntimeFactory(Runtime)
        first = factory(Path("/model"))
        original = first._translator.generate
        first._translator.generate = lambda: "override"
        second = factory(Path("/model"), device="cpu")
        self.assertIs(first, second)
        self.assertEqual(second._translator.generate, original)
        with self.assertRaisesRegex(RuntimeError, "arguments changed"):
            factory(Path("/other-model"))

    def test_interop_setting_only_accepts_identical_repeat(self):
        calls = []
        torch = types.SimpleNamespace()
        torch.count = 3

        def set_count(count):
            calls.append(count)
            torch.count = count

        torch.set_num_interop_threads = set_count
        torch.get_num_interop_threads = lambda: torch.count
        setting = RepeatableInteropThreads(torch)
        setting(1)
        setting(1)
        self.assertEqual(calls, [1])
        with self.assertRaises(RuntimeError):
            setting(2)
        torch.count = 2
        with self.assertRaises(RuntimeError):
            setting(1)

    @unittest.skipUnless((MODEL_ROOT / "umi_inference.py").is_file(), "download C5 artifact first")
    def test_actual_original_main_keeps_shortcut_fallback_overrides_and_stage2(self):
        TASK_SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TASK_SCRATCH, prefix="unit-") as scratch:
            video = Path(scratch) / "fixture.video"
            video.write_bytes(b"unit fixture: video decoder is stubbed")
            constructor_calls, generation_calls, thread_calls = [], [], []
            baseline = ["ordinary continuous signing"]
            torch = types.ModuleType("torch")
            torch.set_num_threads = lambda count: thread_calls.append(("intra", count))
            torch.get_num_interop_threads = lambda: 1
            torch.set_num_interop_threads = lambda count: thread_calls.append(("inter", count))
            runtime = types.ModuleType("runtime")

            class Translator:
                def generate(self, **kwargs):
                    generation_calls.append(kwargs)
                    return baseline[0]

            class Runtime:
                def __init__(self, root, *, device, generation_num_beams,
                             generation_max_length, dino_batch_size,
                             model_execution_concurrency, verify_assets):
                    constructor_calls.append((root, device, generation_num_beams,
                        generation_max_length, dino_batch_size,
                        model_execution_concurrency, verify_assets))
                    self._translator = Translator()

                def translate_path(self, path):
                    return self._translator.generate(video=str(path))

            runtime.SHuBERTInferenceRuntime = Runtime
            landmarks = types.ModuleType("umi_landmarks")
            landmarks.video_holistic = object()
            reader = types.ModuleType("umi_video_reader")
            reader.VideoReader = object()
            modules = {"torch": torch, "runtime": runtime, "numpy": types.ModuleType("numpy"),
                       "umi_landmarks": landmarks, "umi_video_reader": reader}
            original_path = list(sys.path)
            try:
                with patch.dict(sys.modules, modules), patch.dict(os.environ, {"UMI_EVALUATION_DEVICE": "cpu"}):
                    spec = importlib.util.spec_from_file_location("umi_fs_router", MODEL_ROOT / "umi_fs_router.py")
                    router = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(router)
                    with patch.dict(sys.modules, {"umi_fs_router": router}):
                        entrypoint = WarmEntrypoint(MODEL_ROOT)
                        def child(text, confidence):
                            return subprocess.CompletedProcess([], 0, json.dumps(
                                {"text": text, "confidence": confidence}).encode(), b"")
                        with patch("subprocess.run", return_value=child("hello world", .96)) as run:
                            self.assertEqual(entrypoint.translate(video), "hello world")
                            self.assertEqual(constructor_calls, [])
                            self.assertEqual(run.call_args.kwargs["timeout"], 300)
                            self.assertTrue(run.call_args.kwargs["capture_output"])
                            self.assertEqual(Path(run.call_args.args[0][2]), MODEL_ROOT / "umi_fs_router.py")
                        with patch("subprocess.run", return_value=child("document", .70)):
                            for _ in range(3):
                                self.assertEqual(entrypoint.translate(video), baseline[0])
                                # Original main's lambda closes over the original
                                # bound method, never the previous request lambda.
                                generate = entrypoint.runtime_factory.model._translator.generate
                                closure = dict(zip(generate.__code__.co_freevars,
                                    (cell.cell_contents for cell in generate.__closure__)))
                                self.assertTrue(hasattr(closure["original_generate"], "__self__"))
                        baseline[0] = "it is 123"
                        with patch("subprocess.run", return_value=child("document", .84)):
                            self.assertEqual(entrypoint.translate(video), "document")
                        self.assertEqual(len(constructor_calls), 1)
                        self.assertEqual(constructor_calls[0], (MODEL_ROOT, "cpu", 5, 2048, 128, 1, True))
                        self.assertEqual(len(generation_calls), 4)
                        self.assertTrue(all(call["length_penalty"] == .6
                            and call["no_repeat_ngram_size"] == 16 for call in generation_calls))
                        self.assertEqual(thread_calls.count(("inter", 1)), 1)
            finally:
                sys.path[:] = original_path


class WarmClientTests(unittest.TestCase):
    def setUp(self):
        TASK_SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=TASK_SCRATCH, prefix="client-unit-")
        self.root = Path(self.temporary.name)
        self.video = self.root / "fixture.video"
        self.video.write_text("ok")
        self.worker = self.root / "fixture_worker.py"
        self.worker.write_text('''import json, os, subprocess, sys, time
from pathlib import Path
counter = 0
for line in sys.stdin:
    request = json.loads(line)
    mode = Path(request["videoPath"]).read_text()
    counter += 1
    if mode == "hang":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        Path("child.pid").write_text(str(child.pid))
        time.sleep(120)
    elif mode == "bad":
        print("not json", flush=True)
    elif mode == "partial":
        sys.stdout.write('{"text":')
        sys.stdout.flush()
        time.sleep(120)
    elif mode == "error":
        print(json.dumps({"error": "model_execution_failed"}), flush=True)
    else:
        print(json.dumps({"text": "fixture " + str(counter), "elapsedSeconds": .01}), flush=True)
''')
        self.client = WarmWorkerClient(self.root, timeout_seconds=2, worker_path=self.worker)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_reuses_worker_and_restarts_after_model_error(self):
        with patch("warm_worker_client.subprocess.Popen", wraps=subprocess.Popen) as popen:
            self.assertEqual(self.client.translate(self.video)["text"], "fixture 1")
            self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        first_pid = self.client.process.pid
        self.assertEqual(self.client.translate(self.video)["text"], "fixture 2")
        self.assertEqual(self.client.process.pid, first_pid)
        self.video.write_text("error")
        with self.assertRaisesRegex(RuntimeError, "model_execution_failed"):
            self.client.translate(self.video)
        self.assertIsNone(self.client.process)
        self.video.write_text("ok")
        self.assertEqual(self.client.translate(self.video)["text"], "fixture 1")
        self.assertNotEqual(self.client.process.pid, first_pid)

    def test_timeout_kills_descendant_and_next_request_starts_clean(self):
        self.video.write_text("hang")
        with self.assertRaisesRegex(TimeoutError, "inference_timeout"):
            self.client.translate(self.video)
        child_pid = int((self.root / "child.pid").read_text())
        for _ in range(30):
            state = subprocess.run(["ps", "-o", "stat=", "-p", str(child_pid)],
                capture_output=True, text=True).stdout.strip()
            if not state or state.startswith("Z"):
                break
            time.sleep(.05)
        self.assertTrue(not state or state.startswith("Z"), state)
        self.video.write_text("ok")
        self.assertEqual(self.client.translate(self.video)["text"], "fixture 1")

    def test_partial_response_is_deadline_bounded(self):
        self.video.write_text("partial")
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.client.translate(self.video)
        self.assertLess(time.monotonic() - started, 4)

    def test_malformed_response_restarts_worker(self):
        self.video.write_text("bad")
        with self.assertRaises(ValueError):
            self.client.translate(self.video)
        self.assertIsNone(self.client.process)


if __name__ == "__main__":
    unittest.main()
