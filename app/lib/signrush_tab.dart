import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// The live SignRush host. signrush.io does not answer HTTPS until its DNS
/// points at Firebase, so the tab loads the host that actually serves the app.
const signRushUrl = 'https://signrush-login.web.app/';

class SignRushTab extends StatefulWidget {
  const SignRushTab({super.key});

  @override
  State<SignRushTab> createState() => _SignRushTabState();
}

class _SignRushTabState extends State<SignRushTab> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..loadRequest(Uri.parse(signRushUrl));
  }

  @override
  Widget build(BuildContext context) {
    return WebViewWidget(controller: _controller);
  }
}
