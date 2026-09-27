# BitSign

BitSign is the glasses app. SignRush stays a separate game.

The phone has two tabs:

- **Vision** connects to Brilliant Frame and Halo. Three taps on Frame, or one Halo click, captures about four stills. Those stills go to the vision service. English is shown on the glasses and spoken on the phone only when the model returns an English line.
- **SignRush** opens the SignRush game at https://signrush-login.web.app/.

## Model

BitSign uses the newest public UMI SN78 baseline or certified winner whose weights are actually published. The pin is `model/ACTIVE.json`. That is `umi-community-baseline-v0.2` from [community-baseline-v0.2](https://github.com/Umi-BitSign/umi-reference-model/releases/tag/community-baseline-v0.2). Cohort score tables do not count, because they do not include weights.

The vision service calls only the runner named in that pin. The runner in `model/community-baseline-v0.2/` reads a video and prints one JSON object. The vision service turns a glasses burst into a short video, runs that runner, and copies the `text` field into `english`. If the weights are missing, or the runner returns no line, `english` stays empty. The phone does not speak a reason, and the burst is not stored.

Install the open weights, which are about 2.9 GB and are not committed:

```sh
python3 model/fetch_baseline.py
```

The first translation also builds the runner's `.runtime` through `run.sh` (Python 3.10). `ffmpeg` is required to pack the stills.

## Run the vision service

```sh
python3 services/vision/server.py
```

The phone build points at it with:

```sh
flutter run --dart-define=BITSIGN_INFERENCE_URL=http://<this-computer>:8091/translate
```

Use the computer's address, not `127.0.0.1`, when the app runs on a phone.
