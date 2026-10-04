import 'dart:math';

import 'package:bitsign/vision/consent.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('no consent means no capture', () {
    expect(mayCapture(null), isFalse);
  });

  test('consent covers the conversation it was given in and then lapses', () {
    final granted = DateTime(2026, 10, 3, 12);
    final session = ConsentSession(id: 'abc', grantedAt: granted);
    expect(mayCapture(session, now: granted), isTrue);
    expect(mayCapture(session, now: granted.add(const Duration(minutes: 29))), isTrue);
    expect(mayCapture(session, now: granted.add(consentLifetime)), isFalse);
    expect(mayCapture(session, now: granted.add(const Duration(hours: 4))), isFalse);
  });

  test('the payload is what the service checks, and it is live-only', () {
    final granted = DateTime.utc(2026, 10, 3, 12);
    final payload = ConsentSession(id: 'abc', grantedAt: granted).toPayload();
    expect(payload['granted'], isTrue);
    expect(payload['scope'], 'live-translation-only');
    expect(payload['session'], 'abc');
    expect(payload['granted_at'], '2026-10-03T12:00:00.000Z');
  });

  test('a session id carries nothing about the signer', () {
    final first = newSessionId(Random(1));
    final second = newSessionId(Random(2));
    expect(first.length, 16);
    expect(RegExp(r'^[0-9a-f]{16}$').hasMatch(first), isTrue);
    expect(first, isNot(second));
  });

  test('granting consent produces a session that may capture now', () {
    final session = grantConsent();
    expect(mayCapture(session), isTrue);
    expect(session.toPayload()['scope'], consentScope);
  });

  test('the wording asks the signer, and promises nothing is kept', () {
    expect(consentBody, contains('deleted'));
    expect(consentBody, contains('never'));
    expect(consentBody, contains('train'));
    expect(consentBody, contains('reward'));
    expect(consentMissing, contains('Nothing was captured'));
  });
}
