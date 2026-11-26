package com.anyreplay.cordova;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;

/**
 * Writes down a crash in the app's own Kotlin or Java code, for the next
 * launch to report (docs/SDK-CONTRACT.md §8.3, "Native crashes").
 *
 * The recording runs in JavaScript, which dies with the process; this is the
 * part that outlives it. An uncaught exception on any thread is written to
 * one small JSON file in the app's private files directory —
 * {"v":1,"ts":…,"platform":"android","name":…,"message":…,"stack":…} — and
 * then handed to the handler that was installed before this one (the app's
 * crash reporter, or Android's own, which shows the dialog and ends the
 * process). On the next launch the SDK takes the file and sends the crash
 * into the recording it happened in.
 *
 * Installed once; installing again only switches it back on. `uninstall`
 * puts the previous handler back when nothing has been installed over this
 * one since, and otherwise leaves this one in the chain doing nothing.
 *
 * The same file, with only the package line changed, is in
 * @anyreplay/react-native, @anyreplay/capacitor and @anyreplay/cordova.
 */
public final class AnyReplayCrashKeeper {
    /** The crash record, in `Context.getFilesDir()`. */
    public static final String CRASH_FILE = "anyreplay-native-crash.json";
    /** The crash clip ring an app shell keeps for the next launch (contract §8.6). */
    public static final String RING_FILE = "anyreplay-clip-ring.json";
    /** A stack is clipped here before it is written; the SDK clips it further. */
    private static final int MAX_STACK_CHARS = 16_000;
    private static final int MAX_MESSAGE_CHARS = 4_000;

    private static File directory;
    private static Thread.UncaughtExceptionHandler previous;
    private static Thread.UncaughtExceptionHandler ours;
    private static boolean installed;
    private static volatile boolean enabled;
    private static volatile boolean handling;

    private AnyReplayCrashKeeper() {}

    /** Installs the handler; safe to call any number of times. */
    public static void install(Context context) {
        File dir = filesDir(context);
        if (dir != null) install(dir);
    }

    /** As `install(Context)`, writing into `dir`. */
    public static synchronized void install(File dir) {
        if (dir == null) return;
        directory = dir;
        enabled = true;
        if (installed) return;
        if (ours == null) ours = AnyReplayCrashKeeper::handle;
        previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(ours);
        installed = true;
    }

    /** Stops writing crashes down, and gives the previous handler its place back when it can. */
    public static synchronized void uninstall() {
        enabled = false;
        if (!installed) return;
        // Only when nobody has installed a handler over this one since: putting
        // the old one back over theirs would cut them out of every crash.
        if (Thread.getDefaultUncaughtExceptionHandler() == ours) {
            Thread.setDefaultUncaughtExceptionHandler(previous);
            previous = null;
            installed = false;
        }
    }

    /** The crash the previous launch wrote down, or null; the file is deleted. */
    public static String take(Context context) {
        File dir = filesDir(context);
        return dir == null ? null : take(dir);
    }

    /** The app's private files directory, where everything here is kept. */
    public static File filesDir(Context context) {
        if (context == null) return null;
        Context app = context.getApplicationContext();
        return (app != null ? app : context).getFilesDir();
    }

    public static synchronized String take(File dir) {
        return readAndDelete(new File(dir, CRASH_FILE));
    }

    /** The crash clip ring kept for the next launch, or null; the file is deleted. */
    public static synchronized String takeRing(File dir) {
        return readAndDelete(new File(dir, RING_FILE));
    }

    /** Replaces the kept ring; null removes it. */
    public static synchronized void writeRing(File dir, String value) {
        File file = new File(dir, RING_FILE);
        if (value == null) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }
        // Written beside it and renamed over it, so a crash mid-write leaves
        // the previous ring rather than half of this one.
        File temp = new File(dir, RING_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(value.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException ignored) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        temp.renameTo(file);
    }

    private static void handle(Thread thread, Throwable error) {
        // Once: a second exception thrown while the first is being handled
        // (by a handler further down the chain) is not a second crash.
        if (enabled && !handling) {
            handling = true;
            try {
                write(error);
            } catch (Throwable ignored) {
                // Whatever happens here, the crash still reaches the app's own handler.
            }
        }
        Thread.UncaughtExceptionHandler next = previous;
        if (next != null) {
            next.uncaughtException(thread, error);
        } else {
            // What the runtime does when no default handler is set.
            System.err.print("Exception in thread \"" + thread.getName() + "\" ");
            error.printStackTrace(System.err);
        }
    }

    private static void write(Throwable error) throws IOException {
        File dir = directory;
        if (dir == null) return;
        StringWriter trace = new StringWriter();
        error.printStackTrace(new PrintWriter(trace));
        String message = error.getMessage();
        String json = "{\"v\":1"
            + ",\"ts\":" + System.currentTimeMillis()
            + ",\"platform\":\"android\""
            + ",\"name\":" + quote(error.getClass().getName(), 256)
            + ",\"message\":" + quote(message == null ? "" : message, MAX_MESSAGE_CHARS)
            + ",\"stack\":" + quote(trace.toString(), MAX_STACK_CHARS)
            + "}";
        try (FileOutputStream out = new FileOutputStream(new File(dir, CRASH_FILE))) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
    }

    /** A JSON string, by hand: nothing here may depend on a library being usable mid-crash. */
    static String quote(String text, int max) {
        String value = text.length() > max ? text.substring(0, max) : text;
        StringBuilder out = new StringBuilder(value.length() + 16);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20 || (c >= 0xD800 && c <= 0xDFFF && !pairedSurrogate(value, i))) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }

    /** Whether the surrogate at `i` is half of a valid pair (a lone one would not be valid UTF-8). */
    private static boolean pairedSurrogate(String s, int i) {
        char c = s.charAt(i);
        if (Character.isHighSurrogate(c)) return i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1));
        return i > 0 && Character.isHighSurrogate(s.charAt(i - 1));
    }

    private static String readAndDelete(File file) {
        if (!file.isFile()) return null;
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) bytes.write(buffer, 0, n);
            String value = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            return value.isEmpty() ? null : value;
        } catch (IOException ignored) {
            return null;
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
