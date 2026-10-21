# Pinned C5 model

BitSign's web demo pins Trupan's UID104 model from C5, not the repository's
older Flutter baseline. `pin.json` names the exact model, cohort, submission,
immutable inference source and CPU runtime. `public-release.json` retains the
public API's authorization and accepted license (`CC-BY-SA-4.0`). `manifest.json`
is the unchanged 465-file native bundle manifest; its domain-separated identity
is the pinned model ID. `MODEL_IDENTITY.json`, `PROVENANCE.md` and `licenses/`
retain upstream source, contribution, fine-tune and component attribution.

Fetch with `bash model/c5-winner/fetch.sh /absolute/recorded/task-root` from the
repository root. This requires the adjacent UMI checkout (or `UMI_SOURCE`) and
Docker. It materializes 2,969,426,632 payload bytes into ignored `artifact/model`
and preserves the download client's verification journal in `artifact/.umi-download`.
Keep that directory while a deployment build consumes it. The public runtime
archive is scratch under the supplied task root and can be removed after import
and build qualification. Preserve Docker runtime images needed for rebuilds.

The model's exact `umi_inference.py` runs a learned fingerspelling recognizer
with a conservative router, then the fine-tuned SHuBERT/ByT5 translator when
required. Outputs can be inaccurate or lack spaces. BitSign preserves raw model
text, labels gallery references separately, and does not add a language-model
rewrite. The examples demonstrate execution on licensed public FSboard material,
which also supplied training data; they are not an independent accuracy estimate.

See `services/web-inference/README.md` for transport, bounds, image verification
and the complete entrypoint's warm-worker qualification. Publicly served media
and private inference inputs have separate retained hashes where a display copy
is blurred; the app identifies that treatment.
