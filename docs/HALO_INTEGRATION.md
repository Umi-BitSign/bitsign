# Running BitSign on Brilliant Labs Halo

This is a feasibility study and integration design. It covers what Halo can
actually do, what BitSign already has, and where the two do not meet.

Every number here is cited. Numbers marked *derived* were calculated from
documented hardware and firmware constants, not measured on a device. Section 11
lists what could not be determined.

Sources: the Halo SDK and hardware pages at `docs.brilliant.xyz`, and the
firmware at `github.com/brilliantlabsAR/halo-firmware` read at commit depth 1 on
2026-10-03, with the changelog at 0.8.17.

## 1. The verdict first

Halo cannot stream video. Its camera is configured for **1 frame per second** in
the shipped board definition, the Lua API exposes only one-shot still capture,
and the only uplink is BLE. The translation stack reads 120 frames sampled at
8 Hz. The gap between what the glasses produce and what the model expects is
roughly fortyfold on stock firmware and still two to five fold after a custom
firmware build.

So: continuous, conversational sign language translation on Halo is not
possible, and will not become possible through software on this hardware. What
is possible is turn-based capture — the wearer clicks, the other person signs a
short phrase, English appears a few seconds later. That is what the BitSign app
already does, and the honest conclusion of this study is that the existing
design is the right one and should be deepened rather than replaced.

The single biggest blocker is the camera frame rate, and it is a firmware
constant, not a sensor limit. See section 4.

## 2. How apps run on Halo

They do not run on Halo. From the SDK page, "How Do Apps Run on Halo?":

> Halo runs a power-efficient System-on-a-Chip (SoC) with relatively limited
> memory and processing power compared to modern smartphones. Rather than
> installing apps directly on Halo, it typically functions as a peripheral
> accessory for "host" apps running on computers or mobile devices. These host
> apps communicate with Halo via Bluetooth to control features like the camera,
> microphone, speakers, and display.

And:

> While you may write Lua scripts that execute on Halo for specific behaviors,
> your host app primarily drives the logic while Halo typically runs a simple
> event handler loop.

> Halo doesn't have its own app launcher or traditional app installation system.

The execution model is therefore two halves. A host app — Flutter on iOS or
Android, Python on desktop, or Web Bluetooth — owns the logic. A Lua 5.4 script
on the device owns a small event loop that answers the host over BLE. The host
pushes the Lua source to the device filesystem and runs it with `require()`;
`/main.lua` is auto-run at power-on. Deployment is just distribution of the host
app, through the App Store, Google Play, or a repository. There is nothing to
publish for the glasses themselves.

Once a Lua loop is running, the REPL is blocked and all traffic is raw data
frames: host to device on LUA TX with a `0x01` marker, device to host on LUA RX
via `frame.bluetooth.send()`. Control is a single byte — `0x03` breaks a running
script, `0x04` restarts the runtime (Bluetooth specs page, "Lua Main Loop — A
Special Case").

Firmware is the third option. The firmware is open and self-built images can be
flashed over the air; `halo-firmware/README.md` states that OTA uploads "default
to a one-shot test boot: if your image fails to boot, the device automatically
reverts to the previous firmware on the next reboot," and that images are signed
with the standard MCUboot development key deliberately so owners can build their
own. This matters for section 4, because the only lever on the frame rate is in
firmware.

## 3. Hardware

| Part | Specification | Source |
|---|---|---|
| SoC | Alif Balletto B1, Arm Cortex-M55 + Arm Ethos-U55 NPU | hardware page, firmware README |
| Memory | 2.0 MB SRAM, 1.8 MB MRAM flash | hardware page |
| External SRAM region | 458,752 bytes at offset 65,536 | `applications/halo/prj.conf:65-71` |
| Camera sensor | PixArt PAG7982J1, 640×480 global shutter colour, 81.2° horizontal FOV, 40 mW at full frame rate | hardware page |
| Camera configured rate | **1 fps** (`frame-rate = <1>`, pixclk 24 MHz) | `boards/arm/halo/halo.dts:511-512` |
| Camera formats offered | 640×480 BGGR8 only; QQVGA and QVGA caps are commented out | `drivers/video/pag7982.c:107-112` |
| Camera buffers | one (`CONFIG_VIDEO_BUFFER_POOL_NUM_MAX=1`, 327,680 B) | `applications/halo/boards/halo.conf` |
| Display panel | Guozhao VGA020 OLEDoS, 640×480 physical on 0.2", 6.3 µm pitch, 10000:1, 5000 nit peak, 25–120 Hz, MIPI 2-lane | hardware page |
| Display drawable area | 256×256, circular, no double buffer, no `show()` | Lua API, "Display" |
| Fonts | Dogica and DogicaBold, 8 px native, integer scaling only | Lua API; `modules/canvas/canvas.c:8-11` |
| Font metrics | 8 px fixed horizontal advance, 10 px line advance | `modules/canvas/Fonts/dogica/DogicaBold8px.h:46-147` |
| Microphones | 2× TDK T5838 PDM MEMS, 68 dBA SNR, 133 dB SPL AOP, 310 µA high quality down to 20 µA always-on AAD | hardware page |
| Speakers | stereo bone conduction, TI TPA2011D1 amp | hardware page |
| IMU | Bosch BMA580 accelerometer with single/double/triple tap, QST QMC6308 magnetometer | hardware page |
| Battery | 300 mAh (2 × 150 mAh GRP1654M1), 3.7 V nominal ≈ 1.11 Wh | hardware page |
| Connectivity | **Bluetooth LE 5.3 only. No Wi-Fi.** | hardware page |
| ATT MTU | negotiated, up to 512 | Bluetooth specs page |
| Bonds | up to 5 stored, one connection at a time | Bluetooth specs page |

Three things on this list decide the design.

**There is no Wi-Fi.** The Balletto B1 is a Bluetooth part. Every byte of image
data leaves the glasses over BLE notifications. This is the hard ceiling and no
amount of firmware work raises it.

**The NPU is not reachable.** The Ethos-U55 is real silicon, but there is no NPU
binding in the Lua API, and the firmware's own notes treat its availability as
an open question — `applications/halo/tests/beamform/FIRMWARE_PORT.md:87-92`
describes an Ethos-U55 path as an "optional ceiling-raiser" requiring
"quantization, driver wiring — confirm Ethos is enabled in this build." Nothing
of BitSign runs on it.

**The camera is a still camera.** See the next section.

## 4. Getting frames off the glasses

This is the make-or-break question and the answer is poor.

### 4.1 There is no video path

The Lua camera API is a one-shot still API: `frame.camera.capture(cfg)`, then
poll `frame.camera.image_ready()`, then drain with `frame.camera.read(bytes)`
until it returns `nil`. There is no streaming call, no callback per frame, and
no frame queue.

A `Video` characteristic at `7A230004` appears in the GATT table
(`applications/halo/BLE_SERVICES.md:110,121`, labelled "JPEG video streaming"),
with a C entry point `halo_ble_lua_video_write()`. It is dead. The function is
declared in `modules/halo/include/halo/ble_lua.h:168` and defined at
`modules/halo/src/ble_lua.c:801`, and nothing in the repository calls it. The
documentation says so plainly:

> The service also exposes two further characteristics — `7A230004` (Notify) and
> `7A230006` (Notify) — which you will see when enumerating the service but which
> the firmware does not use.

> Camera images and microphone audio are not streamed on dedicated
> characteristics. Camera image chunks are sent from Halo to host over the
> regular LUA RX characteristic using `frame.bluetooth.send()`.

So image data shares one notify characteristic with `print()` output, and the
Lua VM copies every byte of it.

### 4.2 Uplink throughput

`frame.bluetooth.max_length()` returns the usable payload, documented as
ATT MTU − 8. iOS caps ATT MTU at 185, giving 177 bytes per notification; Android
commonly negotiates 247, giving 239.

The firmware serialises notifications. `send_notification()` in
`modules/halo/src/ble_lua.c:540-544` takes a semaphore before each chunk —
commented "Wait for previous notification to complete" — and that semaphore is
returned only by the TX-complete callback at `ble_lua.c:433-441`. One
notification is in flight at a time.

*Derived:* if the controller completes one notification per connection event and
the host holds a 15 ms interval, that is 177 B / 15 ms ≈ **11.8 kB/s** on iOS and
239 B / 15 ms ≈ **15.9 kB/s** on Android. If TX-complete fires several times per
event the figure scales with it, to perhaps 70 kB/s at six packets per event.
The true value is somewhere in that band and it matters a great deal.

The firmware ships a measurement for exactly this:
`applications/halo/tests/test_bluetooth_throughput.py` reports KB/s against real
hardware. Run it before trusting any frame budget in this document.

### 4.3 Cost of one still, stock firmware

`frame.camera.capture()` wakes a capture thread that discards warmup frames
before keeping one. `LUA_CAMERA_SKIP_FRAMES` is 3
(`modules/halo/src/lua_camera.c:30`, loop at `:318`), and each of those frames
costs a sensor frame period. At the board's configured 1 fps that is about
**3 seconds of warmup per still**.

Then libmpix runs `debayer_2x2 → correct_black_level → correct_white_balance →
jpeg_encode` and the result is read out. The Lua API gives JPEG sizes for a
640 px capture as roughly 80 / 47 / 25 / 16 KB from `VERY_HIGH` down to `LOW`.

*Derived* total for one `LOW` still: 3.0 s warmup, plus an unmeasured encode of
order 0.1–0.5 s, plus 16 KB at 12–16 kB/s ≈ 1.0–1.4 s of transfer. Call it
**4.0 to 4.9 seconds per frame, about 0.2 fps.**

The existing BitSign app already reflects this. `app/lib/vision/translation.dart`
sets `burstFrameCount = 4` and `burstGap = 900ms` under the comment "Four stills,
about a few seconds apart. Bluetooth photo transfer is the capture path; this is
not a 30 fps video stream." That comment is correct and this study did not find
anything to soften it.

Against a model whose input contract is 120 frames at 8 Hz
(`model/MODEL_CARD.md`, "Architecture and input"), 0.2 fps is a fortyfold
shortfall.

### 4.4 What custom firmware buys

The 1 fps is a devicetree property, not a sensor limit. The PAG7982 driver
computes `frame_time = pixclk / (frame_rate * 2)` and writes it to the sensor's
frame-time registers (`drivers/video/pag7982.c:421-429`). Raising
`frame-rate` in a board overlay and reducing `LUA_CAMERA_SKIP_FRAMES` to 1 is a
small patch, and `halo-firmware/README.md` documents self-built OTA as a
supported workflow with automatic revert on a failed boot.

That removes the warmup wall but not the uplink. Two further levers exist on the
device side, both through `frame.camera.mpix`:

- `op.crop(p, x, y, w, h)` crops before encoding. Cropping to 256×256 around the
  hands cuts bytes about 4.7× while keeping full sensor resolution on the region
  that matters. Use `debayer_1x1` rather than the default binned `debayer_2x2`
  so the crop is at native pitch.
- `op.convert(p, fmt.GREY)` drops chroma. The landmark and DINOv2 front end does
  not need colour.

*Derived* best case with custom firmware: 33 ms capture at 30 fps, 50–150 ms
encode, and a 3–5 KB cropped grey JPEG taking 190–420 ms on the wire. Because
`CONFIG_VIDEO_BUFFER_POOL_NUM_MAX=1` there is one video buffer, so capture and
transfer cannot overlap. That gives **300–600 ms per frame, or 1.7 to 3.3 fps** —
still two to five times short of the 8 Hz the model wants.

### 4.5 Why resolution cannot be traded for frame rate

The camera is 640×480 over an 81.2° horizontal field, so the field width at
distance `d` is `2·d·tan(40.6°) = 1.714·d`.

| Signer distance | Field width | Scale | 180 mm hand | 160 mm face |
|---|---|---|---|---|
| 1.0 m | 1.71 m | 2.68 mm/px | 67 px | 60 px |
| 0.6 m | 1.03 m | 1.61 mm/px | 112 px | 100 px |

The DINOv2 crops are resized to 224 px regardless, so a 67 px hand is already
being upsampled more than threefold. Halving the capture width halves those
numbers and there is no headroom for it. The resolution floor and the bandwidth
ceiling push against each other directly, which is why cropping at native pitch
is the only useful lever — it buys bytes without buying blur.

### 4.6 Battery

No vendor runtime figure is published. The cell is 1.11 Wh and the camera is
40 mW at full frame rate, which is not the constraint; continuous capture also
keeps the M55 encoding, the radio transmitting and the display lit. *Derived:* a
150–250 mW session draws the pack flat in roughly 4.5 to 7.5 hours, before
regulator losses and before anything else the device does. Continuous capture is
a duty cycle this device was not designed for and thermal behaviour is unknown.

## 5. Where inference runs

Nothing runs on the glasses. The translation stack is 582,834,444 trainable
parameters and a ~2.9 GB checkpoint against 2.0 MB of SRAM. Even the 787k-parameter
router does not fit alongside a Lua VM, a display framebuffer and a 128 KB JPEG
buffer, and the NPU is not reachable from Lua (section 3).

Nothing useful runs on the phone either, and the reason is specific rather than
about capacity. `model/MODEL_CARD.md` states that the reference extractor is "a
locally built Linux/AMD64 MediaPipe Holistic extractor image," that the bundle
"binds its exact local image ID," and that "Linux/AMD64 and Linux/ARM64 landmark
tensors are separately identified and are not bit-equivalent." Running MediaPipe
on the handset produces landmarks outside the contract the model was trained
against. The phone stays a relay.

The split is therefore:

| Stage | Where | Why |
|---|---|---|
| Capture, crop, JPEG encode, caption render | Halo, Lua | only place with the camera and display |
| BLE session, reassembly, consent gate, caption pacing, TTS | phone, existing Flutter app | already built |
| Clip assembly, retention policy, auth | new Rust service, `services/relay` | genuinely new code, so Rust per `AGENTS.md` |
| Landmarks, DINOv2, encoder, CTC head or ByT5 | existing Python `services/vision/server.py` | works today; `AGENTS.md` forbids rewriting it to change languages |

### 5.1 Latency budget

For the v1 fingerspelling path, custom firmware at ~2.5 fps, phone on the same
Wi-Fi as the workstation running the vision service. A 3-second fingerspelled
word yields 7 or 8 frames.

| Stage | Estimate |
|---|---|
| Button click to capture start | < 100 ms (BLE write plus the 0.1 s `frame.sleep` in `app/assets/frame_app.lua`) |
| Capture and transfer, 8 frames, serialised | 2.4–4.8 s |
| Phone reassembly and POST over LAN (~40 KB) | 0.1–0.3 s |
| MediaPipe Holistic, 8 frames | 0.3–0.8 s |
| DINOv2 face and hand crops, plus pose | 0.4–1.5 s |
| Frozen encoder, CTC greedy decode | 0.1–0.3 s |
| Response, BLE text write, display | 0.1–0.2 s |
| **Total after the signer stops** | **3.4–7.9 s** |

Continuous translation adds a 15 s capture window instead of 3 s, and ByT5
width-2 beam decode with a 24-token ceiling, for roughly **20 to 30 seconds**.

Conversational turn-taking runs on gaps of a couple hundred milliseconds.
Interpreted exchange tolerates more, perhaps two to four seconds. The
fingerspelling path lands just outside that and reads as a deliberate
spell-and-read exchange. The continuous path is not conversational by any
reading and should not be described as one.

### 5.2 Cloudflare Workers

Workers are the wrong place for the media and a reasonable place for nothing
else yet.

The free plan allows 100,000 requests/day, **10 ms CPU per invocation**, 128 MB
memory, 50 subrequests, and a 100 MB request body (Workers platform limits, last
updated 2026-09-05). A 15-second burst is 40–400 KB and fits the body limit
comfortably, so size is not the problem. CPU is. Base64-decoding and repacking a
burst will not fit in 10 ms, there is no GPU, and Workers AI has no ASL model.
Raising CPU time to 30 s requires the Workers Paid plan, which `AGENTS.md` does
not authorise.

The one defensible use is a thin Rust `workers-rs` Worker that mints short-lived
consent and session tokens — a signature and a timestamp, well inside 10 ms and
well inside 100k requests/day. Even that is optional for v1 and should not be
built before there is a second client. Heavy media work stays in the private
service, as `AGENTS.md` requires.

### 5.3 Infrastructure that would cost money

Flagging these rather than assuming them:

- **A paid cloud GPU** for hosted inference. The free-scope path is
  `python3 services/vision/server.py` on a workstation, which the README already
  documents and which `_device()` already points at Apple MPS on Darwin. The
  cost of staying free is that the product only works near that machine.
- **Retraining the CTC head** at a lower frame rate. A few hours on one cloud
  GPU. Paid.
- **R2, Queues, or any hosted media store.** Not needed if nothing is retained,
  and section 8 argues nothing should be.

Firebase and the SignRush web app stay exactly as they are. Nothing in this
design touches them.

## 6. Displaying the English

The drawable area is 256×256 and circular. Dogica has a fixed 8 px horizontal
advance and a 10 px line advance, and scales only by integer multiples of 8.

The largest axis-aligned rectangle inside a 256 px circle is 256/√2 ≈ 181 px, so
a layout that is safe at any vertical position holds **22 characters per line**.
A line drawn across the horizontal centreline can hold 32. Vertically, 181 px at
10 px advance is 18 lines, which is far more than is readable.

`app/lib/vision/translation.dart` already uses `lineChars: 22, maxLines: 4`, and
`app/assets/frame_app.lua` draws Halo lines at `i * 20 + 1`, double-spacing them.
Both choices are correct and should stay.

Four lines of 22 characters is about 16 English words. At a glanceable reading
rate of roughly 150 wpm that is six and a half seconds of reading, which is too
much to put up at once while someone is still signing. Recommended pacing:

- **Fingerspelling.** One word. FSboard phrases average 14.6 characters, so the
  output fits on a single 22-character line. Hold it until the next capture. No
  chunking needed. This is a large part of why fingerspelling is the right v1.
- **Continuous translation.** Chunk to two lines, about eight words, and hold
  each panel 3.0–3.5 s with a 300 ms blank between panels so the change is
  visible. Clamp as the app already does at 240 characters, which is at most
  four panels and about 14 seconds of reading.
- Never scroll. There is no double buffer, so a partial redraw is visible as a
  tear.

## 7. What already exists in the repository

More than expected. BitSign is already a Halo app.

| Artefact | State |
|---|---|
| `app/` | Flutter host app, `simple_brilliant_app ^9.1.1` and `brilliant_msg ^4.0.0` |
| `app/assets/frame_app.lua` | device-side Lua loop with explicit Halo branches throughout |
| `app/lib/vision_tab.dart` | BLE connect, burst capture, POST, glasses text, TTS |
| `app/lib/vision/translation.dart` | 22×4 caption wrapping, 240-char clamp, burst timing |
| `services/vision/server.py` | `/translate` and `/health`, base64 JPEG stills to mp4 to runner, CORS allowlist |
| `model/ACTIVE.json` | pins the runner the vision service is allowed to call |
| iOS `Info.plist`, Android manifest | Bluetooth usage strings and permissions already declared |

The Lua app is specifically Halo-aware, not Frame code that happens to run:
it branches on `frame.HARDWARE_VERSION`, uses `frame.display.clear(0xRRGGBB)`
where Frame uses `display.show()`, registers `frame.button.single/double/long`,
calls `frame.camera.power_save(false)` at loop start, forces `resolution = 640`
on Halo captures, and carries a comment noting that "Halo (0.8.8+) passes the
gesture kind ('single'/'double'/'triple') and fires once per gesture." Battery is
left to the standard BLE battery service on Halo rather than the Frame-style
periodic send.

So the capture path, the transport, the display path and the inference endpoint
all exist and are Halo-correct. What is missing is everything in sections 4.4,
8 and 9: no fingerspelling route on the service, no consent flow, no Rust relay,
no caption pacing, no device-side cropping, and no custom firmware.

## 8. Privacy and consent

This section is a design constraint, not a disclaimer. The glasses form factor
changes the problem in a way the existing phone app did not have to face.

**The device cannot tell anyone it is recording.** There is one LED
(`boards/arm/halo/halo.dts:88-92`) and it is owned by the firmware's LED manager
for power, pairing and charging states
(`applications/halo/BUTTON_LED_GUIDE.md`). There is no `frame.led` in the Lua
API; an app cannot turn on a recording light. The speakers are bone conduction,
so any audible cue reaches the wearer's skull and nobody else. `show_flash()` in
`app/assets/frame_app.lua` flashes the wearer's own display white — a cue for the
wearer, invisible to the person in front of them. There is no mechanism on this
hardware by which an app signals capture to the subject.

**The asymmetry is the wrong way round.** In the expected use the wearer is the
hearing party and the subject is a Deaf signer. The glasses hand the hearing
party a camera that is pointed at a Deaf person's face and hands — which is to
say, at their language — with no outward indication. The existing commitment that
corpus media stays private does not address this, because the exposure is at
capture, not at storage.

What the app must therefore do:

1. **Capture only on an explicit, per-turn button click.** Never on IMU tap,
   never on audio activity detection, never on a timer, never continuously. One
   click, one bounded burst, then stop. The current `onClick` / `onTap` handlers
   already have this shape and must not grow a streaming mode.
2. **Make the phone the consent surface.** Since the glasses cannot signal, the
   phone must. Before the first capture of a session, the phone shows a consent
   screen turned toward the signer, in English and with the option to decline,
   and the signer can end the session from that screen at any time. A session
   token from that screen gates the relay; without it the service refuses the
   burst.
3. **Retain nothing.** The vision service already holds a burst only inside a
   `TemporaryDirectory` and does not write it anywhere, and the README states
   "the burst is not stored." Keep that property and assert it in the response.
   The phone must keep frames in memory only.
4. **Never let glasses capture become training data.** No corpus contribution
   from this path in v1, under any consent. The corpus commitments cover media
   collected under a consent process built for it; a passerby clicking through a
   phone screen is not that process. Keep the held-out references private and
   server-side as they are.
5. **Keep rewards test-only**, as the existing commitment states. A glasses
   capture path must not create any reward surface at all.
6. **Document pairing hygiene.** Halo stores up to 5 bonds and accepts one
   connection at a time. Shared or borrowed glasses stay bonded to a previous
   phone, which can reconnect. A 15-second button hold with the charger
   disconnected factory-resets the bonds; that belongs in user documentation, not
   in a footnote.
7. **Show the wearer what was sent.** The Vision tab already renders the last
   captured still. Keep it. A wearer who cannot see what the camera took cannot
   be accountable for it.

## 9. Milestones

**M0 — Measure before designing further.** Run the firmware's own
`tests/test_bluetooth_throughput.py` and `tests/test_camera.py` against a real
Halo and record kB/s and seconds-per-still. Every derived number in this document
is a calculation; M0 replaces them with facts. Needs a device, costs nothing.

**M1 — Fingerspelling on stock firmware.** The smallest useful thing, and it
needs no firmware work. Keep the existing capture path exactly as it is. Add a
route on the vision service that runs the frozen encoder and the CTC letter head
and returns a single word. One click, a short burst, one word on one 22-character
line. The locked-panel character error is 40.54%, so roughly three letters in
seven are wrong — the interaction has to be built around a partial answer that
the user corrects, not a confident one.
Fingerspelling is the right v1 because the output fits the display on one line,
the capture window is seconds rather than fifteen, and there is no autoregressive
decode in the latency path.

**M1a — Slow-spell.** M1 as built does not work on natural fingerspelling and
the arithmetic says so plainly. The camera is configured at 1 fps (section 4.3)
and fluent fingerspelling runs at roughly 4–6 letters per second, so the burst
is undersampled about fivefold: most of the letters are never observed at all,
rather than the word being truncated. Greedy CTC compounds it, because it cannot
emit more labels than the encoder has timesteps and the encoder produces one
timestep per frame, so the four-still burst caps the answer at four letters
whatever the signer spells.

Slow-spell is the interaction that fits the sampling rate instead of fighting
it. The phone prompts for one letter at a time, takes one still per letter, and
assembles the word; the glasses show one mark per letter captured and the
position being asked for next. It needs no firmware change and works on stock
firmware today. It is not natural signing and should never be described as if it
were — it is a deliberate spell-and-read exchange, and the honest framing is
that the hardware supports that and does not support the other thing.

One decoding detail is load-bearing. The continuous path collapses repeated CTC
labels, which is correct there because one letter spans several frames. In
slow-spell it is wrong: each still is exactly one deliberate letter, so
collapsing would read the `ll` of `kelly` and the `ss` of `russell` as single
letters. Slow-spell therefore takes the per-frame argmax over the non-blank
labels — one letter per still, in order, repeats kept — as a decode path
selected explicitly by the request rather than an overload of the continuous
one. The blank is left out of that argmax rather than skipped after it, because
a head trained on continuous video scores most frames as blank while in this
mode every still is a letter by construction.

Slow-spell is further out of the training distribution than the burst path, and
further than section 11's last bullet already allows for. The head was trained
on FSboard clips sampled at 8 Hz, never on isolated letters held still for a
camera, so per-letter accuracy may be considerably worse than the locked-panel
40.54% — and that figure was measured on studio video, not on 640×480
head-mounted stills with hands at roughly 67 px. No figure is shown to users.
The word is a suggestion they confirm or correct, and the phone lets one wrong
letter be fixed in place rather than costing the whole word. Retraining the head
on deliberately held letters is the real fix and belongs with M4.

Word length is bounded at both ends: at least two stills, because the
preprocessing needs two frames, and at most twelve, because the encoder reads
one timestep per still and a longer word is not a turn anyone will sit through
at four to five seconds per still.

**M2 — Consent and session.** Build `services/relay` in Rust in front of the
Python service: session tokens, consent gating, clip assembly, explicit
no-retention. Add the phone-side consent screen from section 8. Do not touch
`services/vision/server.py` beyond the route M1 adds.

**M3 — Custom firmware capture path.** Fork halo-firmware; overlay
`frame-rate = <30>`; drop `LUA_CAMERA_SKIP_FRAMES` to 1; add a Lua pipeline doing
`debayer_1x1 → crop(256×256) → convert(GREY) → jpeg_encode`, with the crop
window fed back from the previous frame's landmarks. Flash by OTA, which reverts
automatically on a bad boot. Then measure again. Target 2–3 fps, and treat
anything above that as a pleasant surprise.

**M4 — Retrain the head at the achievable rate.** This is the step most likely to
be skipped and should not be. The CTC head was trained on clips sampled at 8 Hz;
feeding it 2–3 Hz is a distribution shift, not merely fewer frames. Retrain on
FSboard at the rate M3 actually delivers. Paid — a few hours on one cloud GPU —
and needs authorisation.

**M5 — Continuous translation, only if M3 holds.** Fifteen-second window, router,
ByT5 path, captions paced at two lines per 3.0–3.5 s. Expect 20–30 s end to end
and describe it accurately to users as such.

## 10. What is blocking

1. **Camera rate.** `frame-rate = <1>` in the shipped board DTS, with three
   discarded warmup frames per capture. Costs about 3 seconds per still. Fixable
   only by building and flashing custom firmware.
2. **No streaming primitive.** The Lua camera API is one-shot. The `7A230004`
   Video characteristic is plumbed into the GATT table but
   `halo_ble_lua_video_write()` has no caller and the documentation confirms the
   firmware does not use it.
3. **BLE-only uplink.** No Wi-Fi on the Balletto B1, and the firmware allows one
   notification in flight at a time. Custom firmware does not raise this.
4. **Single video buffer.** `CONFIG_VIDEO_BUFFER_POOL_NUM_MAX=1` means capture and
   transfer serialise; there is no pipelining to recover.
5. **NPU unreachable.** No Lua binding, and the firmware's own notes do not
   confirm Ethos-U55 is enabled in this build.
6. **Model and sensor disagree.** The contract is 120 frames at 8 Hz. The device
   delivers 0.2 fps stock, 2–3 fps with custom firmware.
7. **GPU inference is paid.** Free scope means the LAN workstation service, which
   ties the product to being near that machine. Anything always-on is a paid
   upgrade and is not authorised.
8. **No outward recording indicator an app can drive.** Section 8. This is a
   product constraint, not a bug to route around.

Items 1, 3, 4 and 8 are hardware or firmware facts. Item 6 follows from them.
Items 2 and 5 could change if Brilliant ships new firmware; the Video
characteristic in particular looks like reserved intent rather than an oversight,
and is worth re-checking against each release.

## 11. Not determined

- **Actual BLE throughput.** Derived at 12–16 kB/s from the one-in-flight
  serialisation and a 15 ms interval, with a ceiling near 70 kB/s if the Alif
  controller completes several notifications per connection event. No device was
  available. This is the single most valuable missing number and M0 gets it.
- **libmpix encode time on the M55.** Not published and not inferable from the
  source. Estimated at 0.1–0.5 s for a full-frame 640×480 JPEG.
- **Battery life under continuous capture.** No vendor figure. Only 1.11 Wh and
  the camera's 40 mW rail are published; the 4.5–7.5 hour estimate assumes a
  150–250 mW draw that was not measured. Thermal behaviour is entirely unknown.
- **Whether the LED is visible from outside the glasses.** The firmware
  documentation describes it only from the wearer's point of view. It does not
  change the conclusion in section 8, because the LED is not Lua-controllable
  either way.
- **Whether the crop-feedback loop in M3 converges.** Cropping around the hands
  requires knowing where the hands were, which arrives a round trip late. At
  2–3 fps a signer's hands move a long way between frames and the crop may lag
  badly. Untested, and it is the main risk in M3.
- **Real-world accuracy of the CTC head on glasses frames.** The 40.54% figure is
  from FSboard video, not from 640×480 JPEG stills at 67 px of hand, captured
  through a head-mounted camera at an angle the corpus does not contain. Expect
  it to be worse and do not quote the FSboard number as a product figure.
- **Per-letter accuracy of slow-spell (M1a).** Worse again, and for a reason
  beyond resolution and angle: the head was trained on continuous fingerspelling
  sampled at 8 Hz and slow-spell feeds it one isolated, deliberately held letter
  per timestep. That is a different distribution, not a sparser sample of the
  same one, and it is why the slow-spell decode has to drop the blank from its
  argmax at all. Unmeasured, because no device and no held-out set of held
  letters exists. M4 retraining is the fix; until then no figure is shown.
- **Whether a signer will hold a letter long enough on cue.** Slow-spell asks
  the signer to present one letter and wait, which is not how anyone
  fingerspells. The prompt rhythm the wearer sees is a mark per letter on the
  panel and the flash per capture, but the flash is wearer-only (section 8), so
  the signer is following the phone or the wearer's gestures. Untested with
  Deaf signers, and it is the main risk in M1a.
