"""Bounded private HTTP adapter for the unmodified complete C5 entrypoint.

Only the authenticated application Worker can reach this container. Each request
executes the pinned router, its checkpoint and the baseline fallback together.
"""

import atexit
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_model import verify_image_receipt
from warm_worker_client import WarmWorkerClient

MODEL_ROOT = Path(os.environ.get("BITSIGN_MODEL_ROOT", "/model"))
APP_ROOT = Path(__file__).resolve().parent
PIN = json.loads((APP_ROOT / "pin.json").read_text())
MAX_VIDEO_BYTES = 50 * 1024 * 1024
MAX_SECONDS = 30
INFERENCE_TIMEOUT = 600
MODE = os.environ.get("BITSIGN_INFERENCE_MODE", "warm")
if MODE not in ("warm", "oneshot"):
    raise RuntimeError("inference_mode_invalid")
WARM_WORKER = WarmWorkerClient(MODEL_ROOT, timeout_seconds=INFERENCE_TIMEOUT)
atexit.register(WARM_WORKER.close)
SLOT = threading.BoundedSemaphore(1)
READINESS = {"ready": False, "stage": "verifying_model", "modelId": PIN["modelId"],
             "inferenceMode": MODE, "initialization": "on_first_request"}


def startup():
    started = time.monotonic()
    try:
        verify_image_receipt(APP_ROOT / "manifest.json", APP_ROOT / "pin.json", APP_ROOT / "verification.json")
        READINESS.update(ready=True, stage="ready", verifiedSeconds=round(time.monotonic() - started, 3))
    except Exception as error:
        READINESS.update(ready=False, stage="model_verification_failed")
        print(json.dumps({"event": "model_verification_failed", "error": type(error).__name__}), flush=True)


def execute(video: Path, work: Path) -> str:
    if MODE == "warm":
        return WARM_WORKER.translate(video)["text"]
    return execute_oneshot(video, work)


def execute_oneshot(video: Path, work: Path) -> str:
    process = subprocess.Popen(
            [sys.executable, "-B", str(MODEL_ROOT / PIN["entrypoint"]), str(video)],
            cwd=MODEL_ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**os.environ, "UMI_EVALUATION_DEVICE": "cpu"}, start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=INFERENCE_TIMEOUT)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise TimeoutError("inference_timeout") from None
    if process.returncode:
        print(json.dumps({"event": "inference_failed", "exitCode": process.returncode}), flush=True)
        raise RuntimeError("model_execution_failed")
    text = output.decode("utf-8").strip()
    if not text or len(text.encode("utf-8")) > 4096:
        raise RuntimeError("model_output_invalid")
    return text


def admit_video(path: Path, work: Path, *, timeout_seconds=120):
    process = subprocess.Popen([sys.executable, "-B", str(APP_ROOT / "admit_video.py"),
        str(path), str(work / "optimized.mp4")], stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ValueError("video_admission_timeout") from None
    if process.returncode or len(output) > 16384:
        raise ValueError("video_admission_failed")
    result = json.loads(output)
    if result.get("error"):
        raise ValueError(result["error"])
    selected = Path(result.pop("path"))
    if selected not in (path, work / "optimized.mp4"):
        raise ValueError("video_admission_failed")
    return selected, result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def respond(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health":
            return self.respond(404, {"error": "not_found"})
        return self.respond(200 if READINESS["ready"] else 503, dict(READINESS))

    def do_POST(self):
        if self.path != "/translate":
            return self.respond(404, {"error": "not_found"})
        if not READINESS["ready"]:
            return self.respond(503, {"error": "model_not_ready"})
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
        if content_type not in ("video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "application/octet-stream"):
            return self.respond(415, {"error": "video_type_unsupported"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond(400, {"error": "content_length_invalid"})
        if not 0 < length <= MAX_VIDEO_BYTES:
            return self.respond(413, {"error": "video_size_invalid"})
        if not SLOT.acquire(blocking=False):
            return self.respond(429, {"error": "model_busy", "retryAfterSeconds": 5})
        started = time.monotonic()
        try:
            upload_deadline = time.monotonic() + 15
            with tempfile.TemporaryDirectory(prefix="bitsign-job-") as directory:
                work = Path(directory)
                video = work / "input.video"
                remaining = length
                with video.open("wb") as target:
                    while remaining:
                        upload_remaining = upload_deadline - time.monotonic()
                        if upload_remaining <= 0:
                            raise ValueError("upload_timeout")
                        self.connection.settimeout(upload_remaining)
                        try:
                            piece = self.rfile.read(min(1024 * 1024, remaining))
                        except TimeoutError:
                            raise ValueError("upload_timeout") from None
                        if not piece:
                            raise ValueError("upload_interrupted")
                        target.write(piece)
                        remaining -= len(piece)
                selected, admission = admit_video(video, work)
                text = execute(selected, work)
                return self.respond(200, {"text": text, "modelId": PIN["modelId"],
                    "elapsedSeconds": round(time.monotonic() - started, 3),
                    "durationSeconds": round(admission["durationSeconds"], 3), "preprocessing": admission})
        except ValueError as error:
            return self.respond(422, {"error": str(error)})
        except TimeoutError:
            return self.respond(504, {"error": "inference_timeout"})
        except Exception as error:
            print(json.dumps({"event": "request_failed", "error": type(error).__name__}), flush=True)
            return self.respond(500, {"error": "translation_failed"})
        finally:
            SLOT.release()

    def log_message(self, template, *args):
        print(json.dumps({"event": "http_request", "message": template % args}), flush=True)


if __name__ == "__main__":
    def stop(_signum, _frame):
        WARM_WORKER.close()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    threading.Thread(target=startup, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
