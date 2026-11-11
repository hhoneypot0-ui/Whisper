package cc.ccwu.bierlan.qiaoqiao;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.provider.MediaStore;

/**
 * 「悄悄」的 Android 外壳
 * - WebView 承载线上界面
 * - 麦克风：启动时预授权，网页请求时直接放行
 * - 通知：WebView 不支持 Web Push，改由原生发本地通知（前台也响）
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://im.bierlan.ccwu.cc";
    private static final String CHANNEL_ID = "qiaoqiao_msg";
    private static final int REQ_FILE = 1001;
    private static final int REQ_AUDIO = 1002;
    private static final int REQ_NOTIFY = 1003;
    private static final int REQ_ALL = 1004;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingAudio;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 23) {
            w.getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            w.setStatusBarColor(0xFFF4F5F8);
            w.setNavigationBarColor(0xFFFFFFFF);
        }
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        createNotificationChannel();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 允许网页在非安全来源下也请求媒体设备（部分机型需要）
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if (host.endsWith("bierlan.ccwu.cc")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        boolean wantsAudio = false;
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
                        }
                        if (!wantsAudio) {
                            request.grant(request.getResources());
                            return;
                        }
                        if (hasAudioPermission()) {
                            request.grant(request.getResources());
                        } else {
                            pendingAudio = request;
                            askAudioPermission();
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // 网页通过这个桥调原生能力
        webView.addJavascriptInterface(new JsBridge(), "AndroidBridge");

        // 启动时一次性把所有需要的权限都申请掉，
        // 系统会把它们合并成一个权限页，用户点一次「允许」就全开。
        requestAllPermissions();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
            jumpToConvFromIntent(getIntent());
        } else {
            loadStartPage();
            jumpToConvFromIntent(getIntent());
        }
    }

    /**
     * 优先加载 APK 里打包好的页面（assets/index.html）——
     * 页面从本地读，0 网络等待，打开即显示；
     * base URL 设为线上地址，这样 /api/、/icons/ 这些相对路径
     * 会自动指向服务器，不用改网页代码。
     * assets 里没有就退回加载线上地址。
     */
    private void loadStartPage() {
        String html = null;
        // ① 优先用后台下载到本地的新版本
        try {
            File f = new File(getFilesDir(), "index.html");
            if (f.exists() && f.length() > 1000) html = readAll(new FileInputStream(f));
        } catch (Exception ignored) {}

        // ② 没有就用 APK 里打包的版本
        if (html == null) {
            try { html = readAll(getAssets().open("index.html")); } catch (Exception ignored) {}
        }

        if (html != null && html.length() > 1000) {
            webView.loadDataWithBaseURL(START_URL + "/", html, "text/html", "UTF-8", null);
        } else {
            webView.loadUrl(START_URL);   // 兜底
        }

        // ③ 后台检查服务器有没有新版网页
        checkForUpdate();
    }

    private String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toString("UTF-8");
    }

    /**
     * 后台拉一次线上页面：内容和本地不一样就存下来，下次启动生效。
     * 这样在服务器上改了网页，App 不用重新打包也能自动跟上。
     */
    private void checkForUpdate() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(START_URL + "/?_=" + System.currentTimeMillis());
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(10000);
                    conn.setRequestProperty("Cache-Control", "no-cache");
                    conn.setRequestProperty("Accept-Encoding", "identity"); // 不要压缩，直接存原文
                    if (conn.getResponseCode() != 200) return;

                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    InputStream is = conn.getInputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();

                    byte[] fresh = bos.toByteArray();
                    if (fresh.length < 1000) return;

                    File f = new File(getFilesDir(), "index.html");
                    boolean changed = true;
                    if (f.exists() && f.length() == fresh.length) {
                        byte[] old = new byte[(int) f.length()];
                        FileInputStream in = new FileInputStream(f);
                        int off = 0;
                        while (off < old.length) {
                            int r = in.read(old, off, old.length - off);
                            if (r < 0) break;
                            off += r;
                        }
                        in.close();
                        changed = !java.util.Arrays.equals(old, fresh);
                    }
                    if (changed) {
                        FileOutputStream fos = new FileOutputStream(f);
                        fos.write(fresh);
                        fos.flush();
                        fos.close();
                    }
                } catch (Exception ignored) {
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    /* ---------------- 权限 ---------------- */

    /**
     * 一次性申请全部运行时权限。
     * Android 会把同一批 requestPermissions 合成一个权限页，
     * 用户确认一次就能全部通过，比逐个申请少弹好几次。
     */
    private void requestAllPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        java.util.ArrayList<String> need = new java.util.ArrayList<>();
        if (!hasAudioPermission()) need.add("android.permission.RECORD_AUDIO");
        if (Build.VERSION.SDK_INT >= 33 && !hasNotifyPermission()) {
            need.add("android.permission.POST_NOTIFICATIONS");
        }
        if (need.isEmpty()) return;
        try {
            requestPermissions(need.toArray(new String[0]), REQ_ALL);
        } catch (Exception ignored) {}
    }

    private boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return checkSelfPermission("android.permission.RECORD_AUDIO") == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) { return false; }
    }

    private void askAudioPermission() {
        if (Build.VERSION.SDK_INT < 23 || hasAudioPermission()) return;
        try {
            requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, REQ_AUDIO);
        } catch (Exception ignored) {}
    }

    private boolean hasNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) { return false; }
    }

    private void askNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33 || hasNotifyPermission()) return;
        try {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
        } catch (Exception ignored) {}
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_ALL) {
            // 一次性申请的结果：有麦克风就放行之前挂起的录音请求
            if (hasAudioPermission() && pendingAudio != null) {
                pendingAudio.grant(pendingAudio.getResources());
                pendingAudio = null;
            }
            return;
        }
        if (requestCode == REQ_AUDIO) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingAudio != null) {
                if (ok) pendingAudio.grant(pendingAudio.getResources());
                else pendingAudio.deny();
                pendingAudio = null;
            }
            if (!ok) Toast.makeText(this, "没有麦克风权限，语音消息用不了", Toast.LENGTH_LONG).show();
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    /* ---------------- 通知 ---------------- */

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "消息", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("新消息提醒");
        ch.enableVibration(true);
        ch.setShowBadge(true);
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        ch.setSound(sound, attrs);
        nm.createNotificationChannel(ch);
    }

    private void showNotification(String title, String body, String convId) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (convId != null && convId.length() > 0) open.putExtra("convId", convId);
            int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new Notification.Builder(this, CHANNEL_ID);
            } else {
                b = new Notification.Builder(this);
                b.setPriority(Notification.PRIORITY_HIGH);
                b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
            }
            b.setContentTitle(title == null ? "悄悄" : title)
             .setContentText(body == null ? "新消息" : body)
             .setSmallIcon(android.R.drawable.ic_dialog_email)
             .setAutoCancel(true)
             .setContentIntent(pi)
             .setVibrate(new long[]{0, 120, 80, 120});
            if (Build.VERSION.SDK_INT < 26) b.setDefaults(Notification.DEFAULT_ALL);

            nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        } catch (Exception e) {
            // 通知失败不影响聊天
        }
    }

    /* ---------------- 给网页用的桥 ---------------- */

    public class JsBridge {
        @JavascriptInterface
        public boolean isApp() { return true; }

        @JavascriptInterface
        public boolean hasNotificationPermission() { return hasNotifyPermission(); }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(new Runnable() {
                @Override public void run() { askNotifyPermission(); }
            });
        }

        @JavascriptInterface
        public boolean hasAudioPermissionJs() { return hasAudioPermission(); }

        @JavascriptInterface
        public void requestAudioPermission() {
            runOnUiThread(new Runnable() {
                @Override public void run() { askAudioPermission(); }
            });
        }

        /** 网页收到消息时调用，前台也响；convId 用于点击后跳转 */
        @JavascriptInterface
        public void notify(final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override public void run() { showNotification(title, body, null); }
            });
        }

        @JavascriptInterface
        public void notify(final String title, final String body, final String convId) {
            runOnUiThread(new Runnable() {
                @Override public void run() { showNotification(title, body, convId); }
            });
        }

        /**
         * 把一张图片存进手机相册。
         * Android 10+ 走 MediaStore（不需要存储权限）；
         * 更老的版本写到公共 Pictures 目录，需要 WRITE_EXTERNAL_STORAGE。
         */
        @JavascriptInterface
        public void saveImage(final String url, final String filename) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    HttpURLConnection conn = null;
                    try {
                        String full = url;
                        if (full != null && full.startsWith("/")) full = START_URL + full;
                        URL u = new URL(full);
                        conn = (HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(10000);
                        conn.setReadTimeout(25000);
                        conn.setRequestProperty("User-Agent", "QiaoQiao/1.0");
                        InputStream is = conn.getInputStream();
                        final Bitmap bmp = BitmapFactory.decodeStream(is);
                        is.close();
                        if (bmp == null) throw new Exception("图片解析失败");

                        final String name = (filename == null || filename.length() == 0)
                                ? ("qiaoqiao_" + System.currentTimeMillis() + ".jpg") : filename;

                        if (Build.VERSION.SDK_INT >= 29) {
                            ContentValues cv = new ContentValues();
                            cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                            cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                            cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/悄悄");
                            Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                            if (uri == null) throw new Exception("无法创建相册条目");
                            OutputStream os = getContentResolver().openOutputStream(uri);
                            bmp.compress(Bitmap.CompressFormat.JPEG, 95, os);
                            os.flush();
                            os.close();
                        } else {
                            java.io.File dir = new java.io.File(
                                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "悄悄");
                            if (!dir.exists()) dir.mkdirs();
                            java.io.File f = new java.io.File(dir, name);
                            FileOutputStream fos = new FileOutputStream(f);
                            bmp.compress(Bitmap.CompressFormat.JPEG, 95, fos);
                            fos.flush();
                            fos.close();
                            MediaScannerConnection.scanFile(MainActivity.this,
                                    new String[]{f.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
                        }

                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                Toast.makeText(MainActivity.this, "已保存到相册", Toast.LENGTH_SHORT).show();
                            }
                        });
                    } catch (final Exception e) {
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                            }
                        });
                    } finally {
                        if (conn != null) conn.disconnect();
                        // 位图由 GC 回收，这里不做手动 recycle（可能还在绘制）
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void vibrate() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        android.os.Vibrator v = (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                        if (v != null) v.vibrate(120);
                    } catch (Exception ignored) {}
                }
            });
        }
    }

    /* ---------------- 文件选择 / 生命周期 ---------------- */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 从通知点进来：跳到对应会话 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        jumpToConvFromIntent(intent);
    }

    private void jumpToConvFromIntent(Intent intent) {
        if (intent == null || webView == null) return;
        final String convId = intent.getStringExtra("convId");
        if (convId == null || convId.length() == 0) return;
        // 等页面加载完再跳（首次冷启动时页面可能还没就绪）
        webView.postDelayed(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript(
                    "window.openConvById && window.openConvById('" + convId.replace("'", "") + "')", null);
            }
        }, 900);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
