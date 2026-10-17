package com.dsh.tasknotify;

/** Constants shared by the receiver UI, service and notification code. */
final class AppInfo {
    static final String VERSION = "1.2.1";
    static final String APP_ID = "dsh-task-notify";
    static final int DISCOVERY_PORT = 8766;
    static final String ACTION_EVENT = "com.dsh.tasknotify.EVENT";
    static final String ACTION_RESTART = "com.dsh.tasknotify.RESTART";

    private AppInfo() {
    }
}
