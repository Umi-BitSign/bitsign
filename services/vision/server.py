#!/usr/bin/env python3
"""Glasses endpoint for the latest public UMI model with open weights.

The active model is model/ACTIVE.json. English is that runner's text
field when a burst finishes. An empty string means no line came back.
This service does not invent a sentence and does not store the burst.
"""

from __future__ import annotations

import base64
import json
import os
import platform
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PIN = json.loads((ROOT / "model" / "ACTIVE.json").read_text())
MODEL_ID = PIN["id"]
RUNNER = ROOT / PIN["runner"]
HOST = "127.0.0.1"
PORT = 8091
MAX_BODY = 8 * 1024 * 1024
MAX_FRAMES = 8
MAX_STILL = 2 * 1024 * 1024
INFERENCE_TIMEOUT = 300
WEIGHTS = Path("models/checkpoint-11625/model.safetensors")

MISSING_WEIGHTS = (
    "The open community baseline is selected, and its weights are not installed. "
    "No English was produced."
)
NO_LINE = "The community baseline did not return an English line."


def weights_ready(runner: Path | None = None) -> bool:
    return ((runner or RUNNER) / WEIGHTS).is_file()


def _device() -> str:
    forced = os.environ.get("BITSIGN_DEVICE", "")
    if forced in ("cpu", "mps"):
        return forced
    return "mps" if platform.system() == "Darwin" else "cpu"


def _jpegs(frames: list[str]) -> list[bytes]:
    images: list[bytes] = []
    for item in frames:
        try:
            raw = base64.b64decode(item, validate=True)
        except Exception as error:
            raise ValueError("frames must be base64 JPEG stills") from error
        if len(raw) < 3 or not raw.startswith(b"\xff\xd8\xff") or len(raw) > MAX_STILL:
            raise ValueError("frames must be image/jpeg")
        images.append(raw)
    return images


def _burst_to_mp4(images: list[bytes], dest: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    folder = dest.parent / "frames"
    folder.mkdir()
    for index, raw in enumerate(images):
        (folder / f"frame-{index:02d}.jpg").write_bytes(raw)
    subprocess.run(
        [
            ffmpeg, "-y", "-loglevel", "error", "-framerate", "1",
            "-i", str(folder / "frame-%02d.jpg"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(dest),
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )


def _baseline_line(images: list[bytes], runner: Path) -> str:
    script = runner / "run.sh"
    if not script.is_file():
        raise RuntimeError("baseline runner is missing")
    with tempfile.TemporaryDirectory(prefix="bitsign-") as tmp:
        video = Path(tmp) / "burst.mp4"
        _burst_to_mp4(images, video)
        completed = subprocess.run(
            ["bash", str(script), "--device", _device(), str(video)],
            cwd=runner,
            capture_output=True,
            text=True,
            timeout=INFERENCE_TIMEOUT,
        )
    if completed.returncode != 0 or not completed.stdout.strip():
        return ""
    try:
        parsed = json.loads(completed.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError:
        return ""
    text = parsed.get(PIN["english_field"]) if isinstance(parsed, dict) else None
    return text.strip() if isinstance(text, str) else ""


def translate(payload: dict[str, Any], runner: Path | None = None) -> dict[str, str]:
    """Return the phone contract. English is empty unless the active model returns a line."""
    if "motion" in payload or "frame_mask" in payload:
        raise ValueError("The active model reads a video. Skeletal tensors are not accepted.")
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames or not all(isinstance(item, str) and item for item in frames):
        raise ValueError("frames must be a non-empty list of base64 stills")
    if len(frames) > MAX_FRAMES:
        raise ValueError("too many stills")
    if payload.get("mime") not in (None, "image/jpeg"):
        raise ValueError("frames must be image/jpeg")
    images = _jpegs(frames)
    root = runner or RUNNER
    if not weights_ready(root):
        return {"english": "", "model": MODEL_ID, "reason": MISSING_WEIGHTS}
    try:
        line = _baseline_line(images, root)
    except ValueError:
        raise
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return {"english": "", "model": MODEL_ID, "reason": NO_LINE}
    if not line:
        return {"english": "", "model": MODEL_ID, "reason": NO_LINE}
    return {"english": line, "model": MODEL_ID}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/health":
            self._send(404, {"english": "", "model": MODEL_ID, "reason": "Unknown path."})
            return
        if weights_ready():
            reason = "The open community baseline is installed."
        else:
            reason = "The open community baseline is selected. Weights are not installed."
        self._send(200, {"english": "", "model": MODEL_ID, "reason": reason})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/translate":
            self._send(404, {"english": "", "model": MODEL_ID, "reason": "Unknown path."})
            return
        length = int(self.headers.get("content-length", "0") or "0")
        if length < 1 or length > MAX_BODY:
            self._send(400, {"english": "", "model": MODEL_ID, "reason": "Request size is not accepted."})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("body must be an object")
            self._send(200, translate(payload))
        except (json.JSONDecodeError, ValueError, UnicodeError):
            self._send(400, {"english": "", "model": MODEL_ID, "reason": "The burst could not be read."})

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
