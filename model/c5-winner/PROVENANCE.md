# Licenses and inference provenance

This is a standalone inference assembly. It is not an official upstream release
or a claim of measured translation accuracy. Required public author attribution
is retained; no private training inventory is supplied.

| Component | Public source | Declared terms |
|---|---|---|
| SHuBERT translation and fine-tuned hand/face tensors | https://huggingface.co/ShesterG/SHuBERT | Publisher model repository declares MIT; revision 578a0233e770c8ce4dc75d859b91fdea7c34f5aa |
| SHuBERT demo architecture and preprocessing | https://huggingface.co/spaces/ShesterG/TTIC-SHuBERT-ASLVideo-to-EnglishText/tree/69d3d77aa4a4fec89048f5417d44fa717e36f6f8 | Publisher Space declares MIT |
| Fairseq library | https://github.com/facebookresearch/fairseq | MIT; included notice in licenses/fairseq-MIT.txt |
| DINOv2 architecture | https://github.com/facebookresearch/dinov2/tree/7764ea0f912e53c92e82eb78a2a1631e92725fc8 | Apache-2.0; license retained with source |
| ByT5 tokenizer/base architecture lineage | https://huggingface.co/google/byt5-base | Apache-2.0 |
| MediaPipe face/hand task assets and runtime | https://github.com/google-ai-edge/mediapipe | Runtime: Apache-2.0. Task assets are distributed in the SHuBERT model repository under its declared MIT terms; no broader asset-rights claim is made |
| Standalone wrapper and compatibility changes | Included source | Apache-2.0, see LICENSE |

SHuBERT citation: *SHuBERT: Self-Supervised Sign Language Representation Learning
via Multi-Stream Cluster Prediction*, https://arxiv.org/abs/2411.16765.
ByT5 citation: *ByT5: Towards a token-free future with pre-trained byte-to-byte
models*, https://arxiv.org/abs/2105.13626.
DINOv2 citation: *DINOv2: Learning Robust Visual Features without Supervision*,
https://arxiv.org/abs/2304.07193.

The publisher model card is sparse: MIT is its declared license, not a detailed
independent audit of upstream training-data rights. This package grants no rights
to upstream source videos or annotations, which are not included. Retain all
applicable upstream attribution when redistributing. Python dependency licenses
remain with their separately installed distributions.

Changes in this assembly: package-relative paths; standalone serial CLI; explicit
CPU/MPS device selection; offline model loading; OpenCV video-reader compatibility;
five-beam decoder configuration; removal of example entry points and diagnostic
source-path prints; inference-only DINO architecture inventory; tensor-only
safetensors serialization with exact tensor-value checks; removal of training
metadata from configuration. No model tensor was trained, pruned or quantized.

The SHA-256 inventory binds the exact distributed source, model and configuration.
No optimizer, training arguments, RNG state, corpus files or experiment records
are part of this distribution.

## Composite derivative: fingerspelling router

This bundle is a derivative of the C5 comparator `6fe8df59ec11ba89f4dfe0474a673fe757e378cd9184449965861c5a7c59b641`. The community
baseline's tokenizer, landmark tasks, feature models and runtime are unchanged;
its translator weights (`models/checkpoint-11625/model.safetensors`) were fine-tuned (see "Translator fine-tune"
below; `config.json` unchanged), and the matching sha256 pin in `runtime.py`
(`EXPECTED_ASSET_SHA256`) was updated, with asset verification still enabled.
One declared component and a video-only router were added:

- **Fingerspelling component**: `models/fs/fs-fsboard.pt`, a 5.26M-parameter
  3-layer LSTM CTC recogniser over MediaPipe Holistic landmarks (code under
  `umi_fs/`). Trained by the contributor from random initialisation on the
  **FSboard train split only** (70,694 clips; Google, CC BY 4.0) and selected
  on the FSboard validation split (best epoch 56, validation accuracy 0.8586).
  The FSboard **test** split, the source of UMI's fingerspelling evaluation,
  was never used for training, selection or tuning. FLEURS-ASL dev signer 3 was
  never used for any purpose.

Validation shares 877 phrases (no signers or videos) with test; it was used
only for checkpoint selection and router tuning, not as training data. The
fingerspelling component saw no FLEURS-ASL data; the FLEURS-ASL devtest clips
used for router tuning are a different FLoRes sentence set from the dev
split.
- **Landmarker**: `models/fs/holistic_landmarker.task` (Google MediaPipe,
  Apache-2.0). In the pinned runtime (mediapipe 0.10.14) the legacy
  `mp.solutions.holistic` graph is used, because the Tasks HolisticLandmarker
  aborts in that version.
- **Router** (`umi_fs_router.py`, `fs_router.json`): runs the fingerspelling
  component on the input video. Stage 1: if (confidence >= 0.9 AND >= 10 letters/digits) OR (confidence >= 0.85 AND >= 16 letters/digits), its text is returned;
  otherwise the baseline runs. Stage 2: if the baseline's answer is at most 6 words and contains a digit (an unread fingerspelled number), and the fingerspelling text has confidence >= 0.83 and >= 8 letters/digits, the fingerspelling text is returned instead.
  It uses no case ID, stratum, filename, metadata or network. Any router error
  falls back to the baseline.
- **Baseline decoding**: the unchanged translator is called with the parent's
  settings plus {"length_penalty": 0.6, "no_repeat_ngram_size": 16} (a beam-search length
  penalty below 1 prefers shorter hypotheses), declared in `fs_router.json`.

### Training procedure

- Data: FSboard landmark release (train and validation splits), 648-dim
  MediaPipe Holistic landmark features per frame, at the release frame rate.
  The training manifest also listed test rows; the trainer
  selects `split in {train, val}` only, and the character vocabulary (59 + CTC
  blank) is built from train labels only. 23 train / 4 val clips with fewer
  frames than label characters were skipped.
- Model: 3-layer LSTM, d_model 256, dropout 0.3, batch normalisation, CTC loss
  (blank 0, zero_infinity), character units.
- Optimisation: AdamW (lr 3e-4, weight decay 0.01), OneCycle schedule
  (pct_start 0.1), gradient-norm clip 1.0, batch 64, 60 epochs, one RTX 4090.
  The checkpoint with the best validation exact-match accuracy (epoch 56) is
  shipped. No test data, external text or language model was used.
- Router rules and the decoding override were chosen on 300 FSboard
  **validation** videos and 398 FLEURS-ASL **devtest** clips from signers 0-2,
  never on FSboard test or FLEURS-ASL dev.

### Evaluation-overlap check (measured, FSboard metadata)

| pair | shared signers | shared phrases (normalised text) | shared videos |
|---|---|---|---|
| train vs test | 0 of 15 | 0 of 9,786 | 0 |
| train vs val | 0 of 15 | 0 of 9,638 | 0 |
| val vs test | 0 of 15 | 877 of 9,786 | 0 |

Training data shares no signer, phrase or video with the FSboard test split.

### Translator fine-tune

- Data: FLEURS-ASL (Tanzer and Google, CC BY-SA 4.0) **devtest split, signers
  0-2 only**: 1016 sentence clips. The
  FLEURS-ASL **dev** split (all signers, including dev signer 3, UMI's continuous
  evaluation source) was never used for any purpose. FLEURS dev and devtest are
  different FLoRes sentence sets.
- Split: by document (sha256 of the document id, 1 in 5 held out), so held-out
  clips share no document and no sentence with training: 804 training
  clips, 212 held-out clips used only for epoch selection and reporting.
- Inputs: the translator's own input tensors, produced by the parent bundle's
  unchanged feature path in UMI's pinned offline CPU runtime image.
- Optimisation: full fine-tune (all translator parameters), AdamW
  (lr 1e-05, weight decay 0.01), linear warm-up then decay, gradient-norm clip 1.0,
  batch 1 with 8-step accumulation, 6 epochs; epoch 2 selected on the
  held-out documents with the shipped decoding settings.
- Held-out result (UMI word-error scorer, one reference per clip): +0.0567
  vs the unchanged translator with the same decoding (95% bootstrap CI
  +0.0409 to +0.0715). Video-dependence control (each held-out
  clip decoded with another clip's video): margin +0.1101 before and
  +0.1672 after fine-tuning.
- No FSboard test data, no FLEURS-ASL dev data, no case IDs and no evaluation
  references were used.

License: the fine-tuned translator weights are an adaptation trained on
FLEURS-ASL (CC BY-SA 4.0), so the bundle is declared `CC-BY-SA-4.0` and the
contributor offers its contributions (fine-tuned translator, fingerspelling
checkpoint, router and their code) under CC BY-SA 4.0. The parent's SHuBERT
weights are MIT-licensed by their publisher; the unchanged comparator components
keep their own licenses and notices, which remain in force separately.

Attribution: FLEURS-ASL (Tanzer, Google, 2024), CC BY-SA 4.0
(https://creativecommons.org/licenses/by-sa/4.0/); see
`licenses/FLEURS-ASL-CC-BY-SA-4.0-NOTICE.txt`. FSboard (Georg et al., Google,
2025), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); see
`licenses/FSboard-CC-BY-4.0-NOTICE.txt`. MediaPipe models (c) Google, Apache-2.0;
see `licenses/MediaPipe-Apache-2.0-NOTICE.txt`.
