package com.dsh.tasknotify;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** Desktop JVM smoke test for the SSE client and CA pinning. */
public final class CloudClientLiveTest {
    public static void main(String[] args) throws Exception {
        String baseUrl = require("CLOUD_URL");
        String token = require("CLOUD_TOKEN");
        String device = require("CLOUD_DEVICE");
        String caFile = require("CLOUD_CA");
        String caPem = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(caFile)), StandardCharsets.US_ASCII);
        SSLSocketFactory factory = trust(caPem);

        CountDownLatch connected = new CountDownLatch(1);
        CountDownLatch received = new CountDownLatch(1);
        AtomicReference<NotifyPayload> payloadRef = new AtomicReference<>();
        AtomicReference<String> errorRef = new AtomicReference<>();

        CloudClient client = new CloudClient(baseUrl, token, device, 0, factory, new CloudClient.Listener() {
            @Override
            public void onConnected(String endpoint) {
                connected.countDown();
            }

            @Override
            public void onDisconnected(String error) {
                errorRef.set(error);
            }

            @Override
            public void onPayload(NotifyPayload payload, long eventId) {
                payloadRef.set(payload);
                received.countDown();
            }
        });
        client.start();
        if (!connected.await(15, TimeUnit.SECONDS)) {
            client.stop();
            throw new AssertionError("SSE did not connect: " + errorRef.get());
        }
        System.out.println("PASS SSE connected with pinned CA");

        String id = "jvm-" + System.currentTimeMillis();
        String body = "{\"device\":\"" + device + "\",\"payload\":{"
                + "\"v\":1,\"id\":\"" + id + "\",\"status\":\"completed\","
                + "\"headline\":\"云端 JVM 测试\",\"title\":\"CloudClient\","
                + "\"body\":\"SSE + CA pinning 通过\",\"ts\":" + System.currentTimeMillis() + "}}";
        HttpsURLConnection connection = (HttpsURLConnection) new URL(baseUrl + "/api/v1/notify").openConnection();
        connection.setSSLSocketFactory(factory);
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = connection.getResponseCode();
        String response = read(connection.getInputStream());
        if (status != 200) throw new AssertionError("notify HTTP " + status + ": " + response);
        System.out.println("PASS notify HTTP 200 " + response);

        if (!received.await(12, TimeUnit.SECONDS)) {
            client.stop();
            throw new AssertionError("payload not received: " + errorRef.get());
        }
        NotifyPayload payload = payloadRef.get();
        if (payload == null || !"CloudClient".equals(payload.title) || !"SSE + CA pinning 通过".equals(payload.body)) {
            client.stop();
            throw new AssertionError("unexpected payload");
        }
        client.stop();
        System.out.println("PASS CloudClient SSE payload");
        System.out.println("CLOUD CLIENT LIVE TEST PASSED");
    }

    private static String require(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) throw new IllegalStateException("missing env " + name);
        return value;
    }

    private static SSLSocketFactory trust(String pem) throws Exception {
        CertificateFactory certificateFactory = CertificateFactory.getInstance("X.509");
        Certificate certificate;
        try (InputStream input = new java.io.ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII))) {
            certificate = certificateFactory.generateCertificate(input);
        }
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        keyStore.setCertificateEntry("cloud-ca", certificate);
        TrustManagerFactory trustManagerFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trustManagerFactory.init(keyStore);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustManagerFactory.getTrustManagers(), null);
        return context.getSocketFactory();
    }

    private static String read(InputStream input) throws Exception {
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) text.append(line);
        }
        return text.toString();
    }
}
