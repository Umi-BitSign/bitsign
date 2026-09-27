# BitSign

BitSign is the glasses app. SignRush stays a separate game.

The phone has two tabs:

- **Vision** connects to Brilliant Frame and Halo. Three taps on Frame, or one Halo click, captures about four stills. Those stills go to the vision service. English is shown on the glasses and spoken on the phone only when the model returns an English line.
- **SignRush** opens the SignRush game at https://signrush-login.web.app/.

## Model

The translation model in `model/` is the published UMI SN78 public model, `umi-s1-public-finetune-v1`, from [Umi-BitSign/umi-reference-model](https://github.com/Umi-BitSign/umi-reference-model). It is the public skeletal-motion model shipped for the subnet. It is an early bootstrap, not an ASL interpreter, and a cohort winner's private weights are not in this repo.

S1 reads landmark motion from its Linux extractor. It does not read the raw glasses stills. `services/vision/server.py` accepts the phone burst and returns `{"english":""}` until that extractor produces a line. It does not invent English and it does not store the burst.

Weights and the portable bundle are CC BY-SA 4.0. See `model/MODEL_CARD.md` and `model/release/`.

## Run the vision service

```sh
python3 services/vision/server.py
```

The phone build points at it with:

```sh
flutter run --dart-define=BITSIGN_INFERENCE_URL=http://<this-computer>:8091/translate
```

Use the computer's address, not `127.0.0.1`, when the app runs on a phone.
