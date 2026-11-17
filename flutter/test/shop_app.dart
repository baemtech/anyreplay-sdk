import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A small shop, built from Flutter's own widgets: a cart with a list, a
/// coupon field, a login and a card form, then a payment screen with a
/// confirmation dialog. What the conformance scenario (contract §14.3)
/// records.
class ShopApp extends StatelessWidget {
  const ShopApp({super.key, this.observer});

  final NavigatorObserver? observer;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      navigatorObservers: [if (observer != null) observer!],
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
  State<CartScreen> createState() => CartScreenState();
}

class CartScreenState extends State<CartScreen> {
  int count = 2;
  bool gift = false;
  bool agreed = true;
  double quantity = 2;

  void addOne() => setState(() => count += 1);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sepetim'),
        actions: [IconButton(onPressed: () {}, icon: const Icon(Icons.favorite_border), tooltip: 'Favoriler')],
      ),
      body: Column(children: [
        SizedBox(
          height: 300,
          child: ListView(key: const Key('cart-list'), children: [
            ListTile(
              leading: const Icon(Icons.headphones),
              title: const Text('Kablosuz kulaklık'),
              subtitle: Text('Adet: $count', style: const TextStyle(fontStyle: FontStyle.italic, fontFamily: 'Menlo')),
            ),
            Image.network(
              'https://cdn.example.com/kulaklik.jpg',
              width: 80,
              height: 80,
              semanticLabel: 'Kulaklık fotoğrafı',
              errorBuilder: (_, __, ___) => const SizedBox(width: 80, height: 80),
            ),
            Image(
              image: const AssetImage('assets/logo.png'),
              width: 120,
              height: 40,
              errorBuilder: (_, __, ___) => const SizedBox(width: 120, height: 40),
            ),
            SwitchListTile(value: gift, onChanged: (v) => setState(() => gift = v), title: const Text('Hediye paketi')),
            CheckboxListTile(
                value: agreed,
                onChanged: (v) => setState(() => agreed = v ?? false),
                title: const Text('Sözleşmeyi okudum')),
            Slider(value: quantity, min: 1, max: 5, onChanged: (v) => setState(() => quantity = v)),
            for (var i = 1; i <= 8; i += 1)
              Container(
                height: 56,
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                decoration: BoxDecoration(color: const Color(0xFFFAFAFA), borderRadius: BorderRadius.circular(8)),
                alignment: Alignment.centerLeft,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text('Önerilen ürün $i'),
              ),
          ]),
        ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: TextField(key: Key('coupon'), decoration: InputDecoration(hintText: 'Kupon kodu')),
        ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: TextField(key: Key('password'), obscureText: true, decoration: InputDecoration(labelText: 'Şifre')),
        ),
        const Spacer(),
        Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            height: 52,
            child: FilledButton(onPressed: () {}, child: const Text('Devam', textAlign: TextAlign.center)),
          ),
        ),
      ]),
    );
  }
}

class PaymentScreen extends StatelessWidget {
  const PaymentScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Ödeme')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const TextField(
          key: Key('card'),
          autofillHints: [AutofillHints.creditCardNumber],
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: 'Kart'),
        ),
        const SizedBox(height: 8),
        const TextField(key: Key('name'), decoration: InputDecoration(hintText: 'Ad Soyad')),
        const SizedBox(height: 8),
        const AnyReplayMask(
          child: ColoredBox(
            color: Color(0xFFF7F7F8),
            child: Padding(padding: EdgeInsets.all(12), child: Text('Bağdat Cd. 12, İstanbul')),
          ),
        ),
        const SizedBox(height: 8),
        const LinearProgressIndicator(),
        const SizedBox(height: 8),
        const Text(
          'Kartınızdan 1.249,90 TL çekilecek. Bu işlem geri alınamaz; onaylıyor musunuz? Siparişiniz iki iş günü içinde kargoya verilir.',
          style: TextStyle(fontSize: 14),
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: () => showDialog<void>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('Ödemeyi onayla'),
              content: const Text('1.249,90 TL çekilecek.'),
              actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Onayla'))],
            ),
          ),
          child: const Text('Öde'),
        ),
      ]),
    );
  }
}

/// A 1×1 transparent PNG: what a bundled image's bytes look like.
final Uint8List tinyPng = Uint8List.fromList(const [
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x63,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);
