import 'dart:convert';

/// Four stills, about a few seconds apart. Bluetooth photo transfer is the
/// capture path; this is not a 30 fps video stream.
const burstFrameCount = 4;
const burstGap = Duration(milliseconds: 900);
const maxEnglishChars = 240;

class Translation {
  final String english;
  final String glassesText;
  final String status;

  const Translation({
    required this.english,
    required this.glassesText,
    required this.status,
  });

  bool get canSpeak => english.isNotEmpty;
}

/// Wraps English onto the glasses. Frame and Halo both take short lines.
String glassesLines(String text, {int lineChars = 22, int maxLines = 4}) {
  final words = text.trim().split(RegExp(r'\s+')).where((word) => word.isNotEmpty);
  final lines = <String>[];
  var line = '';
  for (final word in words) {
    final next = line.isEmpty ? word : '$line $word';
    if (next.length <= lineChars) {
      line = next;
      continue;
    }
    if (line.isNotEmpty) lines.add(line);
    line = word.length <= lineChars ? word : word.substring(0, lineChars);
    if (lines.length == maxLines) return lines.join('\n');
  }
  if (line.isNotEmpty && lines.length < maxLines) lines.add(line);
  return lines.take(maxLines).join('\n');
}

Translation translationFromResponse({
  required int? statusCode,
  required String body,
  required int frames,
}) {
  if (statusCode == null) {
    return Translation(
      english: '',
      glassesText: glassesLines('$frames frames\nNo translation yet'),
      status: 'Inference is not connected. The burst stayed on this phone and was not added to SignRush.',
    );
  }
  if (statusCode < 200 || statusCode >= 300) {
    return Translation(
      english: '',
      glassesText: glassesLines('Translation failed\nTry the tap again'),
      status: 'The translation service returned $statusCode.',
    );
  }
  final english = _englishField(body);
  if (english == null || english.isEmpty) {
    final reason = _reasonField(body);
    return Translation(
      english: '',
      glassesText: glassesLines('$frames frames\nNo English returned'),
      status: reason ?? 'The service answered without an English line.',
    );
  }
  final clipped = english.length <= maxEnglishChars ? english : english.substring(0, maxEnglishChars);
  return Translation(
    english: clipped,
    glassesText: glassesLines(clipped),
    status: clipped,
  );
}

Map<String, Object?>? _object(String body) {
  try {
    final decoded = jsonDecode(body);
    if (decoded is! Map) return null;
    return decoded.map((key, value) => MapEntry(key.toString(), value));
  } catch (_) {
    return null;
  }
}

String? _englishField(String body) {
  final value = _object(body)?['english'];
  if (value is! String) return null;
  return value.trim();
}

String? _reasonField(String body) {
  final value = _object(body)?['reason'];
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}
