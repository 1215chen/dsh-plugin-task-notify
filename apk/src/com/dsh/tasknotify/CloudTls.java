package com.dsh.tasknotify;

import android.content.Context;

import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** Trusts exactly the self-signed CA embedded in res/raw/dsh_cloud_ca.pem. */
final class CloudTls {
    private CloudTls() {
    }

    static SSLSocketFactory socketFactory(Context context) throws Exception {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        Certificate certificate;
        try (InputStream input = context.getResources().openRawResource(R.raw.dsh_cloud_ca)) {
            certificate = factory.generateCertificate(input);
        }
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        keyStore.setCertificateEntry("dsh-cloud-ca", certificate);
        TrustManagerFactory trustFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trustFactory.init(keyStore);
        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, trustFactory.getTrustManagers(), null);
        return sslContext.getSocketFactory();
    }
}
