package com.neon.control;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.Arrays;

public class MainActivity extends Activity {
    static final int REQ_BLE = 1;
    static final int REQ_MIC = 2;

    // Интерфейс открывается с https-адреса, чтобы работали микрофон и localStorage
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView web;
    private BleBridge ble;
    private PermissionRequest pendingMic;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0B12);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                return !"appassets.androidplatform.net".equals(u.getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsMic = Arrays.asList(request.getResources())
                            .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
                    if (!wantsMic) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }
        });

        ble = new BleBridge(this, web);
        web.addJavascriptInterface(ble, "AndroidBle");
        web.loadUrl(START_URL);

        ble.ensurePermissions();
    }

    void keepScreenOn(boolean on) {
        runOnUiThread(() -> {
            if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean granted = results.length > 0;
        for (int r : results) granted &= r == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_MIC && pendingMic != null) {
            if (granted) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingMic.deny();
            pendingMic = null;
        }
    }

    // Не ставим WebView на паузу при сворачивании: эффекты и таймеры продолжают идти,
    // пока система не выгрузит приложение.

    @Override
    protected void onDestroy() {
        ble.closeAll();
        web.destroy();
        super.onDestroy();
    }
}
