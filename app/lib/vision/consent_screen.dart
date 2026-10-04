import 'package:flutter/material.dart';

import 'consent.dart';

/// Turned toward the person in front of the camera, not the wearer. Returns
/// true only on an explicit tap of the agree button; a back gesture declines.
class ConsentScreen extends StatelessWidget {
  const ConsentScreen({super.key});

  static Future<bool> ask(BuildContext context) async {
    final agreed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const ConsentScreen(), fullscreenDialog: true),
    );
    return agreed ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: theme.colorScheme.surface,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Icon(Icons.videocam_outlined, size: 56, color: theme.colorScheme.error),
            const SizedBox(height: 16),
            Text(consentHeadline, style: theme.textTheme.headlineMedium),
            const SizedBox(height: 16),
            Text(consentBody, style: theme.textTheme.titleMedium),
            const SizedBox(height: 32),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(consentAgree),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(consentDecline),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The capture indicator. The glasses cannot show the subject anything, so this
/// is the only place capture is visible to the person being recorded, and it
/// has to stay on screen for the whole burst rather than flash.
class CaptureBanner extends StatelessWidget {
  final bool live;
  final String detail;

  const CaptureBanner({super.key, required this.live, required this.detail});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = live
        ? (theme.colorScheme.errorContainer, theme.colorScheme.onErrorContainer)
        : (theme.colorScheme.surfaceContainerHighest, theme.colorScheme.onSurfaceVariant);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(color: colors.$1, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          Icon(live ? Icons.fiber_manual_record : Icons.videocam_off_outlined, color: colors.$2),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              live ? 'Recording now. $detail' : 'Camera off. $detail',
              style: theme.textTheme.titleMedium?.copyWith(color: colors.$2),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shows whether a conversation is consented, and lets the signer end it.
class ConsentRow extends StatelessWidget {
  final ConsentSession? session;
  final VoidCallback onEnd;

  const ConsentRow({super.key, required this.session, required this.onEnd});

  @override
  Widget build(BuildContext context) {
    if (session == null) {
      return Text(consentMissing, style: Theme.of(context).textTheme.bodyMedium);
    }
    return Row(
      children: [
        Expanded(
          child: Text(
            'Consented for this conversation.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
        TextButton(onPressed: onEnd, child: const Text(consentEnd)),
      ],
    );
  }
}
