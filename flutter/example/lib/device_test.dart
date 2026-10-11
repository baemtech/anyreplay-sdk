import 'dart:math' as math;

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:flutter/material.dart';

/// A device-test app: every kind of widget the recorder claims to read.
///
///   flutter run -t lib/device_test.dart --dart-define=ANYREPLAY_KEY=… --dart-define=ANYREPLAY_INGEST=http://localhost:4501
///     [--dart-define=IMAGE_URL=http://localhost:4503/product.png]
///
/// tool/ios_drive drives it on an iOS simulator with real taps and keys.
void main() {
  const key = String.fromEnvironment('ANYREPLAY_KEY', defaultValue: 'ar_pk_test_000000000000000000000000');
  const ingest = String.fromEnvironment('ANYREPLAY_INGEST', defaultValue: 'http://localhost:4501');
  const image = String.fromEnvironment('IMAGE_URL', defaultValue: 'http://localhost:4503/product.png');
  AnyReplay.init(const AnyReplayOptions(projectKey: key, ingestUrl: ingest, debug: true));
  AnyReplay.identify(userId: 'qa_flutter_1', email: 'qa-flutter@example.com');
  runApp(const QaApp(imageUrl: image));
}

class QaApp extends StatelessWidget {
  const QaApp({super.key, required this.imageUrl});
  final String imageUrl;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'QA Shop',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF0E7490)),
      navigatorObservers: [AnyReplayNavigatorObserver()],
      initialRoute: '/home',
      routes: {
        '/home': (_) => HomeScreen(imageUrl: imageUrl),
        '/form': (_) => const FormScreen(),
        '/list': (_) => const ListScreen(),
      },
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.imageUrl});
  final String imageUrl;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Morning market'),
        actions: [IconButton(onPressed: () {}, icon: const Icon(Icons.shopping_cart), tooltip: 'Cart')],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text.rich(TextSpan(children: [
              TextSpan(text: 'Fresh bread ', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
              TextSpan(text: 'every morning', style: TextStyle(fontStyle: FontStyle.italic, color: Colors.teal)),
            ])),
            const SizedBox(height: 8),
            const Text('Baked before sunrise in small batches.', style: TextStyle(color: Colors.black54)),
            const SizedBox(height: 12),
            Row(children: [
              Image.asset('assets/logo.png', width: 48, height: 48),
              const SizedBox(width: 12),
              Image.network(imageUrl, width: 96, height: 96),
              const SizedBox(width: 12),
              const SizedBox(width: 64, height: 64, child: CustomPaint(painter: _Sun())),
            ]),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () {
                AnyReplay.track('form_opened', {'from': 'home'});
                Navigator.pushNamed(context, '/form');
              },
              icon: const Icon(Icons.edit),
              label: const Text('Open the order form'),
            ),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: () => Navigator.pushNamed(context, '/list'), child: const Text('See all loaves')),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => throw StateError('Oven thermometer unplugged'),
              child: const Text('Break the oven'),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('Closing early today'),
                  content: const Text('The shop closes at three on Sundays.'),
                  actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Got it'))],
                ),
              ),
              child: const Text('Show opening hours'),
            ),
            TextButton(
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                builder: (context) => const SizedBox(
                  height: 220,
                  child: Center(child: Text('Pick-up at the side door', style: TextStyle(fontSize: 18))),
                ),
              ),
              child: const Text('How to collect'),
            ),
            const SizedBox(height: 400, child: Center(child: Text('Bottom of the page'))),
          ],
        ),
      ),
    );
  }
}

class _Sun extends CustomPainter {
  const _Sun();
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = Colors.orange;
    canvas.drawCircle(size.center(Offset.zero), size.shortestSide / 3, paint);
    for (var i = 0; i < 8; i++) {
      final a = i * math.pi / 4;
      canvas.drawLine(size.center(Offset.zero) + Offset(math.cos(a), math.sin(a)) * 22,
          size.center(Offset.zero) + Offset(math.cos(a), math.sin(a)) * 30, paint..strokeWidth = 3);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class FormScreen extends StatefulWidget {
  const FormScreen({super.key});
  @override
  State<FormScreen> createState() => _FormScreenState();
}

class _FormScreenState extends State<FormScreen> {
  bool _delivery = false;
  bool _terms = false;
  double _loaves = 2;
  String _bread = 'Sourdough';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Your order')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const TextField(decoration: InputDecoration(labelText: 'Your name', border: OutlineInputBorder())),
          const SizedBox(height: 12),
          const TextField(
              obscureText: true, decoration: InputDecoration(labelText: 'Password', border: OutlineInputBorder())),
          const SizedBox(height: 12),
          const TextField(
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: 'Reference', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          const TextField(
            keyboardType: TextInputType.multiline,
            maxLines: 3,
            decoration: InputDecoration(labelText: 'Message to the baker', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          const TextField(
            autofillHints: [AutofillHints.creditCardNumber],
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: 'Card', border: OutlineInputBorder()),
          ),
          SwitchListTile(
              value: _delivery, onChanged: (v) => setState(() => _delivery = v), title: const Text('Home delivery')),
          CheckboxListTile(
              value: _terms, onChanged: (v) => setState(() => _terms = v ?? false), title: const Text('I agree')),
          Slider(
              value: _loaves,
              min: 1,
              max: 6,
              divisions: 5,
              label: '${_loaves.round()}',
              onChanged: (v) {
                setState(() => _loaves = v);
              }),
          DropdownButton<String>(
            value: _bread,
            items: const [
              DropdownMenuItem(value: 'Sourdough', child: Text('Sourdough')),
              DropdownMenuItem(value: 'Rye', child: Text('Rye')),
              DropdownMenuItem(value: 'Baguette', child: Text('Baguette')),
            ],
            onChanged: (v) => setState(() => _bread = v ?? _bread),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () {
              AnyReplay.track('order_placed', {'loaves': _loaves.round(), 'bread': _bread});
              Navigator.pushNamed(context, '/list');
            },
            child: const Text('Place order'),
          ),
        ],
      ),
    );
  }
}

class ListScreen extends StatelessWidget {
  const ListScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('All loaves')),
      body: ListView.builder(
        itemCount: 60,
        itemBuilder: (context, i) => ListTile(
          leading: const Icon(Icons.bakery_dining),
          title: Text('Loaf number ${i + 1}'),
          subtitle: Text(i.isEven ? 'Crusty' : 'Soft'),
        ),
      ),
    );
  }
}
