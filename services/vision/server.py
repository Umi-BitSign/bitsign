#!/usr/bin/env python3
"""Glasses endpoint for the latest public UMI model with open weights.

The active model is model/ACTIVE.json. English is that runner's text
field when a burst finishes. An empty string means no line came back.
This service does not invent a sentence and does not store the burst.

/translate runs that runner's continuous path. /fingerspell reads the same
frozen encoder with a CTC letter head instead, for the turn-based glasses
interaction, and refuses the burst without a consent assertion. Its "mode"
field picks the decode: "continuous" for a burst, "slow-spell" for one still
per deliberately held letter.
"""

from __future__ import annotations

import base64
import json
import os
import platform
import shutil
import subprocess
import tempfile
import threading
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
# Slow-spell sends one still per letter, so its ceiling is a word length rather
# than a burst length. The encoder reads one timestep per still and the
# preprocessing needs two frames, so two letters is the floor.
MAX_SLOW_SPELL_FRAMES = 12
MIN_SLOW_SPELL_FRAMES = 2
INFERENCE_TIMEOUT = 300
SPELL_TIMEOUT = 180
WEIGHTS = Path("models/checkpoint-11625/model.safetensors")

# The letter head rides on the same frozen encoder, so it is a separate
# checkpoint rather than a separate model. It is not in the pinned archive and
# is never committed. Drop spell_head_fsboard.pt here, or point
# BITSIGN_SPELL_HEAD at it.
SPELL_HEAD = ROOT / "model" / "heads" / "spell_head_fsboard.pt"
SPELL_MODEL_ID = f"{MODEL_ID}+spell-head"
SPELL_RUNNER = Path(__file__).resolve().parent / "spell_runner.py"
VENV_PYTHON = Path(".runtime/bin/python")

# A glasses burst is read once and dropped. It is not retained and it never
# reaches the corpus, so the route refuses a request that asks for either.
CONSENT_SCOPE = "live-translation-only"

# Fluent fingerspelling runs at four to six letters a second and the camera is
# configured at 1 fps, so a continuous burst never observes most of the letters
# and cannot emit more labels than it has stills. slow-spell is the phone
# prompting for one letter at a time and sending one still for each. It is not
# natural signing and nothing here presents it as if it were.
SPELL_MODE_CONTINUOUS = "continuous"
SPELL_MODE_SLOW = "slow-spell"
SPELL_MODES = (SPELL_MODE_CONTINUOUS, SPELL_MODE_SLOW)

MISSING_WEIGHTS = (
    "The open community baseline is selected, and its weights are not installed. "
    "No English was produced."
)
NO_LINE = "The community baseline did not return an English line."
MISSING_SPELL_HEAD = (
    "The fingerspelling head is not installed. Put the checkpoint at "
    "model/heads/spell_head_fsboard.pt or set BITSIGN_SPELL_HEAD. No letters were read."
)
MISSING_RUNTIME = (
    "The runner's .runtime is not built. Run one translation first, or "
    "model/community-baseline-v0.2/run.sh, to build it. No letters were read."
)
NO_LETTERS = "The fingerspelling head did not read any letters from this burst."
NO_CONSENT = "No consent was recorded for this capture, so the burst was not read."
TOO_FEW_LETTERS = (
    "Slow-spell reads one letter per still and needs at least "
    f"{MIN_SLOW_SPELL_FRAMES}. No letters were read."
)
ALLOWED_ORIGINS = {"https://bitsign.ai", "https://www.bitsign.ai"}
_INFERENCE = threading.Lock()


def weights_ready(runner: Path | None = None) -> bool:
    return ((runner or RUNNER) / WEIGHTS).is_file()


def spell_head(head: Path | None = None) -> Path:
    if head is not None:
        return head
    configured = os.environ.get("BITSIGN_SPELL_HEAD", "").strip()
    return Path(configured) if configured else SPELL_HEAD


def spell_head_ready(head: Path | None = None) -> bool:
    return spell_head(head).is_file()


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


def _burst(payload: dict[str, Any], limit: int = MAX_FRAMES) -> list[bytes]:
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames or not all(isinstance(item, str) and item for item in frames):
        raise ValueError("frames must be a non-empty list of base64 stills")
    if len(frames) > limit:
        raise ValueError("too many stills")
    if payload.get("mime") not in (None, "image/jpeg"):
        raise ValueError("frames must be image/jpeg")
    return _jpegs(frames)


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
    with _INFERENCE, tempfile.TemporaryDirectory(prefix="bitsign-") as tmp:
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


def _spelled_letters(images: list[bytes], runner: Path, head: Path, mode: str) -> tuple[str, int]:
    with _INFERENCE, tempfile.TemporaryDirectory(prefix="bitsign-spell-") as tmp:
        video = Path(tmp) / "burst.mp4"
        _burst_to_mp4(images, video)
        completed = subprocess.run(
            [
                str(runner / VENV_PYTHON), "-B", str(SPELL_RUNNER),
                "--root", str(runner), "--head", str(head), "--device", _device(),
                "--mode", mode,
                str(video),
            ],
            cwd=runner,
            capture_output=True,
            text=True,
            timeout=SPELL_TIMEOUT,
        )
    if completed.returncode != 0 or not completed.stdout.strip():
        return "", 0
    try:
        parsed = json.loads(completed.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError:
        return "", 0
    if not isinstance(parsed, dict):
        return "", 0
    letters = parsed.get("spelled")
    frames = parsed.get("frames")
    if not isinstance(letters, str):
        letters = ""
    elif mode != SPELL_MODE_SLOW:
        # Slow-spell holds one character per still, so trimming a space label
        # would shift every letter after it out of position.
        letters = letters.strip()
    return (
        letters,
        frames if isinstance(frames, int) and not isinstance(frames, bool) else 0,
    )


def _consented(payload: dict[str, Any]) -> bool:
    """Read the phone's consent assertion.

    The glasses cannot signal capture to the person in front of them, so the
    phone is the consent surface. M2 replaces this with a signed session token
    from the relay; until then the assertion is the phone's own, and the route
    is unusable without it.
    """
    consent = payload.get("consent")
    if not isinstance(consent, dict):
        return False
    session = consent.get("session")
    return (
        consent.get("granted") is True
        and consent.get("scope") == CONSENT_SCOPE
        and isinstance(session, str)
        and bool(session.strip())
    )


def _spell_mode(payload: dict[str, Any]) -> str:
    """Which decode the burst is asking for. Absent means the continuous burst.

    The mode is read off the request rather than guessed from the frame count,
    because four stills of continuous signing and four deliberately held
    letters are the same burst shape and want opposite decoding.
    """
    mode = payload.get("mode")
    if mode is None:
        return SPELL_MODE_CONTINUOUS
    if mode not in SPELL_MODES:
        raise ValueError(f"mode must be one of {', '.join(SPELL_MODES)}")
    return mode


def _spell_answer(
    letters: str,
    frames: int,
    mode: str = SPELL_MODE_CONTINUOUS,
    error: str = "",
    reason: str = "",
) -> dict[str, Any]:
    # provisional is never false. The locked-panel spelling error was measured on
    # studio video, and a head-mounted still at 67 px of hand is harder than that.
    # Slow-spell is further out still: the head never saw deliberately held
    # letters in training. No figure is returned, because none is known.
    answer: dict[str, Any] = {
        "english": letters,
        "spelled": letters,
        "model": SPELL_MODEL_ID,
        "mode": mode,
        "frames": frames,
        "provisional": True,
        "retained": False,
    }
    if mode == SPELL_MODE_SLOW:
        # Positional: letters[i] is what the phone asked for at position i, so
        # one wrong letter can be fixed without spelling the word again.
        answer["letters"] = list(letters)
    if error:
        answer["error"] = error
        answer["reason"] = reason
    return answer


def fingerspell(
    payload: dict[str, Any],
    runner: Path | None = None,
    head: Path | None = None,
) -> dict[str, Any]:
    """Return one spelled turn. Nothing here keeps the burst past the answer."""
    if payload.get("retain") or payload.get("corpus"):
        raise ValueError("A glasses burst is read for this turn only. It is not retained.")
    mode = _spell_mode(payload)
    if not _consented(payload):
        return _spell_answer("", 0, mode, "consent_required", NO_CONSENT)
    slow = mode == SPELL_MODE_SLOW
    images = _burst(payload, MAX_SLOW_SPELL_FRAMES if slow else MAX_FRAMES)
    if slow and len(images) < MIN_SLOW_SPELL_FRAMES:
        return _spell_answer("", len(images), mode, "too_few_letters", TOO_FEW_LETTERS)
    root = runner or RUNNER
    checkpoint = spell_head(head)
    if not weights_ready(root):
        return _spell_answer("", 0, mode, "weights_missing", MISSING_WEIGHTS)
    if not checkpoint.is_file():
        return _spell_answer("", 0, mode, "spell_head_missing", MISSING_SPELL_HEAD)
    if not (root / VENV_PYTHON).is_file():
        return _spell_answer("", 0, mode, "runtime_missing", MISSING_RUNTIME)
    try:
        letters, frames = _spelled_letters(images, root, checkpoint, mode)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return _spell_answer("", 0, mode, "no_letters", NO_LETTERS)
    if not letters.strip():
        return _spell_answer("", frames, mode, "no_letters", NO_LETTERS)
    return _spell_answer(letters, frames, mode)


def translate(payload: dict[str, Any], runner: Path | None = None) -> dict[str, str]:
    """Return the phone contract. English is empty unless the active model returns a line."""
    if "motion" in payload or "frame_mask" in payload:
        raise ValueError("The active model reads a video. Skeletal tensors are not accepted.")
    images = _burst(payload)
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
    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        origin = self.headers.get("origin", "")
        self.send_response(status)
        if origin in ALLOWED_ORIGINS:
            self.send_header("access-control-allow-origin", origin)
            self.send_header("vary", "origin")
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("origin", "")
        self.send_response(204)
        if origin in ALLOWED_ORIGINS:
            self.send_header("access-control-allow-origin", origin)
            self.send_header("access-control-allow-methods", "POST, GET, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")
            self.send_header("vary", "origin")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/health":
            self._send(404, {"english": "", "model": MODEL_ID, "reason": "Unknown path."})
            return
        if weights_ready():
            reason = "The open community baseline is installed."
        else:
            reason = "The open community baseline is selected. Weights are not installed."
        if spell_head_ready():
            reason += " The fingerspelling head is installed."
        else:
            reason += " The fingerspelling head is not installed."
        self._send(200, {"english": "", "model": MODEL_ID, "reason": reason})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ("/translate", "/fingerspell"):
            self._send(404, {"english": "", "model": MODEL_ID, "reason": "Unknown path."})
            return
        model = SPELL_MODEL_ID if path == "/fingerspell" else MODEL_ID
        length = int(self.headers.get("content-length", "0") or "0")
        if length < 1 or length > MAX_BODY:
            self._send(400, {"english": "", "model": model, "reason": "Request size is not accepted."})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("body must be an object")
            if path == "/fingerspell":
                answer = fingerspell(payload)
                self._send(403 if answer.get("error") == "consent_required" else 200, answer)
                return
            self._send(200, translate(payload))
        except (json.JSONDecodeError, ValueError, UnicodeError):
            self._send(400, {"english": "", "model": model, "reason": "The burst could not be read."})

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
