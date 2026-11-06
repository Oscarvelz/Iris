package com.oscarvelz.iris

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Bundle
import android.os.Environment
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
        web.addJavascriptInterface(Bridge(), "IrisNative")
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
            return WebResourceResponse("image/jpeg", null, 200, "OK", hdr + ("Cache-Control" to "max-age=600"), ByteArrayInputStream(it)) }
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
        return WebResourceResponse(mime, null, 200, "OK", hdr, FileInputStream(f))
    }

    /** Screen-sized JPEG for the viewer, decoded by Android itself (fast, hardware HEIC, EXIF rotation applied). */
    private fun viewCopy(f: File, w: Int): ByteArray? = runCatching {
        val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(f)) { d, info, _ ->
            val m = maxOf(info.size.width, info.size.height)
            if (m > w) { val k = w.toFloat() / m; d.setTargetSize(maxOf(1, (info.size.width * k).toInt()), maxOf(1, (info.size.height * k).toInt())) }
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it); bmp.recycle() }.toByteArray()
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
    }

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
