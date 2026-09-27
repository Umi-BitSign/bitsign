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
}
