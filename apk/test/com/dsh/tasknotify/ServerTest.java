package com.dsh.tasknotify;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Desktop JVM harness for the exact receiver code shipped inside the APK.
 * Run with: java -cp build/jvm-classes:build/test-classes com.dsh.tasknotify.ServerTest
 */
public final class ServerTest {
    private static int passed;
    private static int failed;

    public static void main(String[] args) throws Exception {
        AtomicReference<NotifyPayload> received = new AtomicReference<>();
        NotifyHttpServer server = new NotifyHttpServer(0, "", "Test Phone", "1.0.0", received::set);
        server.start();
        int port = server.getPort();
        int discoveryPort = 18766;
        DiscoveryServer discovery = new DiscoveryServer(discoveryPort, "Test Phone", port, "1.0.0", "JVM");
        discovery.start();
        try {
            testPing(port);
            testNotify(port, received);
            testBadJson(port);
            testDiscovery(discoveryPort, port);
        } finally {
            discovery.stop();
            server.stop();
        }

        AtomicReference<NotifyPayload> secured = new AtomicReference<>();
        NotifyHttpServer tokenServer = new NotifyHttpServer(0, "secret-token", "Token Phone", "1.0.0", secured::set);
        tokenServer.start();
        try {
            testTokenRequired(tokenServer.getPort());
            testTokenAccepted(tokenServer.getPort(), secured);
        } finally {
            tokenServer.stop();
        }

        System.out.println("RESULT passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    private static void testPing(int port) throws Exception {
        Response response = request("GET", "http://127.0.0.1:" + port + "/ping", null, null);
        check("ping status", response.code == 200, "code=" + response.code);
        Map<String, Object> json = Json.object(Json.parse(response.body));
        check("ping ok", json != null && Boolean.TRUE.equals(json.get("ok")), response.body);
        check("ping name", json != null && "Test Phone".equals(json.get("name")), response.body);
        check("ping port", json != null && ((Number) json.get("port")).intValue() == port, response.body);
    }

    private static void testNotify(int port, AtomicReference<NotifyPayload> received) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", 1);
        payload.put("id", "test-1");
        payload.put("status", "completed");
        payload.put("headline", "任务完成");
        payload.put("title", "生成季度报告");
        payload.put("body", "报告已写入 D:\\work\\report.docx");
        payload.put("durationMs", 42000);
        payload.put("tools", 7);
        payload.put("project", "dsh_task_done");
        Response response = request("POST", "http://127.0.0.1:" + port + "/notify", Json.stringify(payload), null);
        check("notify status", response.code == 200, "code=" + response.code + " body=" + response.body);
        NotifyPayload got = received.get();
        check("notify delivered", got != null, "sink received nothing");
        if (got != null) {
            check("notify title", "生成季度报告".equals(got.title), got.title);
            check("notify status field", "completed".equals(got.status), got.status);
            check("notify tools", got.tools == 7, "tools=" + got.tools);
            check("notify summary", got.detailsLine().contains("42 秒"), got.detailsLine());
        }
    }

    private static void testBadJson(int port) throws Exception {
        Response response = request("POST", "http://127.0.0.1:" + port + "/notify", "{not json", null);
        check("bad json rejected", response.code == 400, "code=" + response.code);
        Response wrongVersion = request("POST", "http://127.0.0.1:" + port + "/notify", "{\"v\":2}", null);
        check("wrong version rejected", wrongVersion.code == 400, "code=" + wrongVersion.code);
    }

    private static void testDiscovery(int discoveryPort, int notifyPort) throws Exception {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(2000);
            byte[] probe = "{\"t\":\"dsh.discover\",\"v\":1}".getBytes(StandardCharsets.UTF_8);
            socket.send(new DatagramPacket(probe, probe.length, InetAddress.getByName("127.0.0.1"), discoveryPort));
            byte[] buffer = new byte[2048];
            DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
            socket.receive(reply);
            String text = new String(reply.getData(), reply.getOffset(), reply.getLength(), StandardCharsets.UTF_8);
            Map<String, Object> json = Json.object(Json.parse(text));
            check("discovery type", json != null && "dsh.device".equals(json.get("t")), text);
            check("discovery port", json != null && ((Number) json.get("port")).intValue() == notifyPort, text);
            check("discovery name", json != null && "Test Phone".equals(json.get("name")), text);
        }
    }

    private static void testTokenRequired(int port) throws Exception {
        Response response = request("POST", "http://127.0.0.1:" + port + "/notify", "{\"v\":1,\"id\":\"x\"}", null);
        check("token required", response.code == 401, "code=" + response.code);
        Response ping = request("GET", "http://127.0.0.1:" + port + "/ping", null, null);
        check("token required for ping", ping.code == 401, "code=" + ping.code);
    }

    private static void testTokenAccepted(int port, AtomicReference<NotifyPayload> received) throws Exception {
        Response response = request("POST", "http://127.0.0.1:" + port + "/notify", "{\"v\":1,\"id\":\"y\",\"status\":\"completed\"}", "secret-token");
        check("token accepted", response.code == 200, "code=" + response.code + " body=" + response.body);
        check("token sink", received.get() != null, "no payload");
    }

    private static void check(String name, boolean condition, String detail) {
        if (condition) {
            passed++;
            System.out.println("PASS " + name);
        } else {
            failed++;
            System.out.println("FAIL " + name + " :: " + detail);
        }
    }

    private static Response request(String method, String url, String body, String token) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(3000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text = readAll(stream);
        connection.disconnect();
        return new Response(code, text);
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = stream.read(chunk)) >= 0) buffer.write(chunk, 0, read);
        stream.close();
        return buffer.toString(StandardCharsets.UTF_8.name());
    }

    private static final class Response {
        final int code;
        final String body;

        Response(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }
}
