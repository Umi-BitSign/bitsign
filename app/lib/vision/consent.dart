import 'dart:math';

/// The glasses have no outward recording indicator an app can drive. There is
/// one LED and the firmware owns it, there is no `frame.led` in the Lua API,
/// and the speakers are bone conduction so a cue reaches the wearer's skull
/// and nobody else. The phone is therefore the only consent surface, and it
/// has to be turned toward the person in front of the camera.
const consentScope = 'live-translation-only';

/// A session lapses on its own so that glasses left connected cannot keep
/// capturing against consent given for an earlier conversation.
const consentLifetime = Duration(minutes: 30);

const consentHeadline = 'This person is wearing a camera';
const consentBody =
    'The glasses take a few still photos each time their wearer asks, so this '
    'phone can read fingerspelling and show English. Photos of you and your '
    'hands leave the glasses only to be read, are deleted straight afterwards, '
    'and are never kept, never used to train anything, and never part of any '
    'game or reward. Nothing is captured until you agree, and you can end this '
    'at any time.';
const consentAgree = 'I agree to be recorded';
const consentDecline = 'No';
const consentEnd = 'End session';
const consentMissing = 'Hand the phone to the person signing and ask first. Nothing was captured.';

/// Consent granted by the person in front of the camera, for one conversation.
class ConsentSession {
  final String id;
  final DateTime grantedAt;

  const ConsentSession({required this.id, required this.grantedAt});

  bool usableAt(DateTime now) => now.difference(grantedAt) < consentLifetime;

  /// What the service checks. A burst without this is refused server-side.
  Map<String, Object?> toPayload() => {
        'granted': true,
        'scope': consentScope,
        'session': id,
        'granted_at': grantedAt.toUtc().toIso8601String(),
      };
}

/// Carries nothing about the signer. It exists to tie the bursts of one
/// conversation to the one screen that consent was given on.
String newSessionId([Random? source]) {
  final random = source ?? Random.secure();
  return List.generate(16, (_) => random.nextInt(16).toRadixString(16)).join();
}

ConsentSession grantConsent({DateTime? now, Random? source}) =>
    ConsentSession(id: newSessionId(source), grantedAt: now ?? DateTime.now());

/// True when a burst may be captured. Absent or lapsed consent means no.
bool mayCapture(ConsentSession? session, {DateTime? now}) =>
    session != null && session.usableAt(now ?? DateTime.now());
