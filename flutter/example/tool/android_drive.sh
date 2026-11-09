#!/usr/bin/env bash
# Drives lib/device_test.dart on a real Android phone with real input events
# (adb shell input), the way tool/ios_drive does on the iOS simulator.
#
#   flutter create --platforms=android --org com.anyreplay.devicetest .
#   # applicationId → com.anyreplay.devicetest.flutter (allowed in the project);
#   # android:usesCleartextTraffic="true" in src/debug and src/profile manifests.
#   flutter build apk --profile -t lib/device_test.dart \
#     --dart-define=ANYREPLAY_KEY=… --dart-define=ANYREPLAY_INGEST=http://localhost:4601
#   adb install -r build/app/outputs/flutter-apk/app-profile.apk
#   adb reverse tcp:4601 tcp:4601        # the phone reaches the local ingest
#   SERIAL=<adb serial> tool/android_drive.sh
#
# Coordinates are for a 720×1600 screen at density 300 (Galaxy A06), where one
# logical point is 1.875 pixels; scale them for another phone.
set -euo pipefail
ADB=(adb ${SERIAL:+-s "$SERIAL"})
APP=com.anyreplay.devicetest.flutter
tap() { "${ADB[@]}" shell input tap "$1" "$2"; sleep "${3:-1}"; }
# One key event per character, so every intermediate value is on screen for a tick.
type_slowly() {
  local text=$1 i c
  for ((i = 0; i < ${#text}; i++)); do
    c=${text:i:1}
    if [[ $c == " " ]]; then "${ADB[@]}" shell input keyevent 62; else "${ADB[@]}" shell input text "$c"; fi
    sleep "${2:-0.4}"
  done
}
back() { "${ADB[@]}" shell input keyevent 4; sleep 1.2; }

rotation=$("${ADB[@]}" shell settings get system accelerometer_rotation | tr -d '\r')
restore() {
  "${ADB[@]}" shell settings put system user_rotation 0
  "${ADB[@]}" shell settings put system accelerometer_rotation "$rotation"
}
trap restore EXIT

"${ADB[@]}" shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 5
tap 229 566 2                      # Open the order form
tap 360 230; "${ADB[@]}" shell input text Ayse; sleep 0.6
tap 360 357; type_slowly Secr3tPassw0rd 0.2       # password: masked
tap 360 485; type_slowly 4111111111111111 0.6     # a card number in a field with no hints
tap 360 657; type_slowly "Charge 5555555555554444 please" 0.3   # …and inside a note
back                                              # hide the keyboard
tap 360 830; type_slowly 4242424242424242 0.4; back   # the card field
tap 588 935; tap 607 1040                         # switch, checkbox
"${ADB[@]}" shell input swipe 191 1137 530 1137 600; sleep 1   # slider
tap 120 1227 1.5; tap 92 1407 1.2                 # dropdown → Baguette
tap 360 1341 1.5                                  # Place order → the list
"${ADB[@]}" shell input swipe 360 1300 360 400 400; sleep 1.5
"${ADB[@]}" shell input swipe 360 1300 360 600 800; sleep 2
back; back                                        # back to home
tap 173 882 1.5; tap 526 893 1.2                  # dialog, Got it
tap 138 972 1.5; tap 360 300 1.2                  # sheet, dismissed
tap 140 777 1.2                                   # Break the oven: an uncaught error
"${ADB[@]}" shell input swipe 360 1200 360 500 500; sleep 1.5
"${ADB[@]}" shell settings put system accelerometer_rotation 0
"${ADB[@]}" shell settings put system user_rotation 1; sleep 5   # landscape
"${ADB[@]}" shell settings put system user_rotation 0; sleep 3
"${ADB[@]}" shell input keyevent 3; sleep 8       # Home: flush, timers stop
"${ADB[@]}" shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 4
"${ADB[@]}" shell am force-stop "$APP"; sleep 3   # killed…
"${ADB[@]}" shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 6   # …and the session resumes
tap 229 566 3
"${ADB[@]}" shell input keyevent 3
