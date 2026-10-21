"""Verify the published native C5 bundle without changing any signed input."""

import hashlib
import json
import stat
import sys
from pathlib import Path, PurePosixPath

VERIFIER = "bitsign-native-c5-image-verifier/1"


def binding(manifest_path: Path, pin_path: Path):
    pin = json.loads(pin_path.read_text())
    manifest = json.loads(manifest_path.read_text())
    canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    identity = hashlib.sha256(b"umi-open-competition-v1\0" + canonical).hexdigest()
    if identity != pin["modelId"]:
        raise ValueError("model_manifest_identity_mismatch")
    return pin, manifest, identity


def verify(model_root: Path, manifest_path: Path, pin_path: Path) -> dict:
    pin, manifest, identity = binding(manifest_path, pin_path)
    total = 0
    for item in manifest["files"]:
        relative = PurePosixPath(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("model_manifest_path_invalid")
        path = model_root / relative
        if any(parent.is_symlink() for parent in [path, *path.parents] if parent != model_root.parent):
            raise ValueError("model_symlink_rejected")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != item["size_bytes"]:
            raise ValueError("model_file_size_mismatch")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for piece in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(piece)
        if digest.hexdigest() != item["sha256"]:
            raise ValueError("model_file_digest_mismatch:" + item["path"])
        total += info.st_size
    if len(manifest["files"]) != pin["modelFiles"] or total != pin["modelBytes"]:
        raise ValueError("model_inventory_mismatch")
    return {"modelId": identity, "runtimeId": pin["runtimeId"], "verifier": VERIFIER,
            "files": len(manifest["files"]), "bytes": total, "verified": True,
            "authority": "immutable_container_image_build"}


def verify_image_receipt(manifest_path: Path, pin_path: Path, receipt_path: Path):
    """Reuse the build verdict; the image fixes payload bytes and verifier code."""
    pin, manifest, identity = binding(manifest_path, pin_path)
    receipt = json.loads(receipt_path.read_text())
    expected = {"modelId": identity, "runtimeId": pin["runtimeId"], "verifier": VERIFIER,
                "files": pin["modelFiles"], "bytes": pin["modelBytes"], "verified": True,
                "authority": "immutable_container_image_build"}
    if receipt != expected or len(manifest["files"]) != pin["modelFiles"]:
        raise ValueError("model_build_receipt_missing_or_damaged_rebuild_required")
    return receipt


if __name__ == "__main__":
    print(json.dumps(verify(*(Path(p) for p in sys.argv[1:]))))
