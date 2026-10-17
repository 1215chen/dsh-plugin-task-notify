package com.dsh.tasknotify;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.net.ssl.SSLSocketFactory;

/**
 * Long-running foreground service that receives notifications over the LAN and
 * keeps the UDP discovery responder alive.
 */
public final class NotifyService extends Service implements NotifySink {
    private static final String TAG = "DSHNotify";
    private static final long DEDUPE_WINDOW_MS = 10 * 60 * 1000L;
    private static final int DEDUPE_LIMIT = 256;
    private static volatile NotifyService instance;
    private static volatile boolean running;
    private static volatile String lastError = "";
    private static volatile int activePort;
    private static volatile boolean cloudConnected;
    private static volatile String cloudError = "";

    private NotifyHttpServer httpServer;
    private DiscoveryServer discoveryServer;
    private CloudClient cloudClient;
    private final Map<String, Long> recentDeliveries = new LinkedHashMap<>();
    private volatile String serviceText = "正在启动接收服务…";
    private PowerManager.WakeLock wakeLock;
    private WifiManager.MulticastLock multicastLock;
    private volatile boolean destroyed;

    static boolean isRunning() {
        return running && instance != null;
    }

    static String lastError() {
        return lastError;
    }

    static int activePort() {
        return activePort;
    }

    static boolean cloudConnected() {
        return cloudConnected;
    }

    static String cloudError() {
        return cloudError;
    }

    static void restart(Context context) {
        Intent intent = new Intent(context, NotifyService.class).setAction(AppInfo.ACTION_RESTART);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        running = true;
        destroyed = false;
        NotificationHelper.createChannels(this);
        startForegroundCompat(NotificationHelper.buildServiceNotification(this, "正在启动接收服务…", false));
        acquireWakeLock();
        acquireMulticastLock();
        Thread starter = new Thread(this::startServers, "dsh-service-start");
        starter.setDaemon(true);
        starter.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && AppInfo.ACTION_RESTART.equals(intent.getAction())) {
            Thread restarter = new Thread(this::startServers, "dsh-service-restart");
            restarter.setDaemon(true);
            restarter.start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        running = false;
        stopServers();
        releaseWakeLock();
        releaseMulticastLock();
        instance = null;
        broadcastEvent("stopped");
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public void deliver(NotifyPayload payload) {
        String key = payload.id == null ? "" : payload.id.trim();
        if (key.isEmpty()) key = payload.status + "|" + payload.title + "|" + payload.ts;
        long now = System.currentTimeMillis();
        synchronized (recentDeliveries) {
            Iterator<Map.Entry<String, Long>> iterator = recentDeliveries.entrySet().iterator();
            while (iterator.hasNext()) {
                if (now - iterator.next().getValue() > DEDUPE_WINDOW_MS) iterator.remove();
            }
            if (recentDeliveries.containsKey(key)) {
                Log.i(TAG, "duplicate " + payload.id + " ignored");
                return;
            }
            recentDeliveries.put(key, now);
            while (recentDeliveries.size() > DEDUPE_LIMIT) {
                Iterator<String> oldest = recentDeliveries.keySet().iterator();
                if (oldest.hasNext()) {
                    oldest.next();
                    oldest.remove();
                }
            }
        }
        NotificationHelper.notifyTask(this, payload);
        Store.get(this).addHistory(payload);
        broadcastEvent("notification");
        Log.i(TAG, "delivered " + payload.id + " " + payload.status);
    }

    private synchronized void startServers() {
        if (destroyed) return;
        stopServers();
        Store store = Store.get(this);
        int port = store.getPort();
        String name = store.getDeviceName();
        String token = store.getToken();
        Exception httpFailure = null;
        for (int attempt = 0; attempt < 3 && httpServer == null; attempt++) {
            try {
                NotifyHttpServer server = new NotifyHttpServer(port, token, name, AppInfo.VERSION, this);
                server.start();
                httpServer = server;
                activePort = server.getPort();
                lastError = "";
                Log.i(TAG, "HTTP receiver listening on " + activePort);
            } catch (Exception error) {
                httpFailure = error;
                if (attempt < 2) {
                    try { Thread.sleep(300); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        if (httpServer == null) {
            lastError = "端口 " + port + " 启动失败：" + messageOf(httpFailure);
            Log.e(TAG, "HTTP receiver failed", httpFailure);
            activePort = 0;
        }
        if (httpServer != null) {
            try {
                discoveryServer = new DiscoveryServer(AppInfo.DISCOVERY_PORT, name, activePort, AppInfo.VERSION, Build.MODEL);
                discoveryServer.start();
            } catch (Exception error) {
                discoveryServer = null;
                Log.w(TAG, "discovery responder failed", error);
            }
        }
        startCloud(store);

        String endpoint = httpServer == null ? null : NetworkUtils.endpoint(activePort);
        if (endpoint != null) {
            serviceText = name + " · " + endpoint;
            if (store.isCloudEnabled()) serviceText += cloudConnected ? " · 云已连接" : " · 云连接中";
        } else if (store.isCloudEnabled()) {
            serviceText = name + (cloudConnected ? " · 云已连接" : " · 云连接中");
        } else {
            serviceText = name + " · 接收服务启动失败";
        }
        updateServiceNotification(serviceText, httpServer == null && !store.isCloudEnabled());
        broadcastEvent("started");
    }

    private synchronized void startCloud(Store store) {
        stopCloud();
        cloudConnected = false;
        cloudError = "";
        if (!store.isCloudEnabled()) return;
        String url = store.getCloudUrl();
        String token = store.getCloudToken();
        String device = store.getCloudDevice();
        if (url.isEmpty() || token.isEmpty()) {
            cloudError = "云端地址或令牌未配置";
            broadcastEvent("cloud");
            return;
        }
        SSLSocketFactory socketFactory = null;
        if (url.startsWith("https://")) {
            try {
                socketFactory = CloudTls.socketFactory(this);
            } catch (Exception error) {
                cloudError = "云端证书加载失败";
                broadcastEvent("cloud");
                Log.e(TAG, "cloud CA load failed", error);
                return;
            }
        }
        CloudClient client = new CloudClient(url, token, device, store.getCloudLastEventId(), socketFactory, new CloudClient.Listener() {
            @Override
            public void onConnected(String endpoint) {
                cloudConnected = true;
                cloudError = "";
                serviceText = serviceText.replace("云连接中", "云已连接");
                updateServiceNotification(serviceText, false);
                broadcastEvent("cloud");
                Log.i(TAG, "cloud relay connected");
            }

            @Override
            public void onDisconnected(String error) {
                cloudConnected = false;
                cloudError = error == null ? "云端连接断开" : error;
                serviceText = serviceText.replace("云已连接", "云重连中");
                updateServiceNotification(serviceText, false);
                broadcastEvent("cloud");
                Log.w(TAG, "cloud relay disconnected: " + cloudError);
            }

            @Override
            public void onPayload(NotifyPayload payload, long eventId) {
                if (eventId > 0) store.setCloudLastEventId(eventId);
                deliver(payload);
            }
        });
        cloudClient = client;
        client.start();
        Log.i(TAG, "cloud relay client starting for device " + device);
    }

    private synchronized void stopServers() {
        if (httpServer != null) {
            httpServer.stop();
            httpServer = null;
        }
        if (discoveryServer != null) {
            discoveryServer.stop();
            discoveryServer = null;
        }
        stopCloud();
        activePort = 0;
    }

    private synchronized void stopCloud() {
        if (cloudClient != null) {
            cloudClient.stop();
            cloudClient = null;
        }
        cloudConnected = false;
        cloudError = "";
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NotificationHelper.SERVICE_NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NotificationHelper.SERVICE_NOTIFICATION_ID, notification);
        }
    }

    private void updateServiceNotification(String text, boolean error) {
        serviceText = text;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(NotificationHelper.SERVICE_NOTIFICATION_ID,
                NotificationHelper.buildServiceNotification(this, text, error));
    }

    private void broadcastEvent(String kind) {
        Intent intent = new Intent(AppInfo.ACTION_EVENT);
        intent.setPackage(getPackageName());
        intent.putExtra("kind", kind);
        sendBroadcast(intent);
    }

    private void acquireWakeLock() {
        try {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power == null) return;
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh-task-notify:receiver");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (RuntimeException error) {
            Log.w(TAG, "wake lock unavailable", error);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (RuntimeException ignored) {
            // The system may already have released it.
        }
        wakeLock = null;
    }

    /**
     * Broadcast discovery needs the Wi-Fi chip to pass broadcast frames to the
     * app; without a multicast lock many devices filter them while asleep.
     */
    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            multicastLock = wifi.createMulticastLock("dsh-task-notify:discovery");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        } catch (RuntimeException error) {
            Log.w(TAG, "multicast lock unavailable", error);
        }
    }

    private void releaseMulticastLock() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (RuntimeException ignored) {
            // The system may already have released it.
        }
        multicastLock = null;
    }

    private static String messageOf(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? error == null ? "未知错误" : error.getClass().getSimpleName() : message;
    }
}
