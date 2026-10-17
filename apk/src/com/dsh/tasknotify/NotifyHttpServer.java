package com.dsh.tasknotify;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Minimal HTTP/1.1 receiver for the desktop plugin.
 *
 * <p>Only two routes matter: {@code GET /ping} for connectivity checks and
 * {@code POST /notify} for a task notification. The server is intentionally
 * dependency-free so the same source runs on Android and on a desktop JVM in
 * the test harness.</p>
 */
final class NotifyHttpServer {
    private static final int MAX_HEADER_BYTES = 16384;
    private static final int MAX_BODY_BYTES = 131072;
    private static final int MAX_HEADERS = 64;

    private final int requestedPort;
    private final String token;
    private final String deviceName;
    private final String version;
    private final NotifySink sink;

    private volatile boolean running;
    private volatile int boundPort;
    private volatile long startedAt;
    private ServerSocket serverSocket;
    private ExecutorService workers;
    private Thread acceptThread;

    NotifyHttpServer(int port, String token, String deviceName, String version, NotifySink sink) {
        this.requestedPort = port;
        this.token = token == null ? "" : token.trim();
        this.deviceName = deviceName == null ? "" : deviceName;
        this.version = version == null ? NotifyPayload.VERSION : version;
        this.sink = sink;
    }

    synchronized void start() throws IOException {
        if (running) return;
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(requestedPort), 16);
        this.serverSocket = socket;
        this.boundPort = socket.getLocalPort();
        this.startedAt = System.currentTimeMillis();
        this.running = true;
        this.workers = Executors.newFixedThreadPool(4, new ThreadFactory() {
            private final AtomicInteger counter = new AtomicInteger();

            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "dsh-http-" + counter.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            }
        });
        this.acceptThread = new Thread(this::acceptLoop, "dsh-http-accept");
        this.acceptThread.setDaemon(true);
        this.acceptThread.start();
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            // The listener is being torn down anyway.
        }
        if (workers != null) workers.shutdownNow();
        if (acceptThread != null) acceptThread.interrupt();
        serverSocket = null;
        workers = null;
        acceptThread = null;
    }

    boolean isRunning() {
        return running;
    }

    int getPort() {
        return boundPort;
    }

    long getStartedAt() {
        return startedAt;
    }

    private void acceptLoop() {
        while (running) {
            Socket client = null;
            try {
                client = serverSocket.accept();
                client.setSoTimeout(10000);
                Socket accepted = client;
                try {
                    workers.execute(() -> handle(accepted));
                } catch (RuntimeException rejected) {
                    closeQuietly(accepted);
                }
            } catch (IOException error) {
                closeQuietly(client);
                if (!running) return;
                sleepQuietly(80);
            }
        }
    }

    private void handle(Socket client) {
        try {
            InputStream input = new BufferedInputStream(client.getInputStream());
            Request request = readRequest(input);
            if (request == null) {
                send(client, 400, "Bad Request", error("empty request"));
                return;
            }
            responseLoop:
            {
                if ("OPTIONS".equals(request.method)) {
                    send(client, 204, "No Content", "");
                    break responseLoop;
                }
                String path = request.path;
                if ("GET".equals(request.method) && ("/ping".equals(path) || "/status".equals(path) || "/".equals(path))) {
                    if (!authorized(request)) {
                        sendUnauthorized(client);
                        break responseLoop;
                    }
                    Map<String, Object> body = new java.util.LinkedHashMap<>();
                    body.put("ok", true);
                    body.put("app", "dsh-task-notify");
                    body.put("version", version);
                    body.put("name", deviceName);
                    body.put("port", boundPort);
                    body.put("time", System.currentTimeMillis());
                    send(client, 200, "OK", Json.stringify(body));
                    break responseLoop;
                }
                if ("POST".equals(request.method) && "/notify".equals(path)) {
                    if (!authorized(request)) {
                        sendUnauthorized(client);
                        break responseLoop;
                    }
                    NotifyPayload payload;
                    try {
                        payload = NotifyPayload.parse(request.body);
                    } catch (Json.ParseException error) {
                        send(client, 400, "Bad Request", error(error.getMessage()));
                        break responseLoop;
                    }
                    try {
                        sink.deliver(payload);
                    } catch (RuntimeException failure) {
                        send(client, 500, "Internal Server Error", error("notification failed"));
                        break responseLoop;
                    }
                    Map<String, Object> body = new java.util.LinkedHashMap<>();
                    body.put("ok", true);
                    body.put("id", payload.id);
                    body.put("receivedAt", System.currentTimeMillis());
                    send(client, 200, "OK", Json.stringify(body));
                    break responseLoop;
                }
                if ("POST".equals(request.method) && "/test".equals(path)) {
                    if (!authorized(request)) {
                        sendUnauthorized(client);
                        break responseLoop;
                    }
                    NotifyPayload payload = NotifyPayload.demo();
                    try {
                        sink.deliver(payload);
                    } catch (RuntimeException failure) {
                        send(client, 500, "Internal Server Error", error("notification failed"));
                        break responseLoop;
                    }
                    Map<String, Object> body = new java.util.LinkedHashMap<>();
                    body.put("ok", true);
                    body.put("id", payload.id);
                    send(client, 200, "OK", Json.stringify(body));
                    break responseLoop;
                }
                if ("/notify".equals(path) || "/test".equals(path)) send(client, 405, "Method Not Allowed", error("method not allowed"));
                else send(client, 404, "Not Found", error("not found"));
            }
        } catch (IOException ignored) {
            // Client disconnected; nothing useful to send.
        } catch (RuntimeException ignored) {
            // Never let one malformed connection take the listener down.
        } finally {
            closeQuietly(client);
        }
    }

    private Request readRequest(InputStream input) throws IOException {
        String requestLine = readLine(input, 4096);
        if (requestLine == null || requestLine.trim().isEmpty()) return null;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return null;
        String method = parts[0].toUpperCase(Locale.ROOT);
        String target = parts[1];
        int query = target.indexOf('?');
        if (query >= 0) target = target.substring(0, query);
        if (target.length() > 512) return null;
        Map<String, String> headers = new HashMap<>();
        int headerBytes = 0;
        for (int count = 0; count < MAX_HEADERS; count++) {
            String line = readLine(input, MAX_HEADER_BYTES);
            if (line == null || line.isEmpty()) break;
            headerBytes += line.length() + 2;
            if (headerBytes > MAX_HEADER_BYTES) return null;
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            if (!name.isEmpty() && !headers.containsKey(name)) headers.put(name, value);
        }
        long contentLength = 0;
        String lengthHeader = headers.get("content-length");
        if (lengthHeader != null) {
            try {
                contentLength = Long.parseLong(lengthHeader);
            } catch (NumberFormatException error) {
                return null;
            }
            if (contentLength < 0 || contentLength > MAX_BODY_BYTES) return null;
        }
        byte[] body = new byte[(int) contentLength];
        int offset = 0;
        while (offset < body.length) {
            int read = input.read(body, offset, body.length - offset);
            if (read < 0) break;
            offset += read;
        }
        if (offset != body.length) return null;
        return new Request(method, target, headers, body);
    }

    private static String readLine(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        while (buffer.size() <= limit) {
            int next = input.read();
            if (next < 0) return buffer.size() == 0 ? null : buffer.toString(StandardCharsets.ISO_8859_1.name());
            if (next == '\n') break;
            if (next != '\r') buffer.write(next);
        }
        if (buffer.size() > limit) return null;
        return buffer.toString(StandardCharsets.ISO_8859_1.name());
    }

    private boolean authorized(Request request) {
        if (token.isEmpty()) return true;
        String header = request.headers.get("authorization");
        if (header == null) return false;
        String provided = header.regionMatches(true, 0, "Bearer ", 0, 7) ? header.substring(7).trim() : "";
        return MessageDigest.isEqual(provided.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    private void sendUnauthorized(Socket client) throws IOException {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", "unauthorized");
        byte[] encoded = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 401 Unauthorized\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + encoded.length + "\r\n"
                + "WWW-Authenticate: Bearer\r\n"
                + "Connection: close\r\n"
                + "Cache-Control: no-store\r\n\r\n";
        OutputStream output = client.getOutputStream();
        output.write(head.getBytes(StandardCharsets.US_ASCII));
        output.write(encoded);
        output.flush();
    }

    private static String error(String message) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", message == null ? "error" : message);
        return Json.stringify(body);
    }

    private void send(Socket client, int code, String reason, String body) throws IOException {
        byte[] encoded = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + encoded.length + "\r\n"
                + "Connection: close\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n\r\n";
        OutputStream output = client.getOutputStream();
        output.write(head.getBytes(StandardCharsets.US_ASCII));
        if (encoded.length > 0) output.write(encoded);
        output.flush();
    }

    private static void closeQuietly(Socket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class Request {
        final String method;
        final String path;
        final Map<String, String> headers;
        final byte[] body;

        Request(String method, String path, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }
    }
}
