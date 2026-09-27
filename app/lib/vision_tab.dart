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

import 'vision/translation.dart';

final _log = Logger('BitSignVision');

/// Set at build time: `--dart-define=BITSIGN_INFERENCE_URL=https://...`
/// The service must answer JSON `{"english":"..."}`. Frames are not stored in SignRush.
const inferenceUrl = String.fromEnvironment('BITSIGN_INFERENCE_URL');

class VisionTab extends StatefulWidget {
  const VisionTab({super.key});

  @override
  State<VisionTab> createState() => VisionTabState();
}

class VisionTabState extends State<VisionTab> with SimpleFrameAppState, BrilliantVisionAppState {
  final FlutterTts _speech = FlutterTts();
  Image? _image;
  String _status = 'Connect Frame or Halo, then tap to translate.';
  String _english = '';
  bool _busy = false;

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
  Future<void> onRun() async {
    await _showOnGlasses('3 taps, or the Halo button');
  }

  @override
  Future<void> onCancel() async {}

  @override
  Future<void> onTap(int taps) async {
    if (taps >= 3) await translateBurst();
  }

  @override
  Future<void> onClick(ClickType type) async {
    if (type == ClickType.single) await translateBurst();
  }

  Future<void> translateBurst() async {
    if (_busy || frame == null) return;
    _busy = true;
    if (mounted) setState(() => _status = 'Capturing a short burst…');
    await _showOnGlasses('Capturing');
    final frames = <Uint8List>[];
    try {
      for (var i = 0; i < burstFrameCount; i++) {
        final photo = await capture();
        frames.add(photo.$1);
        if (mounted) {
          setState(() {
            _image = Image.memory(photo.$1, gaplessPlayback: true);
            _status = 'Captured ${i + 1} of $burstFrameCount';
          });
        }
        if (i + 1 < burstFrameCount) await Future.delayed(burstGap);
      }
      final result = await _translate(frames);
      _english = result.english;
      if (mounted) setState(() => _status = result.status);
      await _showOnGlasses(result.glassesText);
      if (result.canSpeak) await _speech.speak(result.english);
    } catch (error, stack) {
      _log.warning('Burst failed', error, stack);
      if (mounted) setState(() => _status = 'The burst did not finish. Keep the glasses connected and try again.');
      await _showOnGlasses('Try the tap again');
    } finally {
      _busy = false;
    }
  }

  Future<Translation> _translate(List<Uint8List> frames) async {
    if (inferenceUrl.isEmpty) {
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
          }),
        )
        .timeout(const Duration(seconds: 30));
    return translationFromResponse(statusCode: response.statusCode, body: response.body, frames: frames.length);
  }

  Future<void> _showOnGlasses(String text) async {
    if (frame == null) return;
    final message = TxPlainText(text: text);
    await frame!.sendMessage(0x0a, message.pack());
  }

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
          Text(_status),
          const SizedBox(height: 12),
          const Text('Frame: tap three times. Halo: click once. The phone sends a few stills to the UMI model. English shows here and on the glasses only when that model returns a line.'),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : translateBurst,
            child: const Text('Translate this burst'),
          ),
          if (_english.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(_english, style: Theme.of(context).textTheme.headlineSmall),
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
