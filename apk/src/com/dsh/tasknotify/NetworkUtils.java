package com.dsh.tasknotify;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Enumeration;
import java.util.Locale;

/** Best-effort LAN address discovery for the status card. */
final class NetworkUtils {
    private NetworkUtils() {
    }

    static String localIpv4() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return null;
            String fallback = null;
            while (interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (network == null || !network.isUp() || network.isLoopback()) continue;
                String name = network.getName() == null ? "" : network.getName().toLowerCase(Locale.ROOT);
                for (InterfaceAddress address : network.getInterfaceAddresses()) {
                    InetAddress inet = address.getAddress();
                    if (!(inet instanceof Inet4Address) || inet.isLoopbackAddress()) continue;
                    String host = inet.getHostAddress();
                    if (host == null || host.startsWith("169.254.")) continue;
                    if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("eth") || name.startsWith("wifi")) {
                        return host;
                    }
                    if (fallback == null) fallback = host;
                }
            }
            return fallback;
        } catch (SocketException ignored) {
            return null;
        }
    }

    static String endpoint(int port) {
        String host = localIpv4();
        return host == null ? null : host + ":" + port;
    }

    /** True for URLs that point back at this device (used only for local testing). */
    static boolean isLoopbackUrl(String url) {
        try {
            String host = new java.net.URL(url).getHost();
            if (host == null) return false;
            String normalized = host.toLowerCase(Locale.ROOT);
            return "localhost".equals(normalized) || "127.0.0.1".equals(normalized)
                    || "::1".equals(normalized) || "[::1]".equals(normalized);
        } catch (Exception error) {
            return false;
        }
    }
}
