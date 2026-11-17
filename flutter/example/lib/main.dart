import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:flutter/material.dart';

/// A small shop that exercises what anyreplay_flutter records: a list, a
/// form with a coupon, a password and a card number, a switch, a dialog, a
/// second screen, a masked address, a consent prompt.
///
///   flutter run --dart-define=ANYREPLAY_KEY=ar_pk_test_… [--dart-define=ANYREPLAY_INGEST=http://10.0.2.2:4000]
void main() {
  const key = String.fromEnvironment('ANYREPLAY_KEY', defaultValue: 'ar_pk_test_000000000000000000000000');
  const ingest = String.fromEnvironment('ANYREPLAY_INGEST', defaultValue: AnyReplayOptions.defaultIngestUrl);
  AnyReplay.init(const AnyReplayOptions(projectKey: key, ingestUrl: ingest, requireConsent: true, debug: true));
  runApp(const ShopApp());
}

class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AnyReplay Shop',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF7C3AED)),
      navigatorObservers: [AnyReplayNavigatorObserver()],
      initialRoute: '/cart',
      routes: {
        '/cart': (_) => const CartScreen(),
        '/payment': (_) => const PaymentScreen(),
      },
    );
  }
}

class CartScreen extends StatefulWidget {
  const CartScreen({super.key});

  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  bool _gift = false;
  bool _asked = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_asked) return;
    _asked = true;
    WidgetsBinding.instance.addPostFrameCallback((_) => _askConsent());
  }

  Future<void> _askConsent() async {
    final yes = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('Help us improve the app?'),
        content: const Text('We record how the app is used, never what you type into passwords or card fields.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('No thanks')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Allow')),
        ],
      ),
    );
    AnyReplay.consent(yes ?? false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Your cart'),
        actions: [IconButton(onPressed: () {}, icon: const Icon(Icons.favorite_border), tooltip: 'Favourites')],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final (name, price) in [
            ('Wireless headphones', '79.90'),
            ('Charging case', '19.90'),
            ('Ear tips', '4.90')
          ])
            Card(
              child: ListTile(
                leading: const Icon(Icons.headphones),
                title: Text(name),
                trailing: Text('€$price'),
                onTap: () => AnyReplay.track('item_opened', {'name': name}),
              ),
            ),
          SwitchListTile(value: _gift, onChanged: (v) => setState(() => _gift = v), title: const Text('Gift wrap')),
          const SizedBox(height: 8),
          const TextField(decoration: InputDecoration(labelText: 'Coupon code', border: OutlineInputBorder())),
          const SizedBox(height: 8),
          const TextField(
              obscureText: true, decoration: InputDecoration(labelText: 'Password', border: OutlineInputBorder())),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () {
              AnyReplay.track('checkout_started', {'gift': _gift});
              Navigator.pushNamed(context, '/payment');
            },
            child: const Text('Checkout'),
          ),
        ],
      ),
    );
  }
}

class PaymentScreen extends StatelessWidget {
  const PaymentScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Payment')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const TextField(
            autofillHints: [AutofillHints.creditCardNumber],
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: 'Card number', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 16),
          const AnyReplayMask(
            child:
                Card(child: Padding(padding: EdgeInsets.all(16), child: Text('Deliver to: 221B Baker Street, London'))),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () {
              AnyReplay.trackError(StateError('Payment service did not answer'), StackTrace.current);
              showDialog<void>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('Payment failed'),
                  content: const Text('Please try again in a moment.'),
                  actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
                ),
              );
            },
            child: const Text('Pay €104.70'),
          ),
        ],
      ),
    );
  }
}
