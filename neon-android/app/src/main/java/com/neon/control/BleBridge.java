package com.neon.control;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.ArrayAdapter;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Нативный Bluetooth LE для веб-интерфейса. Все вызовы из JS асинхронные:
 * последний аргумент — id обратного вызова, результат приходит в window.__ble.resolve().
 * Всё состояние меняется только в главном потоке (через handler).
 */
@SuppressLint("MissingPermission")
public class BleBridge {
    private static final String[] KNOWN_PREFIXES = {"ELK", "MELK", "BLEDOM", "LEDBLE", "DUOCO", "TRIONES", "LEDNET", "QHM"};
    private static final long SCAN_TIMEOUT_MS = 20000;
    private static final long CONNECT_TIMEOUT_MS = 15000;
    private static final long WRITE_TIMEOUT_MS = 1000;

    private final MainActivity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothAdapter adapter;
    private final Map<String, Conn> conns = new HashMap<>();

    BleBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        BluetoothManager bm = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bm != null ? bm.getAdapter() : null;
    }

    // ---------- разрешения ----------

    private String[] neededPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private boolean hasPermissions() {
        for (String p : neededPermissions()) {
            if (activity.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    void ensurePermissions() {
        if (!hasPermissions()) activity.requestPermissions(neededPermissions(), MainActivity.REQ_BLE);
    }

    // ---------- связь с JS ----------

    private void resolve(int id, boolean ok, String data) {
        String js = "window.__ble&&__ble.resolve(" + id + "," + ok + "," + JSONObject.quote(data == null ? "" : data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void notifyDisconnected(String address) {
        String js = "window.__ble&&__ble.disconnected(" + JSONObject.quote(address) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    @JavascriptInterface
    public void keepScreenOn(boolean on) {
        activity.keepScreenOn(on);
    }

    // ---------- поиск устройства ----------

    @JavascriptInterface
    public void requestDevice(int cb) {
        main.post(() -> {
            if (adapter == null) { resolve(cb, false, "На телефоне нет Bluetooth"); return; }
            if (!hasPermissions()) {
                ensurePermissions();
                resolve(cb, false, "Разреши доступ к устройствам поблизости и нажми «Подключить» ещё раз");
                return;
            }
            if (!adapter.isEnabled()) {
                activity.startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE));
                resolve(cb, false, "Включи Bluetooth и нажми «Подключить» ещё раз");
                return;
            }
            showScanDialog(cb);
        });
    }

    private static boolean isKnown(String name) {
        String n = name.toUpperCase(Locale.ROOT);
        for (String p : KNOWN_PREFIXES) if (n.startsWith(p) || n.contains(p)) return true;
        return false;
    }

    private void showScanDialog(int cb) {
        final List<BluetoothDevice> found = new ArrayList<>();
        final List<String> labels = new ArrayList<>();
        final ArrayAdapter<String> list = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_1, labels);
        final BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        final boolean[] done = {false};

        final ScanCallback scanCb = new ScanCallback() {
            @Override
            public void onScanResult(int type, ScanResult r) {
                BluetoothDevice d = r.getDevice();
                String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
                if (name == null) name = d.getName();
                if (name == null || name.isEmpty()) return;
                final String fname = name;
                main.post(() -> {
                    for (BluetoothDevice x : found) if (x.getAddress().equals(d.getAddress())) return;
                    // подходящие ленты — наверх списка
                    int pos = isKnown(fname) ? 0 : found.size();
                    found.add(pos, d);
                    labels.add(pos, (isKnown(fname) ? "💡 " : "") + fname + "  ·  " + d.getAddress());
                    list.notifyDataSetChanged();
                });
            }
        };

        final AlertDialog dialog = new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Поиск ленты…")
                .setAdapter(list, (dlg, which) -> {
                    done[0] = true;
                    BluetoothDevice d = found.get(which);
                    String name = labels.get(which).replace("💡 ", "").split("  ·  ")[0];
                    try {
                        JSONObject o = new JSONObject();
                        o.put("address", d.getAddress());
                        o.put("name", name);
                        resolve(cb, true, o.toString());
                    } catch (Exception e) {
                        resolve(cb, false, e.getMessage());
                    }
                })
                .setNegativeButton("Отмена", null)
                .create();
        dialog.setOnDismissListener(dlg -> {
            try { if (scanner != null) scanner.stopScan(scanCb); } catch (Exception ignored) { }
            if (!done[0]) { done[0] = true; resolve(cb, false, "cancel"); }
        });
        dialog.show();

        if (scanner == null) { dialog.dismiss(); return; }
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        scanner.startScan(null, settings, scanCb);
        main.postDelayed(() -> {
            try { scanner.stopScan(scanCb); } catch (Exception ignored) { }
            if (dialog.isShowing()) dialog.setTitle(found.isEmpty() ? "Ничего не найдено" : "Выбери ленту");
        }, SCAN_TIMEOUT_MS);
    }

    // ---------- подключение ----------

    private static class Op {
        final int cb; final UUID svc; final UUID chr; final byte[] data; final boolean noResponse;
        Op(int cb, UUID svc, UUID chr, byte[] data, boolean noResponse) {
            this.cb = cb; this.svc = svc; this.chr = chr; this.data = data; this.noResponse = noResponse;
        }
    }

    private class Conn {
        final String address;
        BluetoothGatt gatt;
        int connectCb = -1;
        boolean ready = false;
        final ArrayDeque<Op> queue = new ArrayDeque<>();
        Op inFlight;
        Runnable writeTimeout;
        Conn(String address) { this.address = address; }
    }

    @JavascriptInterface
    public void connect(String address, int cb) {
        main.post(() -> {
            Conn old = conns.remove(address);
            if (old != null && old.gatt != null) old.gatt.close();
            if (adapter == null || !hasPermissions()) { resolve(cb, false, "Нет доступа к Bluetooth"); return; }

            Conn c = new Conn(address);
            c.connectCb = cb;
            conns.put(address, c);
            BluetoothDevice dev = adapter.getRemoteDevice(address);
            c.gatt = dev.connectGatt(activity, false, new GattCb(c), BluetoothDevice.TRANSPORT_LE);
            main.postDelayed(() -> {
                if (c.connectCb == cb && !c.ready) {
                    failConnect(c, "Лента не отвечает. Она включена и рядом? Закрыто ли китайское приложение?");
                }
            }, CONNECT_TIMEOUT_MS);
        });
    }

    private void failConnect(Conn c, String msg) {
        if (c.connectCb >= 0) { resolve(c.connectCb, false, msg); c.connectCb = -1; }
        if (c.gatt != null) c.gatt.close();
        conns.remove(c.address);
    }

    private class GattCb extends BluetoothGattCallback {
        final Conn c;
        GattCb(Conn c) { this.c = c; }

        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> {
                if (conns.get(c.address) != c) return;
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                    g.discoverServices();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (!c.ready) { failConnect(c, "Не удалось подключиться (код " + status + ")"); return; }
                    c.ready = false;
                    flushQueue(c);
                    g.close();
                    conns.remove(c.address);
                    notifyDisconnected(c.address);
                }
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> {
                if (conns.get(c.address) != c) return;
                if (status != BluetoothGatt.GATT_SUCCESS) { failConnect(c, "Ошибка чтения сервисов (код " + status + ")"); return; }
                c.ready = true;
                if (c.connectCb >= 0) { resolve(c.connectCb, true, ""); c.connectCb = -1; }
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            main.post(() -> finishWrite(c, status == BluetoothGatt.GATT_SUCCESS));
        }
    }

    @JavascriptInterface
    public void disconnect(String address) {
        main.post(() -> {
            Conn c = conns.get(address);
            if (c == null || c.gatt == null) { notifyDisconnected(address); return; }
            if (c.ready) c.gatt.disconnect();
            else failConnect(c, "cancel");
        });
    }

    private BluetoothGattCharacteristic findChar(String address, UUID svc, UUID chr) {
        Conn c = conns.get(address);
        if (c == null || c.gatt == null || !c.ready) return null;
        BluetoothGattService s = c.gatt.getService(svc);
        return s == null ? null : s.getCharacteristic(chr);
    }

    @JavascriptInterface
    public boolean hasService(String address, String svc) {
        Conn c = conns.get(address);
        return c != null && c.gatt != null && c.ready && c.gatt.getService(UUID.fromString(svc)) != null;
    }

    @JavascriptInterface
    public int charProps(String address, String svc, String chr) {
        BluetoothGattCharacteristic ch = findChar(address, UUID.fromString(svc), UUID.fromString(chr));
        return ch == null ? -1 : ch.getProperties();
    }

    // ---------- запись (строго по одной операции за раз) ----------

    @JavascriptInterface
    public void write(String address, String svc, String chr, String hex, boolean noResponse, int cb) {
        byte[] data = new byte[hex.length() / 2];
        for (int i = 0; i < data.length; i++) data[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        Op op = new Op(cb, UUID.fromString(svc), UUID.fromString(chr), data, noResponse);
        main.post(() -> {
            Conn c = conns.get(address);
            if (c == null || !c.ready) { resolve(cb, false, "Лента не подключена"); return; }
            c.queue.add(op);
            pump(c);
        });
    }

    @SuppressWarnings("deprecation")
    private void pump(Conn c) {
        while (c.inFlight == null && !c.queue.isEmpty()) {
            Op op = c.queue.poll();
            BluetoothGattCharacteristic ch = findChar(c.address, op.svc, op.chr);
            if (ch == null) { resolve(op.cb, false, "Характеристика не найдена"); continue; }
            int type = op.noResponse ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
            boolean started;
            if (Build.VERSION.SDK_INT >= 33) {
                started = c.gatt.writeCharacteristic(ch, op.data, type) == BluetoothGatt.GATT_SUCCESS;
            } else {
                ch.setWriteType(type);
                ch.setValue(op.data);
                started = c.gatt.writeCharacteristic(ch);
            }
            if (!started) { resolve(op.cb, false, "Bluetooth занят"); continue; }
            c.inFlight = op;
            final Op sent = op;
            c.writeTimeout = () -> { if (c.inFlight == sent) finishWrite(c, true); };
            main.postDelayed(c.writeTimeout, WRITE_TIMEOUT_MS);
        }
    }

    private void finishWrite(Conn c, boolean ok) {
        Op op = c.inFlight;
        if (op == null) return;
        c.inFlight = null;
        if (c.writeTimeout != null) main.removeCallbacks(c.writeTimeout);
        resolve(op.cb, ok, ok ? "" : "Ошибка записи");
        pump(c);
    }

    private void flushQueue(Conn c) {
        if (c.inFlight != null) { resolve(c.inFlight.cb, false, "Связь потеряна"); c.inFlight = null; }
        for (Op op : c.queue) resolve(op.cb, false, "Связь потеряна");
        c.queue.clear();
    }

    void closeAll() {
        for (Conn c : conns.values()) if (c.gatt != null) c.gatt.close();
        conns.clear();
    }
}
