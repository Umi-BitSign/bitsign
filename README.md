# BitSign

BitSign is the glasses app. SignRush stays a separate game.

The phone has two tabs:

- **Vision** connects to Brilliant Frame and Halo. Three taps on Frame, or one Halo click, captures about four stills and reads fingerspelling from them. Those stills go to the vision service. Letters are shown on the glasses and spoken on the phone only when the model reads some, and they are always offered as a reading to correct rather than a translation. A double click on Halo spells a word one letter at a time instead, which is slower than signing but gives every letter its own photo. The same tab can run the continuous route instead.
- **SignRush** opens the SignRush game at https://signrush-login.web.app/.

## Consent

The glasses have no outward recording indicator an app can drive, so the phone is the consent surface. Nothing is captured until the person in front of the camera agrees on a screen turned toward them, and they can end the session from the Vision tab at any time. Consent lapses on its own after thirty minutes. The vision service refuses `/fingerspell` without that consent.

A burst is read for one turn and then dropped. It is not retained, it never becomes corpus or held-out reference material, and it creates no reward surface. `/fingerspell` rejects a request that asks for either.

Halo stores up to five bonds and accepts one connection at a time, so shared or borrowed glasses stay bonded to a previous phone and that phone can reconnect. Holding the button for fifteen seconds with the charger disconnected clears the bonds.

## Model

BitSign uses the newest public UMI SN78 baseline or certified winner whose weights are actually published. The pin is `model/ACTIVE.json`. That is `umi-community-baseline-v0.2` from [community-baseline-v0.2](https://github.com/Umi-BitSign/umi-reference-model/releases/tag/community-baseline-v0.2). Cohort score tables do not count, because they do not include weights.

The vision service calls only the runner named in that pin. The runner in `model/community-baseline-v0.2/` reads a video and prints one JSON object. The vision service turns a glasses burst into a short video, runs that runner, and copies the `text` field into `english`. If the weights are missing, or the runner returns no line, `english` stays empty. The phone does not speak a reason, and the burst is not stored.

Install the open weights, which are about 2.9 GB and are not committed:

```sh
python3 model/fetch_baseline.py
```

The first translation also builds the runner's `.runtime` through `run.sh` (Python 3.10). `ffmpeg` is required to pack the stills.

## Fingerspelling

`POST /fingerspell` reads letters instead of a sentence. It runs the same preprocessing and the same frozen encoder as `/translate`, then a CTC letter head over the encoder's hidden states, so there is no autoregressive decode in the latency path. That head is a separate checkpoint, it is not in the pinned archive, and it is not committed. Put it at:

```
model/heads/spell_head_fsboard.pt
```

or point `BITSIGN_SPELL_HEAD` somewhere else. The head is produced by the training scripts, which are not part of this repository. Without it the service still starts and `/translate` still works; `/fingerspell` answers with `error: "spell_head_missing"` and no letters. `GET /health` says which of the two are installed.

The reading is never presented as a confident answer. Spelling error was measured on studio video, not on 640x480 head-mounted stills where a hand is about 67 pixels across, so the real figure is worse and is not known.

### Slow-spell

The Halo camera is configured at 1 fps and fluent fingerspelling runs at four to six letters a second, so a continuous burst does not truncate the word, it never observes most of the letters. Greedy CTC also cannot emit more labels than the encoder has timesteps, and the encoder produces one timestep per frame, so a four-still burst caps the answer at four letters.

Slow-spell is the honest way round it. The app asks for one letter at a time, takes one still for each, and assembles the word. On Halo a double click starts a word, a single click captures the letter the signer is holding, another double click reads the word, and a long press abandons it. The glasses show one mark per letter taken and an underscore for the position being asked for next. This is not natural signing and the app does not present it as if it were, but it needs no firmware change and works on stock firmware today.

Send `"mode": "slow-spell"` with the stills to select it:

```json
{"frames": ["<base64 jpeg>", "..."], "mime": "image/jpeg", "mode": "slow-spell", "consent": {...}}
```

The answer adds a positional `letters` array, one entry per still, so a single wrong letter can be fixed without spelling the word again:

```json
{"english": "kelly", "spelled": "kelly", "mode": "slow-spell", "letters": ["k","e","l","l","y"], "frames": 5, "provisional": true, "retained": false}
```

`"mode"` is absent or `"continuous"` for the burst path, which is unchanged. The two decodes differ in one way that matters: continuous collapses repeated CTC labels, because there one letter spans several frames, while slow-spell takes the per-frame argmax over the non-blank labels and keeps repeats, because there each still is one deliberate letter and a collapse would read the `ll` of `kelly` as a single l. A word is between two and twelve letters: the encoder reads one timestep per still and the preprocessing needs two frames to work at all.

Slow-spell is further out of the training distribution than the burst path. The letter head was trained on continuous fingerspelling video at roughly 8 Hz and never on isolated letters held still for a camera, so per-letter accuracy may be considerably worse than the burst path's — which was itself measured on studio video rather than head-mounted stills. No accuracy figure is shown to users for either path, because none is known for this hardware. The word comes back as a suggestion to confirm or correct, never as an assertion.

Slow-spell goes through the same consent gate as the burst, asserts `retained: false` the same way, and is refused the same way if the request asks for retention or corpus contribution.

## Run the vision service

```sh
python3 services/vision/server.py
```

The phone build points at it with:

```sh
flutter run --dart-define=BITSIGN_INFERENCE_URL=http://<this-computer>:8091/translate
```

The fingerspelling route is assumed to sit beside that one at `/fingerspell`; `--dart-define=BITSIGN_SPELL_URL=...` overrides it. Use the computer's address, not `127.0.0.1`, when the app runs on a phone.

## License

The BitSign app and vision service are Apache-2.0. The runner in `model/community-baseline-v0.2/` and the files in `model/release/` keep the licenses shipped with those artifacts.
