package com.dsh.tasknotify;

/** Receives one validated notification; implemented by the Android service. */
interface NotifySink {
    void deliver(NotifyPayload payload);
}
