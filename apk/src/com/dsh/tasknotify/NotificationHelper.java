package com.dsh.tasknotify;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;

import java.util.concurrent.atomic.AtomicInteger;

/** Notification channels and builders for task alerts and the foreground service. */
final class NotificationHelper {
    static final String CHANNEL_TASK = "task_done";
    static final String CHANNEL_SERVICE = "service";
    static final int SERVICE_NOTIFICATION_ID = 1;
    private static final int TASK_NOTIFICATION_BASE = 1000;
    private static final AtomicInteger COUNTER = new AtomicInteger();

    private NotificationHelper() {
    }

    static void createChannels(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel task = new NotificationChannel(
                CHANNEL_TASK,
                context.getString(R.string.channel_task),
                NotificationManager.IMPORTANCE_HIGH
        );
        task.setDescription(context.getString(R.string.channel_task_description));
        task.enableVibration(true);
        task.setVibrationPattern(new long[]{0, 180, 110, 180});
        task.enableLights(true);
        task.setLightColor(0xFFA8C7FA);
        task.setShowBadge(true);
        task.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        AudioAttributes audio = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (sound != null) task.setSound(sound, audio);
        manager.createNotificationChannel(task);

        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE,
                context.getString(R.string.channel_service),
                NotificationManager.IMPORTANCE_LOW
        );
        service.setDescription(context.getString(R.string.channel_service_description));
        service.setShowBadge(false);
        service.enableVibration(false);
        service.setSound(null, null);
        manager.createNotificationChannel(service);
    }

    static boolean notificationsEnabled(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    static void notifyTask(Context context, NotifyPayload payload) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        createChannels(context);

        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("notification_id", payload.id);
        PendingIntent pending = PendingIntent.getActivity(
                context,
                Math.abs(payload.id.hashCode()),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        StringBuilder big = new StringBuilder(payload.body == null ? "" : payload.body);
        String details = payload.detailsLine();
        if (!details.isEmpty()) big.append("\n\n").append(details);
        big.append("\n\n点按打开 App 查看记录");

        Notification.Builder builder = new Notification.Builder(context, CHANNEL_TASK)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(payload.notificationTitle())
                .setContentText(payload.body)
                .setStyle(new Notification.BigTextStyle().bigText(big.toString()))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .setColor(0xFFA8C7FA)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(payload.ts > 0 ? payload.ts : System.currentTimeMillis())
                .setShowWhen(true)
                .setGroup("dsh.tasks")
                .setGroupSummary(false)
                .setPriority(Notification.PRIORITY_HIGH)
                .setOnlyAlertOnce(false);

        int id = TASK_NOTIFICATION_BASE + COUNTER.incrementAndGet();
        manager.notify(id, builder.build());
    }

    static Notification buildServiceNotification(Context context, String text, boolean error) {
        createChannels(context);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                context,
                1,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(context, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setColor(error ? 0xFFF87171 : 0xFFA8C7FA)
                .setPriority(Notification.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                .build();
    }

    static void showTest(Context context) {
        notifyTask(context, NotifyPayload.demo());
    }

    static void cancelServiceNotification(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(SERVICE_NOTIFICATION_ID);
    }
}
