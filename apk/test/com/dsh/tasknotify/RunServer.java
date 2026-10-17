package com.dsh.tasknotify;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;

/** Long-running receiver used by the plugin integration test. */
public final class RunServer {
    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 18765;
        int discoveryPort = args.length > 1 ? Integer.parseInt(args[1]) : 18766;
        Path ready = Paths.get(args.length > 2 ? args[2] : "server-ready.txt");
        Path output = Paths.get(args.length > 3 ? args[3] : "notifications.jsonl");
        String token = args.length > 4 ? args[4] : "";
        if (Files.exists(output)) Files.delete(output);
        if (Files.exists(ready)) Files.delete(ready);

        NotifyHttpServer server = new NotifyHttpServer(port, token, "JVM Phone", "1.0.0", payload -> {
            try {
                Files.write(output, (payload.toJson() + "\n").getBytes(StandardCharsets.UTF_8),
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException ignored) {
                // The test will notice a missing line.
            }
            System.out.println("NOTIFY " + payload.id + " " + payload.status + " " + payload.title);
        });
        server.start();
        DiscoveryServer discovery = new DiscoveryServer(discoveryPort, "JVM Phone", server.getPort(), "1.0.0", "JVM");
        discovery.start();
        Files.write(ready, String.valueOf(server.getPort()).getBytes(StandardCharsets.UTF_8));
        System.out.println("READY " + server.getPort());

        long deadline = System.currentTimeMillis() + 180000;
        while (System.currentTimeMillis() < deadline) {
            if (Files.exists(Paths.get("server-stop.txt"))) break;
            Thread.sleep(200);
        }
        discovery.stop();
        server.stop();
        System.out.println("STOPPED");
    }
}
