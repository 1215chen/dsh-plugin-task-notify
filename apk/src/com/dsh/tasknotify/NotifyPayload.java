package com.dsh.tasknotify;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One validated notification delivered by the desktop plugin.
 *
 * <p>All fields are sanitized and bounded here, before any UI or notification
 * code sees them, so a malformed or hostile request cannot produce an
 * oversized notification or arbitrary content.</p>
 */
final class NotifyPayload {
    static final String VERSION = "1.0.0";

    final String id;
    final String status;
    final String headline;
    final String title;
    final String body;
    final String sessionId;
    final String project;
    final String cwd;
    final String model;
    final String host;
    final String time;
    final long turn;
    final long durationMs;
    final long steps;
    final long tools;
    final long ts;

    private NotifyPayload(String id, String status, String headline, String title, String body,
                          String sessionId, String project, String cwd, String model, String host,
                          String time, long turn, long durationMs, long steps, long tools, long ts) {
        this.id = id;
        this.status = status;
        this.headline = headline;
        this.title = title;
        this.body = body;
        this.sessionId = sessionId;
        this.project = project;
        this.cwd = cwd;
        this.model = model;
        this.host = host;
        this.time = time;
        this.turn = turn;
        this.durationMs = durationMs;
        this.steps = steps;
        this.tools = tools;
        this.ts = ts;
    }

    static NotifyPayload parse(byte[] body) throws Json.ParseException {
        if (body == null || body.length == 0) throw new Json.ParseException("empty body");
        return parse(new String(body, java.nio.charset.StandardCharsets.UTF_8));
    }

    static NotifyPayload parse(String body) throws Json.ParseException {
        Object decoded = Json.parse(body);
        Map<String, Object> map = Json.object(decoded);
        if (map == null) throw new Json.ParseException("notification body must be a JSON object");
        long version = Json.optLong(map, "v", 0);
        if (version != 1) throw new Json.ParseException("unsupported notification version");
        String status = clean(Json.optString(map, "status", "manual"), 24);
        if (status.isEmpty()) status = "manual";
        String id = clean(Json.optString(map, "id", ""), 96);
        if (id.isEmpty()) id = "p_" + System.currentTimeMillis();
        String headline = clean(Json.optString(map, "headline", ""), 48);
        if (headline.isEmpty()) headline = defaultHeadline(status);
        String title = clean(Json.optString(map, "title", ""), 96);
        if (title.isEmpty()) title = "DSH 会话";
        String text = clean(Json.optString(map, "body", ""), 600);
        if (text.isEmpty()) text = defaultBody(status);
        long now = System.currentTimeMillis();
        long ts = clamp(Json.optLong(map, "ts", now), 0, 4102444800000L);
        if (ts == 0) ts = now;
        return new NotifyPayload(
                id,
                status,
                headline,
                title,
                text,
                clean(Json.optString(map, "sessionId", ""), 120),
                clean(Json.optString(map, "project", ""), 60),
                clean(Json.optString(map, "cwd", ""), 300),
                clean(Json.optString(map, "model", ""), 80),
                clean(Json.optString(map, "host", ""), 60),
                clean(Json.optString(map, "time", ""), 40),
                clamp(Json.optLong(map, "turn", -1), -1, 1000000),
                clamp(Json.optLong(map, "durationMs", 0), 0, 2592000000L),
                clamp(Json.optLong(map, "steps", 0), 0, 1000000),
                clamp(Json.optLong(map, "tools", 0), 0, 1000000),
                ts
        );
    }

    static NotifyPayload demo() {
        long now = System.currentTimeMillis();
        return new NotifyPayload(
                "demo_" + now,
                "test",
                "DSH 通知测试",
                "这台手机已准备好接收任务通知",
                "如果你看到这条通知，说明通知权限和提示音都正常。回到 DSH 任务完成后，就会推送到这里。",
                "", "", "", "", "", "",
                -1, 0, 0, 0, now
        );
    }

    private static String defaultHeadline(String status) {
        switch (status) {
            case "completed": return "任务完成";
            case "error": return "任务失败";
            case "aborted": return "任务已取消";
            case "blocked": return "任务在等你";
            case "max-tokens": return "输出达到上限";
            case "interrupted": return "任务已中断";
            case "forked": return "会话已分叉";
            case "started": return "DSH 通知已连接";
            case "test": return "DSH 通知测试";
            case "approval": return "需要授权";
            default: return "DSH 通知";
        }
    }

    private static String defaultBody(String status) {
        switch (status) {
            case "completed": return "这一轮任务已经完成。";
            case "error": return "这一轮任务以错误结束，请回到 DSH 查看。";
            case "aborted": return "这一轮任务已被取消。";
            case "blocked": return "任务需要你的确认或补充信息。";
            case "approval": return "有一个操作需要你授权，请回到 DSH 处理。";
            default: return "点按查看详情。";
        }
    }

    private static String clean(String value, int limit) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(Math.min(value.length(), limit));
        boolean pendingSpace = false;
        for (int index = 0; index < value.length() && out.length() < limit; index++) {
            char current = value.charAt(index);
            if (current == '\n' || current == '\r' || current == '\t' || current == ' ') {
                pendingSpace = out.length() > 0;
                continue;
            }
            if (current < 0x20 || (current >= 0x7f && current <= 0x9f)) continue;
            if (pendingSpace) {
                out.append(' ');
                pendingSpace = false;
                if (out.length() >= limit) break;
            }
            out.append(current);
        }
        return out.toString().trim();
    }

    private static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Compact secondary line used in the expanded notification. */
    String detailsLine() {
        StringBuilder details = new StringBuilder();
        if (durationMs > 0) {
            if (durationMs < 60000) details.append("用时 ").append(Math.max(1, Math.round(durationMs / 1000.0))).append(" 秒");
            else details.append("用时 ").append(durationMs / 60000).append(" 分钟");
        }
        if (tools > 0) {
            if (details.length() > 0) details.append(" · ");
            details.append(tools).append(" 次工具调用");
        }
        if (!project.isEmpty()) {
            if (details.length() > 0) details.append(" · ");
            details.append(project);
        }
        if (!model.isEmpty()) {
            if (details.length() > 0) details.append(" · ");
            details.append(model);
        }
        return details.toString();
    }

    String notificationTitle() {
        if (title.isEmpty() || title.equals(headline)) return headline;
        return headline + " · " + title;
    }

    String toJson() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("v", 1);
        map.put("id", id);
        map.put("status", status);
        map.put("headline", headline);
        map.put("title", title);
        map.put("body", body);
        map.put("sessionId", sessionId);
        map.put("project", project);
        map.put("cwd", cwd);
        map.put("model", model);
        if (turn >= 0) map.put("turn", turn);
        map.put("durationMs", durationMs);
        map.put("steps", steps);
        map.put("tools", tools);
        map.put("host", host);
        map.put("time", time);
        map.put("ts", ts);
        map.put("app", "dsh");
        return Json.stringify(map);
    }
}
