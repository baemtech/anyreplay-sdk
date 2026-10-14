import XCTest

/// Drives the device-test app (lib/device_test.dart) with real touches and
/// keystrokes: Flutter's own accessibility tree comes and goes under
/// XCUITest, so steps are coordinates in points and text is typed on the
/// on-screen keyboard one key at a time. See add_ui_target.rb.
final class DriveTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.anyreplay.anyreplayFlutterExample")
  let shots = ProcessInfo.processInfo.environment["SHOTS"] ?? "/tmp"

  override func setUp() {
    continueAfterFailure = true
    if app.state != .runningForeground { app.activate() }
  }

  func shot(_ name: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
    let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
  }

  func pause(_ s: Double = 1.5) { Thread.sleep(forTimeInterval: s) }

  func tap(_ label: String, file: StaticString = #file, line: UInt = #line) {
    let e = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
    XCTAssertTrue(e.waitForExistence(timeout: 8), "no \(label)", file: file, line: line)
    e.tap(); pause()
  }

  func field(_ label: String) -> XCUIElement {
    let p = NSPredicate(format: "label CONTAINS %@ OR placeholderValue CONTAINS %@", label, label)
    let t = app.textFields.matching(p).firstMatch
    if t.waitForExistence(timeout: 3) { return t }
    let s = app.secureTextFields.matching(p).firstMatch
    if s.exists { return s }
    return app.textViews.matching(p).firstMatch
  }

  func typeSlowly(_ text: String, into e: XCUIElement) {
    e.tap(); pause(1)
    for ch in text { e.typeText(String(ch)); Thread.sleep(forTimeInterval: 0.35) }
    pause(1)
  }

  func at(_ x: Double, _ y: Double) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
  }

  /// Runs the steps in $SHOTS/steps.txt, one per line:
  /// tap X Y | type Y TEXT | key TEXT | swipe up|down|left|right | drag X1 Y1 X2 Y2 | wait S | shot NAME
  /// | home | activate | terminate | rotate landscape|portrait
  func testSteps() {
    let text = (try? String(contentsOfFile: "\(shots)/steps.txt", encoding: .utf8)) ?? ""
    for line in text.split(separator: "\n") {
      let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
      guard let op = parts.first else { continue }
      let rest = parts.count > 1 ? parts[1] : ""
      let n = rest.split(separator: " ").compactMap { Double($0) }
      switch op {
      case "tap": at(n[0], n[1]).tap(); pause(1.2)
      case "type":
        let f = rest.split(separator: " ", maxSplits: 1).map(String.init)
        typeAt(Double(f[0])!, f.count > 1 ? f[1] : "")
      case "key": for ch in rest { key(ch); Thread.sleep(forTimeInterval: 0.35) }
      case "swipe":
        switch rest { case "up": app.swipeUp(); case "down": app.swipeDown(); case "left": app.swipeLeft(); default: app.swipeRight() }
        pause(1)
      case "drag": at(n[0], n[1]).press(forDuration: 0.1, thenDragTo: at(n[2], n[3])); pause(1)
      case "wait": pause(n.first ?? 1)
      case "btn":
        let b = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", rest, rest)).firstMatch
        if b.waitForExistence(timeout: 4) { b.tap() } else { print("STEP no element \(rest)") }
        pause(1.2)
      case "dump": print(app.debugDescription)
      case "shot": shot(rest)
      case "home": XCUIDevice.shared.press(.home); pause(2)
      case "activate": app.activate(); pause(3)
      case "terminate": app.terminate(); pause(2)
      case "rotate": XCUIDevice.shared.orientation = rest == "landscape" ? .landscapeLeft : .portrait; pause(3)
      default: break
      }
    }
  }

  func typeAt(_ y: Double, _ text: String) {
    at(200, y).tap(); pause(1.5)
    let intro = app.buttons["Continue"]
    if intro.exists { intro.tap(); pause(1); at(200, y).tap(); pause(1) }
    for ch in text { key(ch); Thread.sleep(forTimeInterval: 0.35) }
    pause(1)
  }

  /// Presses the on-screen key for one character, switching layouts as needed.
  func key(_ ch: Character) {
    let s = String(ch)
    if ch == " " { app.keys["space"].tap(); return }
    var k = app.keys[s]
    if k.exists && k.isHittable { k.tap(); return }
    if ch.isLetter {
      if !app.keys["a"].exists && !app.keys["A"].exists { app.keys["more"].tap(); usleep(300_000) }
      if ch.isUppercase && !app.keys[s].exists { app.buttons["shift"].tap(); usleep(300_000) }
    } else {
      app.keys["more"].tap(); usleep(300_000)
    }
    k = app.keys[s]
    if !k.exists { k = app.keys[s.lowercased()] }
    XCTAssertTrue(k.exists, "no key \(s)")
    k.tap()
  }
}
