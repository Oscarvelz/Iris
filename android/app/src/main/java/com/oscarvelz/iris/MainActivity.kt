package com.oscarvelz.iris

import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.webkit.*
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.BasicFileAttributes

/**
 * Iris for Android: a thin shell around the Iris web app (loaded live from GitHub Pages, so every web update
 * arrives on its own). Android's "All files access" is granted once and kept for good, so Iris never asks for
 * folders again. The page talks to the phone's files through the IrisNative bridge below.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private val home = "https://oscarvelz.github.io/Iris/"
    private val root: String by lazy { File(Environment.getExternalStorageDirectory().absolutePath).canonicalPath }
    private val bg = Color.parseColor("#07070d")

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.statusBarColor = bg; window.navigationBarColor = bg
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this).apply { setBackgroundColor(bg) }
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false; allowFileAccess = false
            userAgentString = "$userAgentString IrisShell/${BuildConfig.VERSION_NAME}"
        }
        bridge = Bridge(); web.addJavascriptInterface(bridge, "IrisNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest) = serve(r)
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.url.host == "oscarvelz.github.io") return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, r.url)) }; return true
            }
        }
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(r: WebResourceRequest) = serve(r)
        })
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null); fileCb = cb
                return try { startActivityForResult(p.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), 7); true }
                catch (e: Exception) { fileCb = null; false }
            }
        }
        if (state != null) web.restoreState(state) else web.loadUrl(home)
        checkUpdate()
    }

    /** Photos are read straight from storage at https://iris.native/f?p=<path>, only inside shared storage. */
    private fun serve(r: WebResourceRequest): WebResourceResponse? {
        if (r.url.host != "iris.native") return null
        val hdr = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store")
        val p = r.url.getQueryParameter("p")
        val f = p?.let { File(it) }
        if (f == null || !inside(f.path) || !f.isFile)
            return WebResourceResponse("text/plain", "utf-8", 404, "Not found", hdr, ByteArrayInputStream(ByteArray(0)))
        if (r.url.path == "/v") viewCopy(f, r.url.getQueryParameter("w")?.toIntOrNull() ?: 2048)?.let {
            // X-Iris-OW/OH carry the photo's original size, so the page can prepare a small copy natively
            // (web 2.33) without losing the real dimensions it stores and scores by.
            return WebResourceResponse("image/jpeg", null, 200, "OK", hdr + mapOf("Cache-Control" to "max-age=600", "X-Iris-OW" to it.w.toString(), "X-Iris-OH" to it.h.toString(), "Access-Control-Expose-Headers" to "X-Iris-OW, X-Iris-OH"), ByteArrayInputStream(it.b)) }
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
        return WebResourceResponse(mime, null, 200, "OK", hdr, FileInputStream(f))
    }

    private class VC(val b: ByteArray, val w: Int, val h: Int)

    /** Screen-sized JPEG for the viewer, decoded by Android itself (fast, hardware HEIC, EXIF rotation applied). */
    private fun viewCopy(f: File, w: Int): VC? = runCatching {
        var ow = 0; var oh = 0
        val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(f)) { d, info, _ ->
            ow = info.size.width; oh = info.size.height
            val m = maxOf(info.size.width, info.size.height)
            if (m > w) { val k = w.toFloat() / m; d.setTargetSize(maxOf(1, (info.size.width * k).toInt()), maxOf(1, (info.size.height * k).toInt())) }
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        VC(ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it); bmp.recycle() }.toByteArray(), ow, oh)
    }.getOrNull()

    private fun inside(p: String) = runCatching { val c = File(p).canonicalPath; c == root || c.startsWith("$root/") }.getOrDefault(false)

    inner class Bridge {
        @JavascriptInterface fun hasAccess() = Environment.isExternalStorageManager().toString()
        @JavascriptInterface fun askAccess() = runOnUiThread {
            try { startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
            catch (e: Exception) { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        }
        @JavascriptInterface fun root(): String = JSONObject.quote(root)
        @JavascriptInterface fun fast(): Boolean = true
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun list(p: String): String {
            val a = JSONArray()
            if (!inside(p)) return a.toString()
            try {
                Files.newDirectoryStream(Paths.get(p)).use { ds ->
                    for (e in ds) {
                        val at = runCatching { Files.readAttributes(e, BasicFileAttributes::class.java) }.getOrNull() ?: continue
                        a.put(JSONObject().put("n", e.fileName.toString()).put("d", at.isDirectory).put("s", at.size()).put("m", at.lastModifiedTime().toMillis()))
                    }
                }
            } catch (_: Exception) {}
            return a.toString()
        }
        @JavascriptInterface fun isDir(p: String) = (inside(p) && File(p).isDirectory).toString()
        @JavascriptInterface fun stat(p: String): String {
            val f = File(p); if (!inside(p) || !f.isFile) return "null"
            return JSONObject().put("s", f.length()).put("m", f.lastModified()).toString()
        }
        @JavascriptInterface fun del(p: String): String {
            val f = File(p); val ok = inside(p) && f.isFile && f.delete()
            if (ok) MediaScannerConnection.scanFile(this@MainActivity, arrayOf(f.path), null, null) // drop it from Gallery too
            return ok.toString()
        }
        @JavascriptInterface fun share(j: String) {
            val paths = runCatching { JSONArray(j) }.getOrNull() ?: return
            val list = (0 until paths.length()).map { paths.getString(it) }.filter { inside(it) && File(it).isFile }
            if (list.isEmpty()) return
            val uris = ArrayList<Uri>(); var left = list.size
            MediaScannerConnection.scanFile(this@MainActivity, list.toTypedArray(), null) { _, uri ->
                synchronized(uris) { if (uri != null) uris.add(uri); left-- ; if (left == 0) runOnUiThread { sendShare(uris) } }
            }
        }

        /* Save-with-destination (web 2.33): the WebView has no save dialog, no Web Share and no working
           download, so Backup.export could never actually save inside the shell. The page now streams the
           file to a cache temp in base64 chunks (saveStart/saveChunk), then saveFinish opens Android's own
           ACTION_CREATE_DOCUMENT picker — the user chooses the folder and the name — and the shell copies
           the temp to the chosen place and reports back through window.__irisSaved('saved' | 'cancel'). */
        private var saveTmp: File? = null
        private var saveOut: java.io.OutputStream? = null
        private var saveName = "iris-backup.irisbak"
        private fun saveAbortQuiet() { try { saveOut?.close() } catch (_: Exception) {}; saveOut = null; saveTmp?.delete(); saveTmp = null }
        @JavascriptInterface fun saveStart(name: String): String = synchronized(this) {
            saveAbortQuiet()
            return try { saveName = name; val f = File(this@MainActivity.cacheDir, "iris-save-tmp.bin"); saveTmp = f; saveOut = java.io.BufferedOutputStream(java.io.FileOutputStream(f)); "true" }
            catch (e: Exception) { "false" }
        }
        @JavascriptInterface fun saveChunk(b64: String): String = synchronized(this) {
            val o = saveOut ?: return "false"
            return try { o.write(android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)); "true" } catch (e: Exception) { "false" }
        }
        @JavascriptInterface fun saveAbort(): String = synchronized(this) { saveAbortQuiet(); "true" }
        @JavascriptInterface fun saveFinish() {
            synchronized(this) { try { saveOut?.flush(); saveOut?.close() } catch (_: Exception) {}; saveOut = null }
            runOnUiThread {
                val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/octet-stream"; putExtra(Intent.EXTRA_TITLE, saveName)
                }
                try { startActivityForResult(i, 9) } catch (e: Exception) { saveDone("cancel") }
            }
        }
        /* Background work (web 2.33, at Oscar's ask): while Iris understands photos, WorkService keeps the
           process alive with a progress notification and a partial wake lock, so a long folder check can
           finish with the screen off or another app in front. The battery pair backs the Library card:
           Android's battery optimization can still stop background work unless Iris is exempt, and only
           the user can grant that — battAsk opens the system's own dialog for this app. */
        @JavascriptInterface fun battExempt(): String { val pm = getSystemService(PowerManager::class.java); return (pm?.isIgnoringBatteryOptimizations(packageName) ?: false).toString() }
        @JavascriptInterface fun battAsk() = runOnUiThread {
            try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
            catch (e: Exception) { try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {} }
        }
        @JavascriptInterface fun workStart(label: String): String {
            return try {
                val i = Intent(this@MainActivity, WorkService::class.java).setAction(WorkService.ACT_RUN).putExtra("label", label)
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
                "true"
            } catch (e: Exception) { "false" }
        }
        @JavascriptInterface fun workUpdate(done: String, total: String) {
            runCatching { startService(Intent(this@MainActivity, WorkService::class.java).setAction(WorkService.ACT_UPD).putExtra("done", done.toIntOrNull() ?: -1).putExtra("total", total.toIntOrNull() ?: -1)) }
        }
        @JavascriptInterface fun workStop() {
            runCatching { startService(Intent(this@MainActivity, WorkService::class.java).setAction(WorkService.ACT_STOP)) }
        }

        /** Request 9 (the save picker) lands here: copy the streamed temp to the place the user chose. */
        fun onSaveResult(rc: Int, d: Intent?) {
            val tmp = synchronized(this) { saveTmp.also { saveTmp = null } }
            val uri = if (rc == Activity.RESULT_OK) d?.data else null
            if (tmp == null || uri == null) { tmp?.delete(); saveDone("cancel"); return }
            Thread {
                val ok = runCatching { contentResolver.openOutputStream(uri)?.use { out -> tmp.inputStream().use { it.copyTo(out) }; true } ?: false }.getOrDefault(false)
                tmp.delete()
                runOnUiThread { saveDone(if (ok) "saved" else "cancel") }
            }.start()
        }
    }

    private fun saveDone(r: String) { web.evaluateJavascript("window.__irisSaved && __irisSaved('$r')", null) }

    private fun sendShare(uris: ArrayList<Uri>) {
        if (uris.isEmpty()) { Toast.makeText(this, "Couldn’t share those photos", Toast.LENGTH_SHORT).show(); return }
        val i = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
                else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        i.type = "image/*"; i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(i, "Share"))
    }

    /** The shell updates itself: if GitHub has a newer build, offer it once per launch and install it in place. */
    private fun checkUpdate() = Thread {
        try {
            val c = URL("https://api.github.com/repos/Oscarvelz/Iris/releases/latest").openConnection() as HttpURLConnection
            c.setRequestProperty("Accept", "application/vnd.github+json"); c.connectTimeout = 8000; c.readTimeout = 8000
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            val n = j.getString("tag_name").substringAfter("shell-").toIntOrNull() ?: return@Thread
            if (n <= BuildConfig.VERSION_CODE) return@Thread
            val assets = j.getJSONArray("assets")
            val url = (0 until assets.length()).map { assets.getJSONObject(it) }.firstOrNull { it.getString("name").endsWith(".apk") }?.getString("browser_download_url") ?: return@Thread
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("Iris update ready")
                    .setMessage("A newer Iris app is ready. Install it now? Your photos and your index stay exactly as they are.")
                    .setPositiveButton("Install") { _, _ -> install(url) }.setNegativeButton("Later", null).show()
            }
        } catch (_: Exception) {}
    }.start()

    private fun install(url: String) {
        Toast.makeText(this, "Downloading the update…", Toast.LENGTH_SHORT).show()
        Thread {
            try {
                val pi = packageManager.packageInstaller
                val id = pi.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL))
                pi.openSession(id).use { s ->
                    val c = URL(url).openConnection() as HttpURLConnection; c.instanceFollowRedirects = true
                    c.inputStream.use { inp -> s.openWrite("iris.apk", 0, -1).use { out -> inp.copyTo(out); s.fsync(out) } }
                    val back = Intent(this, MainActivity::class.java).setAction("iris.INSTALL")
                    val pend = PendingIntent.getActivity(this, 1, back, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    s.commit(pend.intentSender)
                }
            } catch (e: Exception) { runOnUiThread { Toast.makeText(this, "Update failed: ${e.message}", Toast.LENGTH_LONG).show() } }
        }.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action != "iris.INSTALL") return
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            else -> Toast.makeText(this, "Update didn’t install: " + (intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(rq: Int, rc: Int, d: Intent?) {
        if (rq == 9) { bridge.onSaveResult(rc, d); return }
        if (rq != 7) { super.onActivityResult(rq, rc, d); return }
        val cd = d?.clipData
        val res: Array<Uri>? = if (rc != RESULT_OK) null
            else if (cd != null) Array(cd.itemCount) { cd.getItemAt(it).uri }
            else WebChromeClient.FileChooserParams.parseResult(rc, d)
        fileCb?.onReceiveValue(res); fileCb = null
    }

    override fun onResume() { super.onResume(); if (::web.isInitialized) web.evaluateJavascript("dispatchEvent(new Event('irisnative-resume'))", null) }
    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); web.saveState(out) }
    @Deprecated("Deprecated in Java")
    private var lastBack = 0L
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.IrisBack && IrisBack()) ? 'y' : 'n'") { r ->
            if (r != null && r.contains("y")) return@evaluateJavascript
            val now = System.currentTimeMillis()
            if (now - lastBack < 2000) finish()
            else { lastBack = now; Toast.makeText(this, "Press back again to close Iris", Toast.LENGTH_SHORT).show() }
        }
    }
}

/**
 * Keeps Iris alive while it understands photos: a quiet foreground notification with live progress
 * ("Understanding your photos — 1,240 of 3,000") and a partial wake lock so the CPU keeps working
 * with the screen off. Started and fed by the page through the IrisNative work bridge; the lock is
 * always taken with a 20-minute timeout and renewed on every progress update, so it can never be
 * left held forever. Stops itself on ACT_STOP or when destroyed.
 */
class WorkService : Service() {
    companion object { const val ACT_RUN = "iris.work.RUN"; const val ACT_UPD = "iris.work.UPD"; const val ACT_STOP = "iris.work.STOP"; private const val CH = "iris-work"; private const val NID = 41 }
    private var lock: PowerManager.WakeLock? = null
    private var running = false
    private var label = "Iris is working"
    private var done = -1
    private var total = -1

    override fun onBind(i: Intent?): IBinder? = null

    private fun channel() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
            ?.createNotificationChannel(NotificationChannel(CH, "Iris working", NotificationManager.IMPORTANCE_LOW))
    }

    private fun note(): Notification {
        val b = Notification.Builder(this, CH).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Iris").setOngoing(true).setOnlyAlertOnce(true)
        if (total > 0 && done >= 0) {
            val pct = (done * 100L / total).toInt()
            b.setContentText("$label — $done of $total ($pct%)"); b.setProgress(total, done, false)
        } else { b.setContentText(label); b.setProgress(0, 0, true) }
        return b.build()
    }

    private fun hold() {
        val pm = getSystemService(PowerManager::class.java) ?: return
        if (lock?.isHeld != true) { lock?.release(); lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "iris:work"); lock?.acquire(20 * 60 * 1000L) }
    }

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        when (i?.action) {
            ACT_STOP -> { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
            ACT_UPD -> {
                if (!running) { stopSelf(); return START_NOT_STICKY }
                done = i.getIntExtra("done", done); total = i.getIntExtra("total", total); hold()
                getSystemService(NotificationManager::class.java)?.notify(NID, note())
            }
            else -> {
                channel(); label = i?.getStringExtra("label") ?: label; done = -1; total = -1; hold()
                startForeground(NID, note()); running = true
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() { running = false; try { if (lock?.isHeld == true) lock?.release() } catch (_: Exception) {}; lock = null; super.onDestroy() }
}
