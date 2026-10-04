import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:brilliant_msg/brilliant_msg.dart';
import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:http/http.dart' as http;
import 'package:logging/logging.dart';
import 'package:simple_brilliant_app/brilliant_vision_app.dart';
import 'package:simple_brilliant_app/simple_brilliant_app.dart';

import 'vision/consent.dart';
import 'vision/consent_screen.dart';
import 'vision/slow_spell.dart';
import 'vision/translation.dart';

final _log = Logger('BitSignVision');

/// Set at build time: `--dart-define=BITSIGN_INFERENCE_URL=https://...`
/// The service must answer JSON `{"english":"..."}`. Frames are not stored in SignRush.
const inferenceUrl = String.fromEnvironment('BITSIGN_INFERENCE_URL');

/// The fingerspelling route. Defaults to `/fingerspell` beside the URL above;
/// `--dart-define=BITSIGN_SPELL_URL=...` overrides it.
const spellUrlOverride = String.fromEnvironment('BITSIGN_SPELL_URL');

class VisionTab extends StatefulWidget {
  const VisionTab({super.key});

  @override
  State<VisionTab> createState() => VisionTabState();
}

class VisionTabState extends State<VisionTab> with SimpleFrameAppState, BrilliantVisionAppState {
  final FlutterTts _speech = FlutterTts();
  final TextEditingController _correction = TextEditingController();
  Image? _image;
  String _status = 'Connect Frame or Halo, then click to read fingerspelling.';
  String _english = '';
  String _hint = '';
  bool _busy = false;
  bool _capturing = false;
  String _captureDetail = 'Nothing has been captured.';
  ConsentSession? _consent;
  SlowSpellWord _word = SlowSpellWord.idle;
  int? _fixing;

  /// One still per letter, in memory for as long as the word takes to spell and
  /// dropped with the answer. Nothing here is written anywhere.
  final List<Uint8List> _letterStills = [];

  VisionTabState() {
    Logger.root.level = Level.INFO;
    Logger.root.onRecord.listen((record) {
      debugPrint('${record.level.name}: ${record.message}');
    });
  }

  @override
  void initState() {
    super.initState();
    tryScanAndConnectAndStart(andRun: true);
  }

  @override
  void dispose() {
    _correction.dispose();
    super.dispose();
  }

  @override
  Future<void> onRun() async {
    // Two lines of 22, which is what the panel holds.
    await _showOnGlasses('click: read a burst\ndouble: spell letters');
  }

  @override
  Future<void> onCancel() async {}

  @override
  Future<void> onTap(int taps) async {
    if (taps >= 3) await spellTurn();
  }

  /// Single click keeps its existing meaning when no word is in progress, so
  /// the burst turn is reached the same way it always was. Inside a word the
  /// three gestures become capture, done and abandon.
  @override
  Future<void> onClick(ClickType type) async {
    switch (type) {
      case ClickType.single:
        if (_word.inProgress) {
          await captureLetter();
        } else {
          await spellTurn();
        }
      case ClickType.double:
        if (_word.inProgress) {
          await finishWord();
        } else {
          await startWord();
        }
      case ClickType.long:
        await cancelWord();
    }
  }

  /// One turn: the wearer clicks, the other person fingerspells a short phrase,
  /// the reading comes back. The hardware gesture never starts anything longer
  /// than one bounded burst, and never anything without consent.
  Future<void> spellTurn() async {
    if (_busy || frame == null) return;
    _busy = true;
    try {
      if (!await _consented()) return;
      final frames = await _captureBurst('Reading fingerspelling…');
      final turn = await _spell(frames);
      _english = turn.spelled;
      if (mounted) {
        setState(() {
          _status = turn.status;
          _hint = turn.hint;
          _correction.text = turn.spelled;
        });
      }
      await _showChunks(turn.chunks);
      if (turn.canSpeak) await _speech.speak(turn.spelled);
    } catch (error, stack) {
      await _failed(error, stack);
    } finally {
      _busy = false;
      if (mounted) setState(() => _capturing = false);
    }
  }

  /// Starts a slow-spell word. Starting one captures nothing; the first still
  /// is taken on the next single click, once the signer is holding a letter.
  Future<void> startWord() async {
    if (_busy || frame == null || _word.inProgress) return;
    _busy = true;
    try {
      if (!await _consented()) return;
      _letterStills.clear();
      final started = _word.start();
      if (mounted) {
        setState(() {
          _word = started;
          _fixing = null;
          _status = slowSpellStart;
          _hint = '';
          _captureDetail = 'Spelling a word. Nothing is captured between letters.';
        });
      }
      await _showOnGlasses(slowSpellPanel(started));
    } finally {
      _busy = false;
    }
  }

  /// One still for the letter the signer is holding now. The flash and the
  /// phone's capture banner are what both parties read the rhythm off.
  Future<void> captureLetter() async {
    if (_busy || frame == null || !_word.canCapture) return;
    _busy = true;
    try {
      if (!await _consented()) return;
      final taking = _word.takingLetter();
      if (mounted) {
        setState(() {
          _word = taking;
          _capturing = true;
          _status = 'Capturing letter ${taking.captured + 1}…';
          _hint = '';
        });
      }
      await _showOnGlasses(slowSpellPanel(taking));
      final photo = await capture();
      _letterStills.add(photo.$1);
      final taken = taking.letterTaken();
      if (mounted) {
        setState(() {
          _word = taken;
          _capturing = false;
          _image = Image.memory(photo.$1, gaplessPlayback: true);
          _captureDetail = 'Letter ${taken.captured} of this word. Read for this turn only, then deleted.';
          _status = taken.isFull
              ? slowSpellFull
              : 'Letter ${taken.captured} captured. Click for the next, or double click to read the word.';
        });
      }
      // The device handler flashes and then clears for every still, so the
      // progress panel has to be redrawn after the capture as well as before it.
      await _showOnGlasses(slowSpellPanel(taken));
    } catch (error, stack) {
      _dropWord();
      await _failed(error, stack);
    } finally {
      _busy = false;
      if (mounted) setState(() => _capturing = false);
    }
  }

  /// Double click: no more letters. The stills are read as one word and dropped
  /// whatever comes back.
  Future<void> finishWord() async {
    if (_busy || frame == null || !_word.inProgress) return;
    if (!_word.canSubmit) {
      if (mounted) {
        setState(() {
          _status = slowSpellTooShort;
          _hint = '';
        });
      }
      await _showOnGlasses(slowSpellPanel(_word));
      return;
    }
    _busy = true;
    try {
      final reading = _word.submitting();
      if (mounted) {
        setState(() {
          _word = reading;
          _status = slowSpellReading;
          _hint = '';
          _captureDetail = 'Read for this turn only, then deleted.';
        });
      }
      await _showOnGlasses(slowSpellPanel(reading));
      final stills = List<Uint8List>.of(_letterStills);
      _letterStills.clear();
      final turn = await _slowSpell(stills);
      _english = turn.spelled;
      if (mounted) {
        setState(() {
          _word = _word.read(turn.letters);
          _fixing = null;
          _status = turn.status;
          _hint = turn.hint;
          _correction.text = turn.spelled;
        });
      }
      await _showChunks(turn.chunks);
      if (turn.canSpeak) await _speech.speak(turn.spelled);
    } catch (error, stack) {
      _dropWord();
      await _failed(error, stack);
    } finally {
      _busy = false;
      if (mounted) setState(() => _capturing = false);
    }
  }

  /// Long press. The word and every still taken for it go away. A cancel lands
  /// between letters; a still already in flight finishes first.
  Future<void> cancelWord() async {
    if (_busy || !_word.inProgress) return;
    _dropWord();
    if (mounted) {
      setState(() {
        _status = slowSpellCancelled;
        _hint = '';
        _captureDetail = 'Nothing has been captured.';
      });
    }
    await _showOnGlasses('word abandoned');
  }

  void _dropWord() {
    _letterStills.clear();
    if (mounted) {
      setState(() {
        _word = SlowSpellWord.idle;
        _fixing = null;
      });
    }
  }

  /// Fixes one letter in place, so a wrong reading does not cost the whole word.
  /// A single still cannot be re-read on its own — the preprocessing needs two
  /// frames — so the correction is made here rather than by capturing again.
  Future<void> _fixLetter(int index, String? letter) async {
    final fixed = letter == null ? _word.withoutLetter(index) : _word.withLetter(index, letter);
    _english = fixed.word;
    if (mounted) {
      setState(() {
        _word = fixed;
        _fixing = null;
        _status = fixed.word;
        _hint = '';
        _correction.text = fixed.word;
      });
    }
    await _showChunks(captionChunks(provisionalCaption(fixed.word)));
  }

  /// The continuous route, unchanged. Twenty to thirty seconds end to end, and
  /// not a conversation.
  Future<void> translateBurst() async {
    if (_busy || frame == null) return;
    _busy = true;
    try {
      if (!await _consented()) return;
      final frames = await _captureBurst('Translating…');
      final result = await _translate(frames);
      _english = result.english;
      if (mounted) {
        setState(() {
          _status = result.status;
          _hint = '';
          _correction.text = result.english;
        });
      }
      // Paced off the clamped English rather than glassesText, which is already
      // cut to four lines; panels are what makes more than four readable. The
      // fallback carries the no-English notice, which has no English in it.
      await _showChunks(captionChunks(result.canSpeak ? result.english : result.glassesText));
      if (result.canSpeak) await _speech.speak(result.english);
    } catch (error, stack) {
      await _failed(error, stack);
    } finally {
      _busy = false;
      if (mounted) setState(() => _capturing = false);
    }
  }

  Future<void> _failed(Object error, StackTrace stack) async {
    _log.warning('Burst failed', error, stack);
    if (mounted) {
      setState(() {
        _status = 'The burst did not finish. Keep the glasses connected and try again.';
        _hint = '';
      });
    }
    await _showOnGlasses('Try the tap again');
  }

  /// Nothing reaches the camera before this returns true.
  Future<bool> _consented() async {
    if (mayCapture(_consent)) return true;
    if (!mounted) return false;
    final agreed = await ConsentScreen.ask(context);
    if (!agreed) {
      if (mounted) {
        setState(() {
          _consent = null;
          _status = consentMissing;
          _hint = '';
        });
      }
      return false;
    }
    if (mounted) setState(() => _consent = grantConsent());
    return true;
  }

  void _endSession() {
    _letterStills.clear();
    setState(() {
      _consent = null;
      _word = SlowSpellWord.idle;
      _fixing = null;
      _status = 'Session ended. Nothing further will be captured.';
      _hint = '';
      _image = null;
      _captureDetail = 'Nothing has been captured.';
    });
    _showOnGlasses('Session ended');
  }

  Future<List<Uint8List>> _captureBurst(String working) async {
    if (mounted) {
      setState(() {
        _capturing = true;
        _status = 'Capturing a short burst…';
        _hint = '';
      });
    }
    final frames = <Uint8List>[];
    for (var i = 0; i < burstFrameCount; i++) {
      // The device-side handler flashes and then clears for every still, so the
      // wearer's capture cue has to be redrawn before each one.
      await _showOnGlasses('RECORDING\n${i + 1} of $burstFrameCount');
      final photo = await capture();
      frames.add(photo.$1);
      if (mounted) {
        setState(() {
          _image = Image.memory(photo.$1, gaplessPlayback: true);
          _captureDetail = 'Photo ${i + 1} of $burstFrameCount.';
        });
      }
      if (i + 1 < burstFrameCount) await Future.delayed(burstGap);
    }
    if (mounted) {
      setState(() {
        _capturing = false;
        _status = working;
        _captureDetail = 'Read for this turn only, then deleted.';
      });
    }
    return frames;
  }

  Future<SpelledTurn> _spell(List<Uint8List> frames) async {
    final session = _consent;
    final endpoint = spellUrlOverride.isNotEmpty ? spellUrlOverride : spellUrlFrom(inferenceUrl);
    if (endpoint.isEmpty || session == null) {
      return spelledFromResponse(statusCode: null, body: '', frames: frames.length);
    }
    final response = await http
        .post(
          Uri.parse(endpoint),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({
            'source': 'bitsign-vision',
            'frames': frames.map(base64Encode).toList(),
            'mime': 'image/jpeg',
            'consent': session.toPayload(),
          }),
        )
        .timeout(const Duration(seconds: 60));
    return spelledFromResponse(statusCode: response.statusCode, body: response.body, frames: frames.length);
  }

  /// The same route and the same consent, with the mode that tells the service
  /// each still is one deliberate letter and repeats are not to be collapsed.
  Future<SlowSpelledTurn> _slowSpell(List<Uint8List> stills) async {
    final session = _consent;
    final endpoint = spellUrlOverride.isNotEmpty ? spellUrlOverride : spellUrlFrom(inferenceUrl);
    if (endpoint.isEmpty || session == null) {
      return slowSpelledFromResponse(statusCode: null, body: '', letters: stills.length);
    }
    final response = await http
        .post(
          Uri.parse(endpoint),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({
            'source': 'bitsign-vision',
            'frames': stills.map(base64Encode).toList(),
            'mime': 'image/jpeg',
            'mode': spellModeSlow,
            'consent': session.toPayload(),
          }),
        )
        .timeout(const Duration(seconds: 60));
    return slowSpelledFromResponse(
      statusCode: response.statusCode,
      body: response.body,
      letters: stills.length,
    );
  }

  Future<Translation> _translate(List<Uint8List> frames) async {
    final session = _consent;
    if (inferenceUrl.isEmpty || session == null) {
      return translationFromResponse(statusCode: null, body: '', frames: frames.length);
    }
    final response = await http
        .post(
          Uri.parse(inferenceUrl),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({
            'source': 'bitsign-vision',
            'frames': frames.map(base64Encode).toList(),
            'mime': 'image/jpeg',
            'consent': session.toPayload(),
          }),
        )
        .timeout(const Duration(seconds: 30));
    return translationFromResponse(statusCode: response.statusCode, body: response.body, frames: frames.length);
  }

  /// One panel at a time, blanked between panels because the Halo display has
  /// no double buffer. The last panel is left up until the next capture.
  Future<void> _showChunks(List<String> chunks) async {
    for (var i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await _showOnGlasses('');
        await Future.delayed(captionBlank);
      }
      await _showOnGlasses(chunks[i]);
      if (i + 1 < chunks.length) await Future.delayed(captionHold);
    }
  }

  Future<void> _showOnGlasses(String text) async {
    if (frame == null) return;
    final message = TxPlainText(text: text);
    await frame!.sendMessage(0x0a, message.pack());
  }

  Future<void> _useCorrection() async {
    final corrected = _correction.text.trim();
    if (corrected.isEmpty) return;
    _english = corrected;
    if (mounted) {
      setState(() {
        _status = corrected;
        _hint = '';
      });
    }
    await _showChunks(captionChunks(corrected));
    await _speech.speak(corrected);
  }

  /// The same three choices as the glasses gestures, for whoever is holding the
  /// phone rather than clicking the temple.
  List<Widget> _spellingControls() => [
        Text('${_word.captured} of up to $slowSpellMaxLetters letters captured. Next is letter ${_word.captured + 1}.'),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: _busy || !_word.canCapture ? null : captureLetter,
          child: Text(_word.captured == 0 ? 'Capture the first letter' : 'Capture the next letter'),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy || !_word.canSubmit ? null : finishWord,
          child: const Text('Done, read the word'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _busy ? null : cancelWord,
          child: const Text('Abandon this word'),
        ),
      ];

  /// One chip per captured position. Tapping one opens the label set for that
  /// position only, which is what keeps a single wrong letter from costing the
  /// whole word.
  List<Widget> _letterChips() => [
        Text('Tap a letter to fix just that one.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (var i = 0; i < _word.letters.length; i++)
              ChoiceChip(
                label: Text(_word.letters[i].trim().isEmpty ? '␣' : _word.letters[i]),
                selected: _fixing == i,
                onSelected: _busy ? null : (_) => setState(() => _fixing = _fixing == i ? null : i),
              ),
          ],
        ),
      ];

  List<Widget> _letterPicker(int index) => [
        const SizedBox(height: 12),
        Text('Letter ${index + 1} of ${_word.letters.length}'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 4,
          runSpacing: 4,
          children: [
            for (final letter in spellableLetters.split(''))
              SizedBox(
                width: 40,
                height: 40,
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(padding: EdgeInsets.zero),
                  onPressed: _busy ? null : () => _fixLetter(index, letter),
                  child: Text(letter),
                ),
              ),
            TextButton(
              onPressed: _busy ? null : () => _fixLetter(index, null),
              child: const Text('Remove'),
            ),
          ],
        ),
      ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('BitSign Vision'),
        actions: [getBatteryWidget()],
      ),
      drawer: getCameraDrawer(),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          CaptureBanner(live: _capturing, detail: _captureDetail),
          const SizedBox(height: 16),
          ConsentRow(session: _consent, onEnd: _endSession),
          const SizedBox(height: 16),
          Text(_status),
          if (_hint.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_hint, style: Theme.of(context).textTheme.bodySmall),
          ],
          const SizedBox(height: 12),
          const Text('Frame: tap three times. Halo: click once. The other person fingerspells a short phrase, the phone reads it, and the letters show here and on the glasses. Fix them below if they came back wrong.'),
          const SizedBox(height: 8),
          const Text('The camera takes about one photo a second and fingerspelling is far faster than that, so most of the letters are never seen. Spelling one letter at a time is slower than signing, but every letter gets its own photo. Halo: double click to start a word, click once for each letter, double click when it is done, long press to abandon it.'),
          const SizedBox(height: 16),
          if (_word.inProgress)
            ..._spellingControls()
          else ...[
            FilledButton(
              onPressed: _busy ? null : spellTurn,
              child: const Text('Read fingerspelling'),
            ),
            const SizedBox(height: 8),
            FilledButton.tonal(
              onPressed: _busy ? null : startWord,
              child: const Text('Spell one letter at a time'),
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _busy ? null : translateBurst,
              child: const Text('Translate this burst instead'),
            ),
          ],
          if (_word.letters.isNotEmpty) ...[
            const SizedBox(height: 16),
            ..._letterChips(),
            if (_fixing != null) ..._letterPicker(_fixing!),
          ],
          if (_english.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(_english, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            TextField(
              controller: _correction,
              enabled: !_busy,
              decoration: const InputDecoration(labelText: 'Correct the letters', border: OutlineInputBorder()),
              onSubmitted: (_) => _useCorrection(),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _busy ? null : _useCorrection,
              child: const Text('Use this instead'),
            ),
          ],
          if (_image != null) ...[
            const SizedBox(height: 16),
            _image!,
          ],
        ],
      ),
      floatingActionButton: getFloatingActionButtonWidget(const Icon(Icons.bluetooth), const Icon(Icons.close)),
      persistentFooterButtons: getFooterButtonsWidget(),
    );
  }
}
