"""Serialized, deadline-bounded client for the optional complete C5 warm worker."""

import json
import math
import os
import selectors
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


class WarmWorkerClient:
    def __init__(self, model_root, *, timeout_seconds=600, worker_path=None):
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be finite and positive")
        self.model_root = Path(model_root).resolve()
        self.worker_path = Path(worker_path or Path(__file__).with_name("warm_worker.py")).resolve()
        self.timeout_seconds = timeout_seconds
        self.process = None
        self.lock = threading.Lock()

    def _start(self):
        self.process = subprocess.Popen(
            [sys.executable, "-B", str(self.worker_path)], cwd=self.model_root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            # Native diagnostics can contain private upload paths or content.
            # Only the bounded protocol error reaches the application logger.
            stderr=subprocess.DEVNULL, start_new_session=True,
            env={**os.environ, "UMI_EVALUATION_DEVICE": "cpu",
                 "BITSIGN_MODEL_ROOT": str(self.model_root)},
        )
        os.set_blocking(self.process.stdin.fileno(), False)
        os.set_blocking(self.process.stdout.fileno(), False)

    def _stop(self):
        process, self.process = self.process, None
        if process is None:
            return
        # Kill the group even when its leader has exited: the original
        # fingerspelling subprocess can still be alive in this group.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        finally:
            process.stdin.close()
            process.stdout.close()

    def close(self):
        with self.lock:
            self._stop()

    def translate(self, video):
        payload = (json.dumps({"videoPath": str(Path(video).resolve(strict=True))}) + "\n").encode()
        if len(payload) > 16384:
            raise ValueError("video_path_too_long")
        with self.lock:
            started = time.monotonic()
            deadline = started + self.timeout_seconds
            try:
                if self.process is None or self.process.poll() is not None:
                    self._stop()
                    self._start()
                with selectors.DefaultSelector() as selector:
                    selector.register(self.process.stdout, selectors.EVENT_READ)
                    selector.register(self.process.stdin, selectors.EVENT_WRITE)
                    output = bytearray()
                    sent = 0
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("inference_timeout")
                        events = selector.select(remaining)
                        if not events:
                            raise TimeoutError("inference_timeout")
                        for key, event in events:
                            if event & selectors.EVENT_WRITE:
                                sent += os.write(key.fd, payload[sent:])
                                if sent == len(payload):
                                    selector.unregister(self.process.stdin)
                            if event & selectors.EVENT_READ:
                                chunk = os.read(key.fd, 16385)
                                if not chunk:
                                    raise RuntimeError("model_worker_exited")
                                output.extend(chunk)
                                if len(output) > 16384:
                                    raise RuntimeError("model_output_invalid")
                                if b"\n" in output:
                                    line, extra = output.split(b"\n", 1)
                                    if extra or sent != len(payload):
                                        raise RuntimeError("model_output_invalid")
                                    response = json.loads(line)
                                    if not isinstance(response, dict):
                                        raise RuntimeError("model_output_invalid")
                                    text = response.get("text")
                                    elapsed = response.get("elapsedSeconds")
                                    if response.get("error"):
                                        raise RuntimeError("model_execution_failed")
                                    if (not isinstance(text, str) or not text.strip()
                                            or len(text.encode("utf-8")) > 4096
                                            or type(elapsed) not in (int, float)
                                            or not math.isfinite(elapsed) or elapsed < 0):
                                        raise RuntimeError("model_output_invalid")
                                    return response
            except BaseException:
                self._stop()
                raise
