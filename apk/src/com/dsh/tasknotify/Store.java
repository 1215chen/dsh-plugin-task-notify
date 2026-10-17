package com.dsh.tasknotify;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Small SharedPreferences-backed settings and notification history store. */
final class Store {
    private static final String PREFS = "dsh_task_notify";
    private static final String KEY_PORT = "port";
    private static final String KEY_NAME = "device_name";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_HISTORY = "history";
    private static final String KEY_CLOUD_ENABLED = "cloud_enabled";
    private static final String KEY_CLOUD_URL = "cloud_url";
    private static final String KEY_CLOUD_DEVICE = "cloud_device";
    private static final String KEY_CLOUD_TOKEN = "cloud_token";
    private static final String KEY_CLOUD_LAST_EVENT = "cloud_last_event";
    private static final int HISTORY_LIMIT = 50;

    private static Store instance;

    private final SharedPreferences preferences;

    private Store(Context context) {
        this.preferences = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized Store get(Context context) {
        if (instance == null) instance = new Store(context);
        return instance;
    }

    int getPort() {
        return clamp(preferences.getInt(KEY_PORT, 8765), 1024, 65535);
    }

    void setPort(int port) {
        preferences.edit().putInt(KEY_PORT, clamp(port, 1024, 65535)).apply();
    }

    String getDeviceName() {
        String name = preferences.getString(KEY_NAME, null);
        if (name != null && !name.trim().isEmpty()) return name.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        return model.isEmpty() ? "我的手机" : model;
    }

    void setDeviceName(String name) {
        String clean = name == null ? "" : name.trim();
        preferences.edit().putString(KEY_NAME, clean).apply();
    }

    String getToken() {
        return preferences.getString(KEY_TOKEN, "");
    }

    void setToken(String token) {
        preferences.edit().putString(KEY_TOKEN, token == null ? "" : token.trim()).apply();
    }

    boolean isEnabled() {
        return preferences.getBoolean(KEY_ENABLED, true);
    }

    void setEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    boolean isCloudEnabled() {
        return preferences.getBoolean(KEY_CLOUD_ENABLED, false);
    }

    void setCloudEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_CLOUD_ENABLED, enabled).apply();
    }

    String getCloudUrl() {
        return preferences.getString(KEY_CLOUD_URL, "");
    }

    void setCloudUrl(String url) {
        preferences.edit().putString(KEY_CLOUD_URL, url == null ? "" : url.trim()).apply();
    }

    String getCloudDevice() {
        String device = preferences.getString(KEY_CLOUD_DEVICE, "my-phone");
        return device == null || device.trim().isEmpty() ? "my-phone" : device.trim();
    }

    void setCloudDevice(String device) {
        preferences.edit().putString(KEY_CLOUD_DEVICE, device == null ? "my-phone" : device.trim()).apply();
    }

    String getCloudToken() {
        return preferences.getString(KEY_CLOUD_TOKEN, "");
    }

    void setCloudToken(String token) {
        preferences.edit().putString(KEY_CLOUD_TOKEN, token == null ? "" : token.trim()).apply();
    }

    long getCloudLastEventId() {
        return preferences.getLong(KEY_CLOUD_LAST_EVENT, 0);
    }

    void setCloudLastEventId(long eventId) {
        preferences.edit().putLong(KEY_CLOUD_LAST_EVENT, Math.max(0, eventId)).apply();
    }

    synchronized List<HistoryEntry> getHistory() {
        String raw = preferences.getString(KEY_HISTORY, "[]");
        List<HistoryEntry> entries = new ArrayList<>();
        try {
            List<Object> decoded = Json.array(Json.parse(raw));
            if (decoded == null) return entries;
            for (Object item : decoded) {
                HistoryEntry entry = HistoryEntry.fromJson(Json.object(item));
                if (entry != null) entries.add(entry);
                if (entries.size() >= HISTORY_LIMIT) break;
            }
        } catch (Json.ParseException ignored) {
            // A corrupted history must never block notifications.
        }
        return entries;
    }

    synchronized void addHistory(NotifyPayload payload) {
        List<HistoryEntry> entries = getHistory();
        entries.add(0, HistoryEntry.fromPayload(payload));
        while (entries.size() > HISTORY_LIMIT) entries.remove(entries.size() - 1);
        List<Object> encoded = new ArrayList<>();
        for (HistoryEntry entry : entries) encoded.add(entry.toMap());
        preferences.edit().putString(KEY_HISTORY, Json.stringify(encoded)).apply();
    }

    synchronized void clearHistory() {
        preferences.edit().putString(KEY_HISTORY, "[]").apply();
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    /** One retained notification line for the history list. */
    static final class HistoryEntry {
        final long ts;
        final String status;
        final String headline;
        final String title;
        final String body;
        final String project;

        HistoryEntry(long ts, String status, String headline, String title, String body, String project) {
            this.ts = ts;
            this.status = status;
            this.headline = headline;
            this.title = title;
            this.body = body;
            this.project = project;
        }

        static HistoryEntry fromPayload(NotifyPayload payload) {
            return new HistoryEntry(payload.ts, payload.status, payload.headline, payload.title, payload.body, payload.project);
        }

        static HistoryEntry fromJson(Map<String, Object> map) {
            if (map == null) return null;
            return new HistoryEntry(
                    Json.optLong(map, "ts", System.currentTimeMillis()),
                    Json.optString(map, "status", "completed"),
                    Json.optString(map, "headline", "任务完成"),
                    Json.optString(map, "title", ""),
                    Json.optString(map, "body", ""),
                    Json.optString(map, "project", "")
            );
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("ts", ts);
            map.put("status", status);
            map.put("headline", headline);
            map.put("title", title);
            map.put("body", body);
            map.put("project", project);
            return map;
        }
    }
}
