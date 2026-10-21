# C5 demo inference

This dedicated, wallet-free container executes the complete Trupan UID104 C5
bundle. The native model, submission, cohort and runtime identities are pinned in
`model/c5-winner/pin.json`; its published 465-file manifest is retained beside it.
The original `umi_inference.py` stays unchanged, including both fingerspelling
router stages, its learned checkpoint, and the baseline fallback. A serialized
warm worker calls that exact `main` function, caching only identical baseline
construction and restoring its original generation method before each call.
It keeps the fingerspelling subprocess isolated on every request. Repeat calls
may reassert the original torch interop-thread setting; other settings fail.
Results are
clip-level text; no word timing or confidence is invented.

From the repository root, fetch resumably with
`bash model/c5-winner/fetch.sh /absolute/recorded/task-root`. This uses the adjacent
UMI checkout's public-download client, preserving its renewable capabilities,
bounded transfer, durable native file verification and explicit repair semantics.
It installs only small protocol/download dependencies under the supplied root.
The ignored `model/c5-winner/artifact` directory is a retained deployment build
input. Never commit credentials, model tensors, or expiring signed URLs.

Build with `docker build --platform linux/amd64 -f services/web-inference/Dockerfile -t bitsign-c5-demo .`.
The Docker context is the repository root. Production configuration uses an
immutable Cloudflare Registry image digest. Publish a rebuilt image, check its
platform configuration against the qualified local image, then update that digest
in `web/wrangler.jsonc`; normal Worker deployments reuse it.

Docker 29's containerd image store can time out after 30 seconds while a registry
finalizes a multi-gigabyte layer (https://github.com/moby/moby/issues/53700).
If that occurs, keep the qualified image and use a verified `crane` release
with an OCI layout directory. A Docker 29 export can contain both raw tar and
gzip layers: interpreting its legacy Docker manifest with `crane push` compresses
some layers twice. A matching image configuration alone does not detect that
mistake. Preserve the OCI descriptors and verify each layer's stored digest and
its decompressed digest against the configuration's `rootfs.diff_ids` before
publication. Publish the validated OCI directory with
`crane push --platform linux/amd64 "$OCI_LAYOUT" "$REGISTRY_IMAGE"`.

Retain the resulting registry manifest and layer-verification receipt. Remove
export/layout scratch when publication and restore coverage finish. No model
source or tensor conversion is required.

 The runtime archive is verified before
import and tagged locally; BuildKit resolves its exact OCI manifest
`4a7b543559506e7b8c83605d1676c114b06710e287a2349e89c0d995d093f8ec`.
The build verifies the complete model once and retains a verdict bound to the
native manifest, runtime, authority and verifier semantics inside the immutable
image. Startup checks that verdict and pin without rereading the tensor payload.
A missing or damaged verdict makes readiness fail and requires rebuilding the
image. The HTTP port opens during verification; `/health` returns 503 until it succeeds.
Its response identifies the execution mode and that native initialization occurs
on the first request. A cold process has no preloaded model. The baseline stays
loaded after its first use. `BITSIGN_INFERENCE_MODE=oneshot` provides the complete
unmodified cold path for parity qualification and rollback.

`POST /translate` accepts raw video bytes with a video content type and explicit
`Content-Length`. It returns
`{text, modelId, elapsedSeconds, durationSeconds, preprocessing}`.
The application Worker supplies the stored object's exact size and does not
expose the container directly. Limits are 50 MiB, 30 seconds, a 350-million decoded-pixel budget,
one inference at a time and a 600-second inference deadline. Additional requests
receive 429; the Worker owns durable jobs and retry admission. Every job has one
temporary directory, removed after all outcomes. A timeout kills the inference
process group, including its fingerspelling subprocess. Diagnostics remain out
of the result text.

Use a 4-vCPU, 12-GiB instance for initial deployment and qualify its actual
latency. Local Apple Silicon measurements run under x86 emulation and cannot
establish Cloudflare throughput. Camera denial, unsupported decoders, invalid
videos, upload interruption and inference timeout are explicit failures. Model
quality is limited: the gallery must retain actual outputs and attribution, and
be selected from licensed public examples outside protected evaluation inputs.

## Qualification retained on 2026-10-21

`qualification/` contains the exact download/resume evidence, full HTTP admission
checks, warm/cold parity and all six actual gallery predictions. All tests used
the pinned public runtime and unchanged model source under Linux amd64 emulation,
4 vCPU and 12 GiB. Two independently executed paths agreed on the fallback clip
(`Formations.`) and the stage-1 fingerspelling clip (`thesunrisesintheeast`). The
final HTTP image then returned `Formations.` on both first and repeated fallback
requests (34.824 and 27.150 seconds). Six 7-second fingerspelling examples took
12.679–16.147 seconds through the actual HTTP adapter. These are local emulation
measurements, not a forecast of native Cloudflare CPU performance.

Ten focused adapter tests cover exact original-main behavior, stage-1 lazy
baseline avoidance, stage-2 preservation, unchanged decoding overrides, repeated
thread setup, stdout restoration, worker reuse, malformed-response restart and
process-group cancellation. Run them with `BITSIGN_TEST_TMPDIR=/absolute/task-root/model-runtime/tests PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_admission test_warm_worker`
from this directory. `qualify_http.py` exercises the real server with an optional
video, including interrupted upload, invalid media, unsupported type and bounds.
Ogg uploads are refused with HTTP 415; the browser and Worker accept MP4, WebM,
QuickTime and M4V only. The decoder's ability to read a container is not an
invitation to bypass this application MIME contract.

## Video admission and automatic optimization

A separate killable process owns all native probing, decoding and optimization.
The stored input must be fully read from R2 within 15 seconds; admission has a
120-second process-group deadline and inference has a 600-second deadline. The
combined server budget is at most 735 seconds plus small process teardown and
response overhead; the application transport must allow 750 seconds. Admission
uses a 110-second CPU budget, 2-GiB address-space budget and 64-MiB output-file
limit in production. Local Rosetta qualification explicitly disables only the
address-space limit, because Rosetta requires a large virtual reservation; the
container memory cap, CPU and wall deadlines remain active. The bypass variable
`BITSIGN_EMULATED_QUALIFICATION` must never be configured in production.

Full decode must prove at most 350 million aggregate pixels, 3,600 frames and
30 seconds, independent of the file size or header frame count. Within-budget
examples keep their exact source bytes. Larger valid videos are uniformly
resized to at most 307,200 pixels per frame and 30 fps, with framing and full
clip duration preserved. FFmpeg uses no time cutoff or frame truncation. Its
complete output must pass the same decode bounds, and duration changes beyond
frame-rounding tolerance are rejected. MediaRecorder WebM without an index uses
a bounded full decode to establish duration. Source and inference hashes,
normalization status, decoded work and duration are returned in `preprocessing`
for retention with the job. Raw model/decoder diagnostics are discarded; logs
retain only bounded event, exception-type and numeric exit-code data.
