package com.dsh.tasknotify;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;

/**
 * Server-Sent Events client for the self-hosted cloud relay.
 *
 * <p>Pure Java so it can be exercised by the desktop JVM test harness. The
 * Android service supplies a {@link Listener} that posts notifications and
 * persists the last event id for replay after a reconnect.</p>
 */
final class CloudClient {
    interface Listener {
        void onConnected(String endpoint);

        void onDisconnected(String error);

        void onPayload(NotifyPayload payload, long eventId);
    }

    private final String baseUrl;
    private final String token;
    private final String device;
    private final Listener listener;
    private final SSLSocketFactory sslSocketFactory;

    private volatile boolean running;
    private volatile boolean connected;
    private volatile String lastError = "";
    private volatile long lastEventId;
    private volatile HttpURLConnection connection;
    private Thread thread;

    CloudClient(String baseUrl, String token, String device, long lastEventId, Listener listener) {
        this(baseUrl, token, device, lastEventId, null, listener);
    }

    CloudClient(String baseUrl, String token, String device, long lastEventId,
                SSLSocketFactory sslSocketFactory, Listener listener) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim().replaceAll("/+$", "");
        this.token = token == null ? "" : token.trim();
        this.device = device == null ? "" : device.trim();
        this.lastEventId = Math.max(0, lastEventId);
        this.sslSocketFactory = sslSocketFactory;
        this.listener = listener;
    }

    void start() {
        if (running) return;
        running = true;
        connected = false;
        thread = new Thread(this::loop, "dsh-cloud-sse");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
        connected = false;
        HttpURLConnection current = connection;
        if (current != null) {
            try {
                current.disconnect();
            } catch (RuntimeException ignored) {
                // Already disconnected.
            }
        }
        if (thread != null) thread.interrupt();
        thread = null;
    }

    boolean isConnected() {
        return connected;
    }

    String lastError() {
        return lastError;
    }

    long lastEventId() {
        return lastEventId;
    }

    String endpoint() {
        return baseUrl;
    }

    private void loop() {
        long backoff = 1000;
        while (running) {
            try {
                connectAndRead();
                if (!running) break;
                lastError = "云端连接已断开";
            } catch (Exception error) {
                if (!running) break;
                lastError = describe(error);
            }
            boolean wasConnected = connected;
            connected = false;
            if (wasConnected) backoff = 1000;
            if (!running) break;
            try {
                listener.onDisconnected(lastError);
            } catch (RuntimeException ignored) {
                // The service must not be able to kill the reconnect loop.
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
            backoff = Math.min(60000, Math.max(1000, backoff * 2));
        }
        connected = false;
    }

    private void connectAndRead() throws IOException {
        String endpoint = baseUrl + "/api/v1/stream?device=" + URLEncoder.encode(device, StandardCharsets.UTF_8.name());
        HttpURLConnection current = (HttpURLConnection) new URL(endpoint).openConnection();
        connection = current;
        if (sslSocketFactory != null && current instanceof HttpsURLConnection) {
            ((HttpsURLConnection) current).setSSLSocketFactory(sslSocketFactory);
        }
        current.setRequestMethod("GET");
        current.setConnectTimeout(15000);
        current.setReadTimeout(45000);
        current.setRequestProperty("Accept", "text/event-stream");
        current.setRequestProperty("Accept-Encoding", "identity");
        current.setRequestProperty("Cache-Control", "no-cache");
        current.setRequestProperty("Authorization", "Bearer " + token);
        if (lastEventId > 0) current.setRequestProperty("Last-Event-ID", Long.toString(lastEventId));

        int status = current.getResponseCode();
        if (status != 200) {
            String detail = readError(current);
            throw new IOException("HTTP " + status + (detail.isEmpty() ? "" : " " + detail));
        }

        connected = true;
        lastError = "";
        try {
            listener.onConnected(endpoint);
        } catch (RuntimeException ignored) {
            // Keep streaming even if a UI refresh fails.
        }

        StringBuilder data = null;
        long eventId = -1;
        try (InputStream input = current.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data != null && data.length() > 0 && eventId > 0) {
                        lastEventId = eventId;
                    }
                    dispatch(eventId, data);
                    data = null;
                    eventId = -1;
                    continue;
                }
                if (line.charAt(0) == ':') continue;
                int colon = line.indexOf(':');
                String field = colon >= 0 ? line.substring(0, colon) : line;
                String value = colon >= 0 ? line.substring(colon + 1) : "";
                if (value.startsWith(" ")) value = value.substring(1);
                if ("id".equals(field)) {
                    try {
                        eventId = Long.parseLong(value);
                    } catch (NumberFormatException ignored) {
                        eventId = -1;
                    }
                } else if ("data".equals(field)) {
                    if (data == null) data = new StringBuilder();
                    if (data.length() > 0) data.append('\n');
                    data.append(value);
                }
            }
        } finally {
            current.disconnect();
            connection = null;
        }
        if (running) throw new IOException("云端连接关闭");
    }

    private void dispatch(long eventId, StringBuilder data) {
        if (data == null || data.length() == 0) return;
        NotifyPayload payload;
        try {
            payload = NotifyPayload.parse(data.toString());
        } catch (Json.ParseException error) {
            lastError = "收到无效的云端通知";
            return;
        }
        try {
            listener.onPayload(payload, Math.max(eventId, 0));
        } catch (RuntimeException error) {
            lastError = "通知处理失败";
        }
    }

    private static String readError(HttpURLConnection connection) {
        try (InputStream error = connection.getErrorStream()) {
            if (error == null) return "";
            byte[] buffer = new byte[512];
            int read = error.read(buffer);
            if (read <= 0) return "";
            return new String(buffer, 0, read, StandardCharsets.UTF_8).trim();
        } catch (IOException ignored) {
            return "";
        }
    }

    private static String describe(Exception error) {
        if (error instanceof UnknownHostException) return "找不到云端域名";
        if (error instanceof ConnectException) return "云端拒绝连接";
        if (error instanceof SocketTimeoutException) return "云端连接超时";
        if (error instanceof SSLException) return "云端 TLS 证书错误";
        String message = error == null ? null : error.getMessage();
        if (message == null) return "云端连接失败";
        String lower = message.toLowerCase(Locale.ROOT);
        if (lower.contains("http 401") || lower.contains("http 403")) return "云端令牌不匹配";
        if (lower.contains("http 404")) return "云端地址不正确";
        return message.length() > 120 ? message.substring(0, 120) : message;
    }
}
