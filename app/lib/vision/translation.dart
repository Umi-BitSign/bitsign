import 'dart:convert';

/// Four stills, about a few seconds apart. Bluetooth photo transfer is the
/// capture path; this is not a 30 fps video stream.
const burstFrameCount = 4;
const burstGap = Duration(milliseconds: 900);
const maxEnglishChars = 240;

/// Slow-spell sends one still per letter instead of a burst. The service caps a
/// word at twelve and needs at least two, because the encoder reads one
/// timestep per still and the preprocessing needs two frames to work at all.
const slowSpellMinLetters = 2;
const slowSpellMaxLetters = 12;

/// Which decode the service should run. The burst and a word of held letters
/// are the same request shape and want opposite decoding, so the mode is sent
/// rather than inferred.
const spellModeContinuous = 'continuous';
const spellModeSlow = 'slow-spell';

/// The drawable area is 256x256 and circular, so the widest rectangle that is
/// safe at any vertical position is 181px, which is 22 Dogica characters.
const glassesLineChars = 22;
const glassesMaxLines = 4;

/// Two lines a panel. Four lines of 22 is about sixteen words, which is six
/// seconds of reading and too much to raise at once. The blank between panels
/// is there because the display has no double buffer, so two panels that share
/// a first line would otherwise be indistinguishable. The last panel is held
/// until the next capture rather than timed out.
const captionLinesPerChunk = 2;
const captionHold = Duration(milliseconds: 3200);
const captionBlank = Duration(milliseconds: 300);

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
String glassesLines(String text, {int lineChars = glassesLineChars, int maxLines = glassesMaxLines}) {
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

/// Wraps without dropping anything. A word wider than the panel is split rather
/// than cut, because a fingerspelled answer is one token and a cut one reads as
/// a different word.
List<String> captionLines(String text, {int lineChars = glassesLineChars}) {
  final lines = <String>[];
  var line = '';
  for (final word in text.trim().split(RegExp(r'\s+')).where((word) => word.isNotEmpty)) {
    var rest = word;
    while (rest.length > lineChars) {
      if (line.isNotEmpty) {
        lines.add(line);
        line = '';
      }
      lines.add(rest.substring(0, lineChars));
      rest = rest.substring(lineChars);
    }
    if (rest.isEmpty) continue;
    final next = line.isEmpty ? rest : '$line $rest';
    if (next.length <= lineChars) {
      line = next;
      continue;
    }
    if (line.isNotEmpty) lines.add(line);
    line = rest;
  }
  if (line.isNotEmpty) lines.add(line);
  return lines;
}

/// Splits wrapped text into the panels the display shows one at a time. A
/// fingerspelled answer is normally one panel of one line.
List<String> captionChunks(
  String text, {
  int lineChars = glassesLineChars,
  int linesPerChunk = captionLinesPerChunk,
}) {
  final lines = captionLines(text, lineChars: lineChars);
  final chunks = <String>[];
  for (var start = 0; start < lines.length; start += linesPerChunk) {
    final end = start + linesPerChunk;
    chunks.add(lines.sublist(start, end < lines.length ? end : lines.length).join('\n'));
  }
  return chunks;
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

/// Nothing in the fingerspelling path asserts an answer. Spelling error was
/// measured on studio video, not on head-mounted stills where a hand is about
/// 67 pixels across, so the real figure is worse and is not known. The reading
/// is offered, never stated, and the wearer can re-request or correct it.
const spelledHint = 'A reading, not a translation. Spell it again, or fix it by hand.';
const spelledNothing = 'Nothing legible came back. Ask for the phrase again.';

/// One turn of the glasses interaction: a click, a short burst, a reading.
class SpelledTurn {
  final String spelled;
  final List<String> chunks;
  final String status;
  final String hint;

  const SpelledTurn({
    required this.spelled,
    required this.chunks,
    required this.status,
    required this.hint,
  });

  bool get canSpeak => spelled.isNotEmpty;
}

/// Marks the reading as a reading on the glasses too. The wearer sees the same
/// uncertainty the phone shows.
String provisionalCaption(String spelled) => spelled.isEmpty ? '' : '$spelled?';

SpelledTurn spelledFromResponse({
  required int? statusCode,
  required String body,
  required int frames,
}) {
  if (statusCode == null) {
    return SpelledTurn(
      spelled: '',
      chunks: captionChunks('$frames frames\nNot connected'),
      status: 'Inference is not connected. The burst stayed on this phone and was not added to SignRush.',
      hint: '',
    );
  }
  final reason = _reasonField(body);
  final spelled = _spelledField(body);
  if (spelled == null || spelled.isEmpty) {
    return SpelledTurn(
      spelled: '',
      chunks: captionChunks(statusCode == 403 ? 'Consent first' : 'Spell again'),
      status: reason ?? 'The service answered without any letters.',
      hint: statusCode == 403 ? '' : spelledNothing,
    );
  }
  final clipped = spelled.length <= maxEnglishChars ? spelled : spelled.substring(0, maxEnglishChars);
  return SpelledTurn(
    spelled: clipped,
    chunks: captionChunks(provisionalCaption(clipped)),
    status: clipped,
    hint: spelledHint,
  );
}

/// Slow-spell is further out of the training distribution than the burst path.
/// The head was trained on continuous fingerspelling at about 8 Hz and never on
/// isolated letters held still for a camera, so per-letter accuracy may be
/// considerably worse than the burst path's. No figure is shown, because none
/// is known for this interaction on this hardware.
const slowSpelledHint = 'One reading per photo, not a translation. Fix any letter below.';

/// One slow-spell word. The letters are positional: one entry for each still
/// the phone asked for, in the order it asked, so a single wrong letter can be
/// fixed without spelling the word again.
class SlowSpelledTurn {
  final List<String> letters;
  final List<String> chunks;
  final String status;
  final String hint;

  const SlowSpelledTurn({
    required this.letters,
    required this.chunks,
    required this.status,
    required this.hint,
  });

  String get spelled => letters.join();

  bool get canSpeak => spelled.trim().isNotEmpty;
}

SlowSpelledTurn slowSpelledFromResponse({
  required int? statusCode,
  required String body,
  required int letters,
}) {
  if (statusCode == null) {
    return SlowSpelledTurn(
      letters: const [],
      chunks: captionChunks('$letters letters\nNot connected'),
      status: 'Inference is not connected. The stills stayed on this phone and were not added to SignRush.',
      hint: '',
    );
  }
  final reason = _reasonField(body);
  // Only the positional field is read. The spelled string is trimmed by the
  // service for the burst path, and a trimmed word would shift every letter
  // after a dropped space out of the position it was captured in.
  final read = _lettersField(body);
  if (read == null || read.join().trim().isEmpty) {
    return SlowSpelledTurn(
      letters: const [],
      chunks: captionChunks(statusCode == 403 ? 'Consent first' : 'Spell again'),
      status: reason ?? 'The service answered without any letters.',
      hint: statusCode == 403 ? '' : spelledNothing,
    );
  }
  final clipped = read.take(slowSpellMaxLetters).toList();
  return SlowSpelledTurn(
    letters: clipped,
    chunks: captionChunks(provisionalCaption(clipped.join())),
    status: clipped.join(),
    hint: slowSpelledHint,
  );
}

/// The service answers /fingerspell beside /translate on the same host.
String spellUrlFrom(String translateUrl) {
  final parsed = Uri.tryParse(translateUrl);
  if (translateUrl.isEmpty || parsed == null) return '';
  final segments = parsed.pathSegments.where((segment) => segment.isNotEmpty).toList();
  if (segments.isEmpty) return parsed.replace(path: '/fingerspell').toString();
  segments[segments.length - 1] = 'fingerspell';
  return parsed.replace(pathSegments: segments).toString();
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

String? _spelledField(String body) {
  final value = _object(body)?['spelled'];
  if (value is! String) return null;
  return value.trim();
}

/// One entry per still, untrimmed. A non-string anywhere in the list makes the
/// whole list untrustworthy rather than one entry, because dropping an entry
/// would renumber the letters after it.
List<String>? _lettersField(String body) {
  final value = _object(body)?['letters'];
  if (value is! List || value.any((item) => item is! String)) return null;
  return value.cast<String>().toList();
}
