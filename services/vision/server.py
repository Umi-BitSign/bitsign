#!/usr/bin/env python3
"""Glasses endpoint for the published UMI SN78 model.

Frame and Halo send a few JPEG stills. The published model,
umi-s1-public-finetune-v1, translates skeletal motion from its landmark
extractor. This service returns that model's English line when one exists.
It does not invent a sentence, and it does not store the burst.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_ID = "umi-s1-public-finetune-v1"
HOST = "127.0.0.1"
PORT = 8091
MAX_BODY = 8 * 1024 * 1024

STILL_REASON = (
    "The UMI S1 model translates skeletal motion, not these raw stills. "
    "No English was produced."
)


def _valid_motion(motion: object, frame_mask: object) -> bool:
    if not isinstance(motion, list) or len(motion) != 120:
        return False
    if not isinstance(frame_mask, list) or len(frame_mask) != 120:
        return False
    if any(not isinstance(row, list) or len(row) != 1184 for row in motion):
        return False
    return all(isinstance(flag, int) and flag in (0, 1) for flag in frame_mask)


def _s1_line(motion: list, frame_mask: list) -> str:
    """Return the published model's line, or an empty string when it cannot run."""
    try:
        import sys
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(root / "model" / "src"))
        from bitsign_motion.s1_portable_runtime import load_s1_portable_bundle
        import json
        import zipfile

        archive = root / "model" / "release" / "umi-s1-public-finetune-v1-portable.zip"
        bundle = root / "model" / "release" / "bundle"
        if not (bundle / "model.safetensors").is_file():
            bundle.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive) as packed:
                packed.extractall(bundle)
        identity = json.loads((bundle / "inference-identity.json").read_text())
        runtime = load_s1_portable_bundle(
            bundle,
            expected_inference_revision=identity["inference_revision"],
        )
        import numpy as np

        result = runtime.infer_motion(
            np.asarray(motion, dtype=np.float32),
            np.asarray(frame_mask, dtype=np.int32),
        )
    except Exception:
        return ""
    text = getattr(result, "text", "")
    return text.strip() if isinstance(text, str) else ""


def translate(payload: dict[str, Any]) -> dict[str, str]:
    """Return the phone contract. English is empty unless the model returns a line."""
    if "motion" in payload or "frame_mask" in payload:
        motion = payload.get("motion")
        frame_mask = payload.get("frame_mask")
        if not _valid_motion(motion, frame_mask):
            raise ValueError("motion must be 120 frames of 1184 numbers with a 120-value mask")
        line = _s1_line(motion, frame_mask)
        if not line:
            return {
                "english": "",
                "model": MODEL_ID,
                "reason": "UMI S1 did not return an English line.",
            }
        return {"english": line, "model": MODEL_ID}
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames or not all(isinstance(item, str) and item for item in frames):
        raise ValueError("frames must be a non-empty list of base64 stills")
    if payload.get("mime") not in (None, "image/jpeg"):
        raise ValueError("frames must be image/jpeg")
    return {"english": "", "model": MODEL_ID, "reason": STILL_REASON}


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
        self._send(200, {"english": "", "model": MODEL_ID, "reason": "UMI S1 is the configured model."})

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
