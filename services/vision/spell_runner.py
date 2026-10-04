#!/usr/bin/env python3
"""Fingerspelled letters from one glasses burst, read off the frozen encoder.

This runs in the pinned runner's own interpreter the way that runner's run.py
does, because the vision service process is standard library only. The frames
go through the same preprocessing translate_path uses and through the same
frozen encoder; the two paths part after the encoder, where a CTC letter head
replaces the autoregressive decode.

--mode picks how the head's frames are read. continuous is the burst path and
collapses repeated labels. slow-spell is the one-still-per-letter path and does
not, because there a repeat is a real double letter.

The head checkpoint comes out of the training scripts, which are not part of
this repository, and is never committed. services/vision/server.py decides
where it is read from.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

# The label set is part of the checkpoint's contract and cannot be read back
# out of the state dict. It mirrors the training scripts, which this service
# cannot import: they are training-only and are not part of this repository.
CHARS = list("abcdefghijklmnopqrstuvwxyz0123456789 ")
BLANK = len(CHARS)

# The two decode paths, chosen by --mode. Continuous collapses repeated labels
# because one letter spans several frames there. Slow-spell must not, because
# each still is one letter.
CONTINUOUS = "continuous"
SLOW_SPELL = "slow-spell"


def _prepare_import(root: Path) -> None:
    for name, value in {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HOME": str(root / "run/hf"),
        "TORCH_HOME": str(root / "run/torch"),
        "MPLCONFIGDIR": str(root / "run/matplotlib"),
        "SHUBERT_DINOV2_SOURCE": str(root / "vendor/dinov2-source"),
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        "OMP_NUM_THREADS": "4",
        "OPENBLAS_NUM_THREADS": "4",
    }.items():
        os.environ[name] = value
    sys.path.insert(0, str(root))


class SpellHead(nn.Module):
    def __init__(self, width: int, n_labels: int) -> None:
        super().__init__()
        self.proj = nn.Linear(width, 512)
        self.rnn = nn.LSTM(512, 384, num_layers=2, bidirectional=True, dropout=0.1, batch_first=True)
        self.out = nn.Linear(768, n_labels)

    def forward(self, packed_input: torch.Tensor, lengths: torch.Tensor) -> torch.Tensor:
        hidden = torch.relu(self.proj(packed_input))
        packed = nn.utils.rnn.pack_padded_sequence(
            hidden, lengths.cpu(), batch_first=True, enforce_sorted=False
        )
        encoded, _ = self.rnn(packed)
        restored, _ = nn.utils.rnn.pad_packed_sequence(encoded, batch_first=True)
        return self.out(restored).log_softmax(-1)


def _collapse(ids: list[int]) -> str:
    chars: list[str] = []
    previous = None
    for idx in ids:
        if idx == BLANK or idx == previous:
            previous = idx
            continue
        chars.append(CHARS[idx])
        previous = idx
    return "".join(chars).strip()


def _per_letter(frames: list[list[float]]) -> str:
    """One letter for every captured still, in order, keeping repeats.

    _collapse is wrong here. Slow-spell holds one deliberate letter per still,
    so collapsing repeats would read the "ll" of "kelly" as a single l. The
    blank is left out of the argmax rather than dropped after it, because the
    head was trained on continuous video where most frames fall between letters
    and blank wins, while here every still is a letter by construction.

    One character comes back per row, and the result is not stripped, so the
    caller can hold letter against still by position.
    """
    return "".join(CHARS[max(range(BLANK), key=lambda label: frame[label])] for frame in frames)


def _load_head(path: Path) -> SpellHead:
    """Build the head from the checkpoint's own shapes."""
    state = torch.load(path, map_location="cpu", weights_only=True)
    try:
        width = int(state["proj.weight"].shape[1])
        n_labels = int(state["out.weight"].shape[0])
    except KeyError as error:
        raise ValueError("checkpoint is not a letter head state dict") from error
    if n_labels != BLANK + 1:
        raise ValueError(f"checkpoint has {n_labels} labels, this build reads {BLANK + 1}")
    head = SpellHead(width, n_labels)
    head.load_state_dict(state)
    head.eval()
    return head


def _streams(runtime, video: Path):
    """The preprocessing translate_path runs, stopping short of the encoder."""
    reader = runtime._video_reader(video)
    frames = reader.get_batch(range(len(reader))).asnumpy()
    landmarks = runtime._video_holistic(
        frames,
        str(runtime.models / "face_landmarker_v2_with_blendshapes.task"),
        str(runtime.models / "hand_landmarker.task"),
    )
    left_frames, right_frames = runtime._hand_extractor.extract_hand_frames(frames, landmarks)
    face_frames = runtime._face_extractor.extract_face_frames(frames, landmarks)
    pose = np.asarray(runtime._process_pose_landmarks(landmarks), dtype=np.float32)
    from runtime import _rgb_crop_frames

    with torch.no_grad():
        left = runtime._hand_model.extract_embeddings_from_frames(_rgb_crop_frames(left_frames))
        right = runtime._hand_model.extract_embeddings_from_frames(_rgb_crop_frames(right_frames))
        face = runtime._face_model.extract_embeddings_from_frames(_rgb_crop_frames(face_frames))
    count = min(len(face), len(left), len(right), len(pose))
    if count < 2:
        return 0, None
    streams = (face[:count], left[:count], right[:count], pose[:count])
    return count, tuple(
        torch.tensor(stream, dtype=torch.float32).unsqueeze(0).to(runtime.device)
        for stream in streams
    )


def _hidden(runtime, streams) -> torch.Tensor:
    """One pass of the frozen encoder. The decoder is never entered."""
    face, left, right, pose = streams
    encoder = runtime._translator.encoder
    encoder.eval()
    with torch.no_grad():
        return encoder(
            face_features=face,
            left_hand_features=left,
            right_hand_features=right,
            pose_features=pose,
            return_dict=True,
        ).last_hidden_state[0].detach().cpu()


def _spell(head: SpellHead, hidden: torch.Tensor, mode: str) -> str:
    # The head stays on the CPU. It is small, the burst is a handful of frames,
    # and the packed LSTM is the one op in this stack that MPS would fall back
    # on anyway.
    stream = hidden.unsqueeze(0)
    lengths = torch.tensor([stream.shape[1]], dtype=torch.long)
    with torch.no_grad():
        scores = head(stream, lengths)[0]
    if mode == SLOW_SPELL:
        return _per_letter(scores.tolist())
    return _collapse(scores.argmax(-1).tolist())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--device", choices=("mps", "cpu"), default="mps")
    parser.add_argument("--mode", choices=(CONTINUOUS, SLOW_SPELL), default=CONTINUOUS)
    args = parser.parse_args()
    root = args.root.resolve()
    _prepare_import(root)
    started = time.monotonic()
    with contextlib.redirect_stdout(sys.stderr):
        from runtime import SHuBERTInferenceRuntime

        head = _load_head(args.head.resolve(strict=True))
        runtime = SHuBERTInferenceRuntime(root, device=args.device)
        count, streams = _streams(runtime, args.video.resolve(strict=True))
        spelled = "" if streams is None else _spell(head, _hidden(runtime, streams), args.mode)
    answer = {
        "spelled": spelled,
        "frames": count,
        "mode": args.mode,
        "seconds": time.monotonic() - started,
    }
    if streams is None:
        answer["reason"] = "the burst did not hold two usable frames"
    print(json.dumps(answer))


if __name__ == "__main__":
    main()
