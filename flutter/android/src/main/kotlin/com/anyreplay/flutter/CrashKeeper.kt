package com.anyreplay.flutter

import android.content.Context
import android.os.Process
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * Writes an uncaught Kotlin or Java exception to `filesDir/anyreplay-native-crash.json`
 * before the process goes, then hands it to the handler that was there before
 * (the system's, which shows the crash dialog and ends the process, or the
 * app's crash reporter), so nothing about the crash itself changes.
 *
 * The file: `{"v":1,"ts":<epoch ms>,"platform":"android","name":<class>,"message":…,"stack":…}`.
 * Only the newest crash is kept; the Dart side takes it (reads and deletes it)
 * on the next launch.
 */
internal object CrashKeeper {
    const val FILE_NAME = "anyreplay-native-crash.json"
    private const val MAX_MESSAGE = 2000
    private const val MAX_STACK = 16000

    @Volatile
    private var file: File? = null
    private var handler: Handler? = null

    /** Installs the handler once; a second call does nothing. */
    @Synchronized
    fun install(context: Context) {
        if (file == null) file = File(context.filesDir, FILE_NAME)
        if (handler != null) return
        val next = Handler(Thread.getDefaultUncaughtExceptionHandler())
        Thread.setDefaultUncaughtExceptionHandler(next)
        handler = next
    }

    /**
     * Puts the previous handler back if ours is still the default; if someone
     * installed theirs on top of ours since, ours stays in their chain but
     * only passes the crash on.
     */
    @Synchronized
    fun uninstall() {
        val current = handler ?: return
        handler = null
        current.enabled = false
        if (Thread.getDefaultUncaughtExceptionHandler() === current) {
            Thread.setDefaultUncaughtExceptionHandler(current.previous)
        }
    }

    /** The kept crash, deleted as it is read; null when there is none. */
    @Synchronized
    fun take(context: Context): String? {
        val target = file ?: File(context.filesDir, FILE_NAME)
        if (!target.exists()) return null
        return try {
            val text = target.readText(Charsets.UTF_8)
            text.ifBlank { null }
        } catch (_: Throwable) {
            null
        } finally {
            target.delete()
        }
    }

    private fun write(error: Throwable) {
        val target = file ?: return
        val stack = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val record = JSONObject()
            .put("v", 1)
            .put("ts", System.currentTimeMillis())
            .put("platform", "android")
            .put("name", error.javaClass.name)
            .put("message", (error.message ?: "").take(MAX_MESSAGE))
            .put("stack", stack.take(MAX_STACK))
        // Written next to the file and renamed, so a half-written record is never read.
        val partial = File(target.parentFile, "$FILE_NAME.tmp")
        FileOutputStream(partial).use { out ->
            out.write(record.toString().toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!partial.renameTo(target)) partial.delete()
    }

    private class Handler(val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        @Volatile
        var enabled = true

        @Volatile
        private var handled = false

        override fun uncaughtException(thread: Thread, error: Throwable) {
            if (enabled && !handled) {
                handled = true
                try {
                    write(error)
                } catch (_: Throwable) {
                    // Never in the way of the crash itself.
                }
            }
            val next = previous
            if (next != null) {
                next.uncaughtException(thread, error)
            } else {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }
    }
}
