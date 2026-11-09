import 'package:flutter/widgets.dart';

/// Masks everything inside it in AnyReplay recordings: its words become
/// `••••••`, its images are never read, its fields' values never leave the
/// device. The app looks and behaves exactly as without it.
///
/// ```dart
/// AnyReplayMask(child: Text(order.deliveryAddress))
/// ```
class AnyReplayMask extends StatelessWidget {
  const AnyReplayMask({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
