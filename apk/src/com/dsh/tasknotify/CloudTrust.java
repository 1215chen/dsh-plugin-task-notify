package com.dsh.tasknotify;

import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Trust policy for the self-hosted cloud relay.
 *
 * <p>A self-hosted relay normally uses a self-signed certificate, so there is no
 * public CA to embed (and embedding one would tie every installation to the
 * maintainer's private key). Instead the phone pins the <em>leaf</em>
 * certificate: the first successful handshake exposes its SHA-256 fingerprint,
 * the user confirms it once in the App, and every later connection must present
 * the same certificate.</p>
 *
 * <p>Certificates that the platform already trusts (a public CA) are accepted
 * without pinning. Once a fingerprint is pinned, only that certificate is
 * accepted — a public CA cannot override the pin.</p>
 */
final class CloudTrust {
    /** Thrown when the relay presents a certificate the phone has not pinned yet. */
    static final class UnpinnedCertificate extends CertificateException {
        private static final long serialVersionUID = 1L;

        UnpinnedCertificate(String message) {
            super(message);
        }
    }

    /** Thrown when the relay presents a different certificate than the pinned one. */
    static final class FingerprintChanged extends CertificateException {
        private static final long serialVersionUID = 1L;

        FingerprintChanged(String message) {
            super(message);
        }
    }

    private static volatile String pinned = "";
    private static volatile String seen = "";
    private static volatile String seenSubject = "";
    private static volatile String seenValidTo = "";

    private CloudTrust() {
    }

    /** Install the fingerprint persisted by the user ("" means "not pinned"). */
    static void configure(String fingerprint) {
        pinned = normalize(fingerprint);
    }

    static String pinnedFingerprint() {
        return pinned;
    }

    /** Fingerprint of the certificate seen during the last handshake. */
    static String pendingFingerprint() {
        return seen;
    }

    static String pendingSubject() {
        return seenSubject;
    }

    static String pendingValidTo() {
        return seenValidTo;
    }

    /** Forget the last handshake result, e.g. after the relay URL changed. */
    static void clearSeen() {
        seen = "";
        seenSubject = "";
        seenValidTo = "";
    }

    /** Lowercase hex without separators, or "" when the input is not a SHA-256. */
    static String normalize(String fingerprint) {
        String text = fingerprint == null ? "" : fingerprint.trim().toLowerCase(Locale.ROOT);
        if (text.startsWith("sha256:") || text.startsWith("sha256=")) text = text.substring(7);
        StringBuilder hex = new StringBuilder(64);
        for (int index = 0; index < text.length(); index++) {
            char current = text.charAt(index);
            if ((current >= '0' && current <= '9') || (current >= 'a' && current <= 'f')) hex.append(current);
        }
        return hex.length() == 64 ? hex.toString() : "";
    }

    /** Render a fingerprint as colon-separated upper-case pairs for display. */
    static String display(String fingerprint) {
        String hex = normalize(fingerprint);
        if (hex.isEmpty()) return "";
        StringBuilder out = new StringBuilder(95);
        for (int index = 0; index < hex.length(); index += 2) {
            if (out.length() > 0) out.append(':');
            out.append(hex, index, index + 2);
        }
        return out.toString().toUpperCase(Locale.ROOT);
    }

    static SSLSocketFactory socketFactory() throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{trustManager()}, null);
        return context.getSocketFactory();
    }

    /** The pinning trust manager wrapped around the platform trust store. */
    static X509TrustManager trustManager() throws Exception {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        X509TrustManager system = null;
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) {
                system = (X509TrustManager) manager;
                break;
            }
        }
        if (system == null) throw new IllegalStateException("no system trust manager");
        return new Manager(system);
    }

    private static String sha256(X509Certificate certificate) throws CertificateException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(certificate.getEncoded());
            StringBuilder out = new StringBuilder(hash.length * 2);
            for (byte value : hash) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            return out.toString();
        } catch (Exception error) {
            throw new CertificateException("cannot hash server certificate", error);
        }
    }

    private static void record(X509Certificate leaf) throws CertificateException {
        seen = sha256(leaf);
        try {
            seenSubject = leaf.getSubjectX500Principal().getName();
        } catch (RuntimeException error) {
            seenSubject = "";
        }
        try {
            seenValidTo = leaf.getNotAfter() == null ? "" : leaf.getNotAfter().toString();
        } catch (RuntimeException error) {
            seenValidTo = "";
        }
    }

    /** Trust manager that pins one leaf certificate, with platform trust as fallback. */
    private static final class Manager implements X509TrustManager {
        private final X509TrustManager system;

        Manager(X509TrustManager system) {
            this.system = system;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            system.checkClientTrusted(chain, authType);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("empty certificate chain");
            record(chain[0]);
            String pin = pinned;
            if (!pin.isEmpty()) {
                if (!pin.equals(seen)) throw new FingerprintChanged("relay certificate fingerprint changed");
                return;
            }
            try {
                system.checkServerTrusted(chain, authType);
            } catch (CertificateException error) {
                throw new UnpinnedCertificate("relay certificate is not trusted yet");
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return system.getAcceptedIssuers();
        }
    }
}
