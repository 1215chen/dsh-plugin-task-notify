package com.dsh.tasknotify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Restarts the receiver after a reboot when the user left it enabled. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        if (!Store.get(context).isEnabled()) return;
        try {
            Intent service = new Intent(context, NotifyService.class);
            context.startForegroundService(service);
        } catch (RuntimeException error) {
            Log.w("DSHNotify", "boot start refused", error);
        }
    }
}
