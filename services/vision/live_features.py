"""English from per-frame C5 features, for Live on bitsign.umi.vision.

The Live page computes the C5 model's per-frame inputs in the browser
(services/live-web/public/live/features.js) and sends only those, never video.
This handler runs the last stage of SHuBERTInferenceRuntime.translate_path on
them, so a host that already keeps the runtime warm can answer in about two
seconds instead of decoding and re-analysing a clip.

Request body (application/x-bitsign-features), little-endian:

  4 bytes   magic b"BSF1"
  uint32    frame count N
  float16   face   N x 384
  float16   left   N x 384
  float16   right  N x 384
  float32   pose   N x 14     float32 keeps the -9999 "not seen" marker exact

Nothing in the request identifies the signer beyond these numbers, and the
handler keeps nothing after it answers.
"""

from __future__ import annotations

import struct
from typing import Any

import numpy as np

MAGIC = b"BSF1"
CONTENT_TYPE = "application/x-bitsign-features"
EMBEDDING = 384
POSE = 14
MIN_FRAMES = 2
# 30 seconds at 15 fps, the same ceiling as the demo's video uploads.
MAX_FRAMES = 450
MISSING = -9999.0


class FeaturesError(ValueError):
    """The body is not a well-formed features request."""


def expected_size(frames: int) -> int:
    return len(MAGIC) + 4 + frames * (3 * EMBEDDING * 2 + POSE * 4)


def decode(body: bytes) -> dict[str, np.ndarray]:
    if len(body) < len(MAGIC) + 4 or body[: len(MAGIC)] != MAGIC:
        raise FeaturesError("not a BitSign features body")
    (frames,) = struct.unpack_from("<I", body, len(MAGIC))
    if not MIN_FRAMES <= frames <= MAX_FRAMES:
        raise FeaturesError(f"frame count must be {MIN_FRAMES} to {MAX_FRAMES}")
    if len(body) != expected_size(frames):
        raise FeaturesError("body size does not match its frame count")
    offset = len(MAGIC) + 4
    streams: dict[str, np.ndarray] = {}
    for name in ("face", "left", "right"):
        count = frames * EMBEDDING
        streams[name] = (
            np.frombuffer(body, dtype="<f2", count=count, offset=offset)
            .astype(np.float32)
            .reshape(frames, EMBEDDING)
        )
        offset += count * 2
    streams["pose"] = np.frombuffer(body, dtype="<f4", count=frames * POSE, offset=offset).reshape(
        frames, POSE
    ).copy()
    for name, values in streams.items():
        if not np.isfinite(values).all():
            raise FeaturesError(f"{name} holds non-finite values")
    pose = streams["pose"]
    if not ((np.abs(pose) < 1000) | (pose == MISSING)).all():
        raise FeaturesError("pose values are out of range")
    return streams


def encode(face: np.ndarray, left: np.ndarray, right: np.ndarray, pose: np.ndarray) -> bytes:
    frames = len(face)
    return b"".join(
        [
            MAGIC,
            struct.pack("<I", frames),
            np.asarray(face, dtype="<f2").tobytes(),
            np.asarray(left, dtype="<f2").tobytes(),
            np.asarray(right, dtype="<f2").tobytes(),
            np.asarray(pose, dtype="<f4").tobytes(),
        ]
    )


def translate(runtime: Any, streams: dict[str, np.ndarray]) -> str:
    """The generate step of translate_path, on a warm SHuBERTInferenceRuntime."""
    import torch

    def tensor(name: str):
        return torch.tensor(streams[name], dtype=torch.float32).unsqueeze(0).to(runtime.device)

    kwargs: dict[str, Any] = {
        "face_features": tensor("face"),
        "left_hand_features": tensor("left"),
        "right_hand_features": tensor("right"),
        "pose_features": tensor("pose"),
        "max_length": runtime.generation_max_length,
        "num_beams": runtime.generation_num_beams,
        "early_stopping": True,
        "pad_token_id": runtime._tokenizer.pad_token_id,
        "eos_token_id": runtime._tokenizer.eos_token_id,
    }
    if runtime.generation_length_penalty is not None:
        kwargs["length_penalty"] = runtime.generation_length_penalty
    if runtime.generation_no_repeat_ngram_size is not None:
        kwargs["no_repeat_ngram_size"] = runtime.generation_no_repeat_ngram_size
    with runtime._model_execution_slots, torch.no_grad():
        ids = runtime._translator.generate(**kwargs)
    return runtime._tokenizer.decode(ids[0], skip_special_tokens=True).strip()
