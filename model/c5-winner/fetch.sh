#!/bin/bash
# Run from the bitsign repository. All disposable files go under the one supplied
# task root. The verified artifact is retained for the container build consumer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_ROOT="${1:?Pass the recorded task-scoped temporary root}"
[[ "$TASK_ROOT" = /* ]] || { echo 'Task root must be absolute' >&2; exit 2; }
UMI_SOURCE="${UMI_SOURCE:-$ROOT/../umi}"
mkdir -p "$TASK_ROOT/model-runtime"
SCRATCH="$TASK_ROOT/model-runtime"
export UV_CACHE_DIR="$SCRATCH/uv-cache"
if [[ ! -x "$SCRATCH/download-venv/bin/python" ]]; then
  uv venv "$SCRATCH/download-venv"
fi
uv pip install --python "$SCRATCH/download-venv/bin/python" \
  'httpx>=0.28,<1' 'pydantic>=2.13,<3' py-ecc==8.0.0 rfc8785 regex typing-extensions
PYTHONPATH="$UMI_SOURCE/src" "$SCRATCH/download-venv/bin/python" \
  -m umi.competition_cohort_public_download_cli \
  --api https://api.umi.vision \
  --cohort 5dab3bfb836a91898f010bd229115e3e1c0406c3e17498d3b3b1975adab71428 \
  --model 00a74422d9c17a4add1c562bcf54abe4111f26288a33c5168ed458b13b233b91 \
  --output "$ROOT/model/c5-winner/artifact"
RUNTIME="$SCRATCH/offline-cpu-runtime.oci.tar"
IMAGE='localhost/umi-community-cpu-amd64-diagnostic@sha256:4a7b543559506e7b8c83605d1676c114b06710e287a2349e89c0d995d093f8ec'
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
if [[ ! -f "$RUNTIME" ]] || [[ "$(wc -c < "$RUNTIME")" -ne 2215539200 ]]; then
  curl -fL --retry 4 -C - \
  https://artifacts.umi.vision/v1/runtimes/f025ceb38cacc5c71873d94b8f2010aae10a0193a0e410e410a202f4def3b7b0/offline-cpu-runtime.oci.tar \
  -o "$RUNTIME"
fi
python3 - "$RUNTIME" <<'PY'
import hashlib,sys
digest=hashlib.sha256()
with open(sys.argv[1], 'rb') as source:
    for block in iter(lambda: source.read(1024*1024), b''):
        digest.update(block)
assert digest.hexdigest() == '37e09eae8f862d75ddc25fe6b3eadc2fa8d9d7c6b03bfe5d7af4da6b3f97974a', 'runtime archive digest mismatch'
PY
docker load --input "$RUNTIME"
fi
docker tag \
  "$IMAGE" \
  bitsign-c5-runtime:f025ceb38cacc5c71873d94b8f2010aae10a0193a0e410e410a202f4def3b7b0
python3 "$ROOT/services/web-inference/verify_model.py" "$ROOT/model/c5-winner/artifact/model" \
  "$ROOT/model/c5-winner/manifest.json" "$ROOT/model/c5-winner/pin.json"
