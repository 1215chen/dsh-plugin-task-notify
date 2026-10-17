package com.dsh.tasknotify;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * UDP responder for LAN pairing.
 *
 * <p>The desktop plugin broadcasts {@code {"t":"dsh.discover","v":1}} to port
 * 8766. This responder answers the sender with the phone's display name and the
 * TCP port its notification server listens on, so no IP address has to be typed
 * on either side.</p>
 */
final class DiscoveryServer {
    private final int port;
    private final String deviceName;
    private final int notifyPort;
    private final String version;
    private final String model;

    private volatile boolean running;
    private DatagramSocket socket;
    private Thread thread;

    DiscoveryServer(int port, String deviceName, int notifyPort, String version, String model) {
        this.port = port;
        this.deviceName = deviceName == null ? "" : deviceName;
        this.notifyPort = notifyPort;
        this.version = version == null ? NotifyPayload.VERSION : version;
        this.model = model == null ? "" : model;
    }

    synchronized void start() throws SocketException {
        if (running) return;
        DatagramSocket created = new DatagramSocket(null);
        created.setReuseAddress(true);
        created.setBroadcast(true);
        created.bind(new java.net.InetSocketAddress(port));
        socket = created;
        running = true;
        thread = new Thread(this::receiveLoop, "dsh-discovery");
        thread.setDaemon(true);
        thread.start();
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        if (socket != null) socket.close();
        if (thread != null) thread.interrupt();
        socket = null;
        thread = null;
    }

    boolean isRunning() {
        return running;
    }

    int getPort() {
        return port;
    }

    private void receiveLoop() {
        byte[] buffer = new byte[2048];
        while (running) {
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                socket.receive(packet);
                handle(packet);
            } catch (SocketException closed) {
                return;
            } catch (IOException ignored) {
                if (!running) return;
            }
        }
    }

    private void handle(DatagramPacket packet) {
        if (packet.getLength() <= 0 || packet.getLength() > 2048) return;
        String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
        Map<String, Object> request;
        try {
            request = Json.object(Json.parse(text));
        } catch (Json.ParseException ignored) {
            return;
        }
        if (request == null) return;
        if (!"dsh.discover".equals(Json.optString(request, "t", ""))) return;
        if (Json.optLong(request, "v", 0) != 1) return;

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("t", "dsh.device");
        response.put("v", 1);
        response.put("app", "dsh-task-notify");
        response.put("name", deviceName);
        response.put("model", model);
        response.put("port", notifyPort);
        response.put("version", version);
        response.put("time", System.currentTimeMillis());
        byte[] payload = Json.stringify(response).getBytes(StandardCharsets.UTF_8);
        InetAddress address = packet.getAddress();
        int replyPort = packet.getPort();
        if (address == null || replyPort <= 0) return;
        try {
            socket.send(new DatagramPacket(payload, payload.length, address, replyPort));
        } catch (IOException ignored) {
            // The desktop may have stopped waiting; that is normal.
        }
    }
}
