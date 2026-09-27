import 'package:flutter/material.dart';

import 'signrush_tab.dart';
import 'vision_tab.dart';

void main() => runApp(const BitSignApp());

class BitSignApp extends StatefulWidget {
  const BitSignApp({super.key});

  @override
  State<BitSignApp> createState() => _BitSignAppState();
}

class _BitSignAppState extends State<BitSignApp> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'BitSign',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF244C40), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: Scaffold(
        body: SafeArea(
          child: _index == 0 ? const SignRushTab() : const VisionTab(),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (index) => setState(() => _index = index),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.sports_esports_outlined), selectedIcon: Icon(Icons.sports_esports), label: 'SignRush'),
            NavigationDestination(icon: Icon(Icons.visibility_outlined), selectedIcon: Icon(Icons.visibility), label: 'Vision'),
          ],
        ),
      ),
    );
  }
}
