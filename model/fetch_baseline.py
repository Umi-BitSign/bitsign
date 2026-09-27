#!/usr/bin/env python3
"""Download the pinned open-weight archive and check it before unpacking."""

from __future__ import annotations

import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "model" / "ACTIVE.json").read_text())
ARCHIVE = PIN["archive"]
DEST = ROOT / "model" / "weights"
RUNNER = ROOT / PIN["runner"]
CHUNK = 1024 * 1024


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    with urllib.request.urlopen(url) as response, partial.open("wb") as handle:
        shutil.copyfileobj(response, handle, length=CHUNK)
    partial.replace(dest)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _part_checksums(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        found[Path(name.strip()).name] = digest
    return found


def _weight_relative(name: str) -> Path | None:
    parts = Path(name).parts
    if len(parts) < 2 or parts[1] != "models":
        return None
    return Path(*parts[1:])


def _extract_models(archive: Path) -> None:
    with zipfile.ZipFile(archive) as packed:
        members = [name for name in packed.namelist() if _weight_relative(name) is not None]
        if not members:
            raise SystemExit("archive does not contain a models directory")
        for name in members:
            relative = _weight_relative(name)
            if relative is None:
                continue
            if name.endswith("/"):
                (RUNNER / relative).mkdir(parents=True, exist_ok=True)
                continue
            target = RUNNER / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with packed.open(name) as source, target.open("wb") as handle:
                shutil.copyfileobj(source, handle, length=CHUNK)


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    sums_path = DEST / "SHA256SUMS.parts"
    _download(ARCHIVE["parts_sha256"], sums_path)
    expected = _part_checksums(sums_path.read_text())
    parts: list[Path] = []
    for url in ARCHIVE["parts"]:
        name = Path(url).name
        path = DEST / name
        if not path.is_file() or _sha256(path) != expected.get(name):
            _download(url, path)
        digest = _sha256(path)
        if digest != expected[name]:
            raise SystemExit(f"{name} checksum does not match the release")
        parts.append(path)
    archive = DEST / ARCHIVE["filename"]
    if not archive.is_file() or archive.stat().st_size != ARCHIVE["bytes"] or _sha256(archive) != ARCHIVE["sha256"]:
        with archive.open("wb") as handle:
            for part in parts:
                with part.open("rb") as source:
                    shutil.copyfileobj(source, handle, length=CHUNK)
    if archive.stat().st_size != ARCHIVE["bytes"]:
        raise SystemExit("archive size does not match the pin")
    if _sha256(archive) != ARCHIVE["sha256"]:
        raise SystemExit("archive checksum does not match the pin")
    _extract_models(archive)
    weights = RUNNER / "models" / "checkpoint-11625" / "model.safetensors"
    if not weights.is_file():
        raise SystemExit("weights did not unpack")
    print(f"installed {PIN['id']} ({weights.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
