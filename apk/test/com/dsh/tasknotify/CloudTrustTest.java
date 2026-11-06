package com.dsh.tasknotify;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.X509TrustManager;

/**
 * JVM test for the certificate pinning rules used by the App's cloud relay.
 *
 * <p>{@code keytool} generates a throwaway self-signed certificate; the test
 * then checks the three states a phone can be in: no pin yet, pin matches, and
 * pin changed.</p>
 */
public final class CloudTrustTest {
    private static int passed;
    private static int failed;

    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("dtn-trust-");
        Path store = dir.resolve("relay.p12");
        String password = "changeit";
        String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        Process process = new ProcessBuilder(
                keytool,
                "-genkeypair", "-alias", "relay", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "365", "-dname", "CN=127.0.0.1",
                "-ext", "SAN=IP:127.0.0.1",
                "-keystore", store.toString(), "-storetype", "PKCS12",
                "-storepass", password, "-keypass", password)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start();
        if (process.waitFor() != 0) {
            System.out.println("FAIL keytool could not create a test certificate");
            System.exit(1);
        }

        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(store)) {
            keyStore.load(input, password.toCharArray());
        }
        X509Certificate certificate = (X509Certificate) keyStore.getCertificate("relay");
        X509Certificate[] chain = new X509Certificate[]{certificate};
        X509TrustManager manager = CloudTrust.trustManager();

        // 1. Unknown certificate: the phone records the fingerprint and refuses.
        CloudTrust.configure("");
        CloudTrust.clearSeen();
        try {
            manager.checkServerTrusted(chain, "RSA");
            fail("unpinned self-signed certificate must be refused");
        } catch (CloudTrust.UnpinnedCertificate expected) {
            pass("unpinned certificate refused");
        }
        String fingerprint = CloudTrust.pendingFingerprint();
        check("fingerprint captured", fingerprint.matches("[0-9a-f]{64}"));
        check("fingerprint display", CloudTrust.display(fingerprint).split(":").length == 32);
        check("subject captured", CloudTrust.pendingSubject().contains("127.0.0.1"));

        // 2. Pinned certificate: accepted even though no CA signs it.
        CloudTrust.configure(fingerprint);
        try {
            manager.checkServerTrusted(chain, "RSA");
            pass("pinned certificate accepted");
        } catch (Exception error) {
            fail("pinned certificate rejected: " + error);
        }

        // 3. Changed certificate: refused with a dedicated signal.
        CloudTrust.configure("00".repeat(32));
        try {
            manager.checkServerTrusted(chain, "RSA");
            fail("changed certificate must be refused");
        } catch (CloudTrust.FingerprintChanged expected) {
            pass("changed certificate refused");
        }

        // 4. Fingerprint parsing accepts the colon form shown in UIs.
        check("normalize colon form", CloudTrust.normalize(CloudTrust.display(fingerprint)).equals(fingerprint));
        check("reject short input", CloudTrust.normalize("abcd").isEmpty());

        System.out.println("RESULT passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    private static void check(String name, boolean condition) {
        if (condition) pass(name); else fail(name);
    }

    private static void pass(String name) {
        passed++;
        System.out.println("PASS " + name);
    }

    private static void fail(String name) {
        failed++;
        System.out.println("FAIL " + name);
    }
}
