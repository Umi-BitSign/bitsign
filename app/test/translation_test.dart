import 'package:bitsign/vision/translation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a missing inference service does not invent English', () {
    final result = translationFromResponse(statusCode: null, body: '', frames: 4);
    expect(result.english, isEmpty);
    expect(result.canSpeak, isFalse);
    expect(result.glassesText, contains('4 frames'));
    expect(result.status, contains('not connected'));
  });

  test('a successful response speaks only the English field', () {
    final result = translationFromResponse(
      statusCode: 200,
      body: '{"english":"I can help you.","other":"hidden"}',
      frames: 4,
    );
    expect(result.english, 'I can help you.');
    expect(result.canSpeak, isTrue);
    expect(result.glassesText, 'I can help you.');
  });

  test('long English wraps onto a few glasses lines', () {
    final result = translationFromResponse(
      statusCode: 200,
      body: '{"english":"please meet me at the station after work tonight"}',
      frames: 4,
    );
    expect(result.glassesText.split('\n').length, lessThanOrEqualTo(4));
    expect(result.glassesText.split('\n').every((line) => line.length <= 22), isTrue);
  });

  test('an empty model response shows the reason and does not speak', () {
    final result = translationFromResponse(
      statusCode: 200,
      body: '{"english":"","model":"umi-community-baseline-v0.2","reason":"The community baseline did not return an English line."}',
      frames: 4,
    );
    expect(result.english, isEmpty);
    expect(result.canSpeak, isFalse);
    expect(result.status, 'The community baseline did not return an English line.');
  });

  test('an error status does not speak', () {
    final result = translationFromResponse(statusCode: 503, body: '{"english":"nope"}', frames: 4);
    expect(result.canSpeak, isFalse);
    expect(result.glassesText, contains('Translation failed'));
    expect(result.glassesText, contains('tap again'));
  });

  test('a fingerspelled phrase is one panel of one line', () {
    final chunks = captionChunks('kathryn');
    expect(chunks, ['kathryn']);
  });

  test('chunking keeps every character and every line inside the panel', () {
    const text = 'please meet me at the station after work tonight';
    final chunks = captionChunks(text);
    expect(chunks.length, 2);
    for (final chunk in chunks) {
      final lines = chunk.split('\n');
      expect(lines.length, lessThanOrEqualTo(captionLinesPerChunk));
      expect(lines.every((line) => line.length <= glassesLineChars), isTrue);
    }
    final rebuilt = chunks.expand((chunk) => chunk.split('\n')).join(' ');
    expect(rebuilt.replaceAll(' ', ''), text.replaceAll(' ', ''));
  });

  test('a token wider than the panel is split, not cut', () {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final lines = captionLines(token);
    expect(lines.length, 2);
    expect(lines.join(), token);
  });

  test('nothing to show is no panels at all', () {
    expect(captionChunks(''), isEmpty);
    expect(captionChunks('   '), isEmpty);
  });

  test('a spelled turn is offered, never asserted', () {
    final turn = spelledFromResponse(
      statusCode: 200,
      body: '{"english":"kathryn","spelled":"kathryn","provisional":true,"retained":false}',
      frames: 4,
    );
    expect(turn.spelled, 'kathryn');
    expect(turn.canSpeak, isTrue);
    expect(turn.chunks, ['kathryn?']);
    expect(turn.hint, spelledHint);
    expect(turn.hint, isNot(contains('%')));
  });

  test('a refused capture shows the reason and spells nothing', () {
    final turn = spelledFromResponse(
      statusCode: 403,
      body: '{"english":"","spelled":"","error":"consent_required","reason":"No consent was recorded for this capture, so the burst was not read."}',
      frames: 4,
    );
    expect(turn.spelled, isEmpty);
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('No consent'));
    expect(turn.chunks, ['Consent first']);
  });

  test('a missing head shows the reason and invites another turn', () {
    final turn = spelledFromResponse(
      statusCode: 200,
      body: '{"english":"","spelled":"","error":"spell_head_missing","reason":"The fingerspelling head is not installed."}',
      frames: 4,
    );
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('not installed'));
    expect(turn.hint, spelledNothing);
  });

  test('a missing service does not invent letters', () {
    final turn = spelledFromResponse(statusCode: null, body: '', frames: 4);
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('not connected'));
  });

  test('a slow-spelled word keeps its double letter', () {
    final turn = slowSpelledFromResponse(
      statusCode: 200,
      body: '{"english":"kelly","spelled":"kelly","mode":"slow-spell",'
          '"letters":["k","e","l","l","y"],"provisional":true,"retained":false}',
      letters: 5,
    );
    expect(turn.letters, ['k', 'e', 'l', 'l', 'y']);
    expect(turn.spelled, 'kelly');
    expect(turn.chunks, ['kelly?']);
    expect(turn.hint, slowSpelledHint);
  });

  test('a slow-spelled answer holds one letter against each still', () {
    final turn = slowSpelledFromResponse(
      statusCode: 200,
      body: '{"spelled":" ab","mode":"slow-spell","letters":[" ","a","b"]}',
      letters: 3,
    );
    expect(turn.letters, [' ', 'a', 'b']);
    expect(turn.letters.length, 3);
  });

  test('a slow-spelled word is offered, never asserted, and quotes no figure', () {
    final turn = slowSpelledFromResponse(
      statusCode: 200,
      body: '{"spelled":"russell","letters":["r","u","s","s","e","l","l"]}',
      letters: 7,
    );
    expect(turn.chunks, ['russell?']);
    expect(turn.hint, isNot(contains('%')));
    expect(turn.hint, isNot(contains('40.5')));
    expect(turn.canSpeak, isTrue);
  });

  test('a slow-spelled answer without positions is not read', () {
    for (final body in <String>[
      '{"spelled":"kelly"}',
      '{"letters":"kelly"}',
      '{"letters":["k",2]}',
      '{"letters":[]}',
      '{"letters":["  "]}',
    ]) {
      final turn = slowSpelledFromResponse(statusCode: 200, body: body, letters: 5);
      expect(turn.letters, isEmpty, reason: body);
      expect(turn.canSpeak, isFalse, reason: body);
      expect(turn.chunks, ['Spell again'], reason: body);
    }
  });

  test('a refused slow-spell word shows the reason and spells nothing', () {
    final turn = slowSpelledFromResponse(
      statusCode: 403,
      body: '{"spelled":"","error":"consent_required","reason":"No consent was recorded for this capture, so the burst was not read."}',
      letters: 5,
    );
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('No consent'));
    expect(turn.chunks, ['Consent first']);
  });

  test('too few letters is reported, not invented around', () {
    final turn = slowSpelledFromResponse(
      statusCode: 200,
      body: '{"spelled":"","error":"too_few_letters","reason":"Slow-spell reads one letter per still and needs at least 2. No letters were read."}',
      letters: 1,
    );
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('at least 2'));
    expect(turn.hint, spelledNothing);
  });

  test('a missing service does not invent a slow-spelled word', () {
    final turn = slowSpelledFromResponse(statusCode: null, body: '', letters: 5);
    expect(turn.canSpeak, isFalse);
    expect(turn.status, contains('not connected'));
    expect(turn.chunks.join(' '), contains('5 letters'));
  });

  test('a word longer than one turn can carry is clipped, not wrapped around', () {
    final letters = List.filled(slowSpellMaxLetters + 4, 'a');
    final turn = slowSpelledFromResponse(
      statusCode: 200,
      body: '{"letters":${letters.map((letter) => '"$letter"').toList()}}',
      letters: letters.length,
    );
    expect(turn.letters.length, slowSpellMaxLetters);
  });

  test('the spelling route sits beside the translate route', () {
    expect(spellUrlFrom('http://192.168.1.5:8091/translate'), 'http://192.168.1.5:8091/fingerspell');
    expect(spellUrlFrom('https://bitsign.ai/api/v1/translate'), 'https://bitsign.ai/api/v1/fingerspell');
    expect(spellUrlFrom('http://192.168.1.5:8091/'), 'http://192.168.1.5:8091/fingerspell');
    expect(spellUrlFrom(''), isEmpty);
  });
}
