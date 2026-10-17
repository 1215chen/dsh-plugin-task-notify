package com.dsh.tasknotify;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Material Design 3 shell: two destinations (notifications / settings), a
 * status-and-history home page, and every action on the settings page.
 */
public final class MainActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 1001;

    private final SimpleDateFormat timeFormat = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault());

    private View homePage;
    private View settingsPage;
    private ScrollView homeScroll;
    private View historyHeader;
    private LinearLayout navHome;
    private LinearLayout navSettings;
    private View navHomePill;
    private View navSettingsPill;
    private ImageView navHomeIcon;
    private ImageView navSettingsIcon;
    private TextView navHomeLabel;
    private TextView navSettingsLabel;

    private TextView topTitle;
    private TextView topSubtitle;
    private TextView statusTitle;
    private TextView statusChip;
    private TextView addressText;
    private TextView statusDetail;
    private TextView lastDelivery;
    private TextView statusError;
    private TextView historyCount;
    private TextView cloudStatus;
    private View statusDot;
    private LinearLayout historyList;
    private View historyEmpty;

    private M3Switch serviceSwitch;
    private M3Switch cloudSwitch;
    private View cloudFields;
    private EditText cloudUrl;
    private EditText cloudDevice;
    private EditText cloudToken;
    private EditText inputPort;
    private EditText inputName;
    private EditText inputToken;
    private TextView aboutVersion;

    private BroadcastReceiver eventsReceiver;
    private boolean receiverRegistered;
    private boolean updatingSwitch;
    private boolean updatingCloudSwitch;
    private int pageIndex = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        configureSystemBars();
        NotificationHelper.createChannels(this);

        homePage = findViewById(R.id.homePage);
        settingsPage = findViewById(R.id.settingsPage);
        settingsPage.setVisibility(View.GONE);
        homeScroll = (ScrollView) homePage;
        historyHeader = findViewById(R.id.historyHeader);
        navHome = findViewById(R.id.navHome);
        navSettings = findViewById(R.id.navSettings);
        navHomePill = findViewById(R.id.navHomePill);
        navSettingsPill = findViewById(R.id.navSettingsPill);
        navHomeIcon = findViewById(R.id.navHomeIcon);
        navSettingsIcon = findViewById(R.id.navSettingsIcon);
        navHomeLabel = findViewById(R.id.navHomeLabel);
        navSettingsLabel = findViewById(R.id.navSettingsLabel);

        topTitle = findViewById(R.id.topTitle);
        topSubtitle = findViewById(R.id.topSubtitle);
        statusTitle = findViewById(R.id.statusTitle);
        statusChip = findViewById(R.id.statusChip);
        addressText = findViewById(R.id.addressText);
        statusDetail = findViewById(R.id.statusDetail);
        lastDelivery = findViewById(R.id.lastDelivery);
        statusError = findViewById(R.id.statusError);
        historyCount = findViewById(R.id.historyCount);
        cloudStatus = findViewById(R.id.cloudStatus);
        statusDot = findViewById(R.id.statusDot);
        historyList = findViewById(R.id.historyList);
        historyEmpty = findViewById(R.id.historyEmpty);

        serviceSwitch = findViewById(R.id.serviceSwitch);
        cloudSwitch = findViewById(R.id.cloudSwitch);
        cloudFields = findViewById(R.id.cloudFields);
        cloudUrl = findViewById(R.id.cloudUrl);
        cloudDevice = findViewById(R.id.cloudDevice);
        cloudToken = findViewById(R.id.cloudToken);
        inputPort = findViewById(R.id.inputPort);
        inputName = findViewById(R.id.inputName);
        inputToken = findViewById(R.id.inputToken);
        aboutVersion = findViewById(R.id.aboutVersion);

        populateSettings();

        navHome.setOnClickListener(view -> {
            if (pageIndex == 0) homeScroll.smoothScrollTo(0, 0);
            else showPage(0, true);
        });
        navSettings.setOnClickListener(view -> showPage(1, true));
        findViewById(R.id.serviceRow).setOnClickListener(view -> serviceSwitch.performClick());
        serviceSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (updatingSwitch) return;
            setServiceEnabled(isChecked);
        });
        findViewById(R.id.cloudRow).setOnClickListener(view -> cloudSwitch.performClick());
        cloudSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (updatingCloudSwitch) return;
            setCloudEnabled(isChecked);
        });

        findViewById(R.id.btnTest).setOnClickListener(view -> testNotification());
        findViewById(R.id.btnBattery).setOnClickListener(view -> openBatterySettings());
        findViewById(R.id.btnGuide).setOnClickListener(view -> showBackgroundGuide());
        findViewById(R.id.btnSave).setOnClickListener(view -> saveSettings());
        findViewById(R.id.btnClear).setOnClickListener(view -> confirmClearHistory());
        findViewById(R.id.btnAbout).setOnClickListener(view -> showAbout());

        if (Store.get(this).isEnabled() && !NotifyService.isRunning()) startReceiverService();
        requestNotificationPermission();
        showPage(0, false);
        if (getIntent() != null && getIntent().hasExtra("notification_id")) scrollToHistory();
    }

    @Override
    protected void onStart() {
        super.onStart();
        registerEventsReceiver();
        refreshUi();
    }

    @Override
    protected void onStop() {
        unregisterEventsReceiver();
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshUi();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        showPage(0, false);
        if (intent != null && intent.hasExtra("notification_id")) scrollToHistory();
        refreshUi();
    }

    @Override
    public void onBackPressed() {
        if (pageIndex == 1) {
            showPage(0, true);
            return;
        }
        super.onBackPressed();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Toast.makeText(this, granted ? "通知权限已开启" : "没有通知权限，任务提醒不会显示", Toast.LENGTH_SHORT).show();
        if (granted && NotifyService.isRunning()) NotifyService.restart(this);
        refreshUi();
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(getColor(R.color.surface));
        window.setNavigationBarColor(getColor(R.color.surface_container));
        window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void populateSettings() {
        Store store = Store.get(this);
        inputPort.setText(String.valueOf(store.getPort()));
        inputName.setText(store.getDeviceName());
        inputToken.setText(store.getToken());
        cloudUrl.setText(store.getCloudUrl());
        cloudDevice.setText(store.getCloudDevice());
        cloudToken.setText(store.getCloudToken());
        cloudSwitch.setChecked(store.isCloudEnabled());
        updateCloudFieldsVisibility();
        aboutVersion.setText("v" + AppInfo.VERSION);
    }

    private void updateCloudFieldsVisibility() {
        cloudFields.setVisibility(cloudSwitch.isChecked() ? View.VISIBLE : View.GONE);
    }

    private void showPage(int index, boolean animate) {
        if (index == pageIndex && homePage.getVisibility() == (index == 0 ? View.VISIBLE : View.GONE)) {
            updateNavigation(index == 0);
            refreshUi();
            return;
        }
        View incoming = index == 0 ? homePage : settingsPage;
        View outgoing = index == 0 ? settingsPage : homePage;
        pageIndex = index;

        topTitle.setText(index == 0 ? "通知" : "设置");
        topSubtitle.setText(index == 0 ? "任务完成或需要授权时，静默推送到这台手机" : "服务、云端与数据");
        updateNavigation(index == 0);

        if (!animate) {
            outgoing.setVisibility(View.GONE);
            incoming.setVisibility(View.VISIBLE);
            incoming.setAlpha(1f);
            incoming.setTranslationY(0f);
        } else {
            incoming.setVisibility(View.VISIBLE);
            incoming.setAlpha(0f);
            incoming.setTranslationY(dp(10));
            incoming.animate().alpha(1f).translationY(0f).setDuration(180).start();
            outgoing.animate().alpha(0f).translationY(-dp(8)).setDuration(110).withEndAction(() -> {
                outgoing.setVisibility(View.GONE);
                outgoing.setAlpha(1f);
                outgoing.setTranslationY(0f);
            }).start();
        }
        refreshUi();
    }

    private void updateNavigation(boolean homeSelected) {
        navHomePill.setVisibility(homeSelected ? View.VISIBLE : View.INVISIBLE);
        navSettingsPill.setVisibility(homeSelected ? View.INVISIBLE : View.VISIBLE);

        navHomeIcon.setImageTintList(ColorStateList.valueOf(getColor(homeSelected ? R.color.on_primary_container : R.color.on_surface_variant)));
        navSettingsIcon.setImageTintList(ColorStateList.valueOf(getColor(homeSelected ? R.color.on_surface_variant : R.color.on_primary_container)));
        navHomeLabel.setTextColor(getColor(homeSelected ? R.color.primary : R.color.on_surface_variant));
        navSettingsLabel.setTextColor(getColor(homeSelected ? R.color.on_surface_variant : R.color.primary));
    }

    private void refreshUi() {
        Store store = Store.get(this);
        boolean running = NotifyService.isRunning();

        statusDot.setBackgroundResource(running ? R.drawable.bg_dot_ok : R.drawable.bg_dot_off);
        statusTitle.setText(running ? "接收服务运行中" : "接收服务已停止");
        statusChip.setText(running ? "在线" : "已停止");
        statusChip.setBackgroundResource(running ? R.drawable.bg_chip_primary : R.drawable.bg_chip_neutral);
        statusChip.setTextColor(getColor(running ? R.color.on_primary_container : R.color.on_surface_variant));

        int port = running && NotifyService.activePort() > 0 ? NotifyService.activePort() : store.getPort();
        if (running) {
            String endpoint = NetworkUtils.endpoint(port);
            addressText.setText(endpoint == null ? "等待 Wi-Fi" : endpoint);
            statusDetail.setText(store.getDeviceName() + " · 端口 " + port + " · v" + AppInfo.VERSION);
        } else {
            addressText.setText("服务未启动");
            statusDetail.setText("在设置中启动接收服务 · v" + AppInfo.VERSION);
        }

        List<Store.HistoryEntry> entries = store.getHistory();
        if (entries.isEmpty()) {
            lastDelivery.setText(running ? "等待第一条通知" : "在设置中启动接收服务");
        } else {
            Store.HistoryEntry latest = entries.get(0);
            lastDelivery.setText("最近投递 " + timeFormat.format(new Date(latest.ts)) + " · " + latest.headline);
        }

        String error = "";
        if (!NotificationHelper.notificationsEnabled(this)) {
            error = "通知权限未开启，请在系统设置中允许。";
        } else if (running && NotifyService.lastError() != null && !NotifyService.lastError().isEmpty()) {
            error = NotifyService.lastError();
        }
        statusError.setVisibility(error.isEmpty() ? View.GONE : View.VISIBLE);
        statusError.setText(error);

        renderCloudStatus(store, running);

        historyCount.setText(entries.size() + " 条");
        rebuildHistory(entries);

        updatingSwitch = true;
        serviceSwitch.setChecked(running);
        updatingSwitch = false;
        updatingCloudSwitch = true;
        cloudSwitch.setChecked(store.isCloudEnabled());
        updatingCloudSwitch = false;
        updateCloudFieldsVisibility();
    }

    private void renderCloudStatus(Store store, boolean running) {
        String text;
        int color;
        if (!store.isCloudEnabled()) {
            text = "云端未启用";
            color = R.color.on_surface_variant;
        } else if (!running) {
            text = "云端已启用 · 接收服务未运行";
            color = R.color.warning;
        } else if (NotifyService.cloudConnected()) {
            String host = Uri.parse(store.getCloudUrl()).getHost();
            text = "云端已连接 · " + (host == null || host.isEmpty() ? store.getCloudUrl() : host);
            color = R.color.success;
        } else {
            String cloudError = NotifyService.cloudError();
            if (cloudError != null && !cloudError.isEmpty()) {
                String shortError = cloudError.length() > 48 ? cloudError.substring(0, 48) + "…" : cloudError;
                text = "云端连接失败 · " + shortError;
                color = R.color.error;
            } else {
                text = "云端连接中…";
                color = R.color.on_surface_variant;
            }
        }
        cloudStatus.setText(text);
        cloudStatus.setTextColor(getColor(color));
    }

    private void rebuildHistory(List<Store.HistoryEntry> entries) {
        historyList.removeAllViews();
        historyEmpty.setVisibility(entries.isEmpty() ? View.VISIBLE : View.GONE);
        if (entries.isEmpty()) return;

        LayoutInflater inflater = LayoutInflater.from(this);
        for (Store.HistoryEntry entry : entries) {
            View row = inflater.inflate(R.layout.item_history, historyList, false);
            ImageView icon = row.findViewById(R.id.itemIcon);
            TextView headline = row.findViewById(R.id.itemHeadline);
            TextView title = row.findViewById(R.id.itemTitle);
            TextView body = row.findViewById(R.id.itemBody);
            TextView time = row.findViewById(R.id.itemTime);

            headline.setText(entry.headline);
            title.setText(entry.title);
            title.setVisibility(entry.title == null || entry.title.isEmpty() ? View.GONE : View.VISIBLE);
            body.setText(entry.body);
            body.setVisibility(entry.body == null || entry.body.isEmpty() ? View.GONE : View.VISIBLE);
            time.setText(timeFormat.format(new Date(entry.ts > 0 ? entry.ts : System.currentTimeMillis())));

            icon.setImageResource(iconForStatus(entry.status));
            icon.setImageTintList(ColorStateList.valueOf(getColor(statusColor(entry.status))));
            row.setOnClickListener(view -> showHistoryDialog(entry));
            historyList.addView(row);
        }
    }

    private void showHistoryDialog(Store.HistoryEntry entry) {
        StringBuilder message = new StringBuilder();
        if (entry.title != null && !entry.title.isEmpty()) message.append(entry.title).append("\n\n");
        message.append(entry.body);
        if (entry.project != null && !entry.project.isEmpty()) message.append("\n\n项目：").append(entry.project);
        message.append("\n").append(timeFormat.format(new Date(entry.ts)));
        showM3Dialog(entry.headline, message.toString(), "关闭", null, null);
    }

    private static int iconForStatus(String status) {
        if (status == null) return R.drawable.ic_notifications;
        switch (status) {
            case "completed":
                return R.drawable.ic_check_circle;
            case "error":
                return R.drawable.ic_error;
            case "approval":
                return R.drawable.ic_lock;
            case "blocked":
            case "max-tokens":
            case "aborted":
            case "interrupted":
                return R.drawable.ic_schedule;
            default:
                return R.drawable.ic_notifications;
        }
    }

    private static int statusColor(String status) {
        if (status == null) return R.color.primary;
        switch (status) {
            case "completed":
                return R.color.success;
            case "error":
                return R.color.error;
            case "approval":
                return R.color.warning;
            case "blocked":
            case "max-tokens":
            case "aborted":
            case "interrupted":
                return R.color.warning;
            default:
                return R.color.primary;
        }
    }

    private void setServiceEnabled(boolean enabled) {
        Store store = Store.get(this);
        store.setEnabled(enabled);
        if (enabled) {
            startReceiverService();
            Toast.makeText(this, "正在启动接收服务…", Toast.LENGTH_SHORT).show();
        } else {
            stopService(new Intent(this, NotifyService.class));
            Toast.makeText(this, "接收服务已停止", Toast.LENGTH_SHORT).show();
        }
        serviceSwitch.postDelayed(this::refreshUi, 500);
    }

    private void setCloudEnabled(boolean enabled) {
        Store store = Store.get(this);
        store.setCloudEnabled(enabled);
        updateCloudFieldsVisibility();
        if (enabled) {
            if (!store.isEnabled()) {
                store.setEnabled(true);
                startReceiverService();
            } else if (NotifyService.isRunning()) {
                NotifyService.restart(this);
            } else {
                startReceiverService();
            }
            if (store.getCloudUrl().isEmpty() || store.getCloudToken().isEmpty()) {
                Toast.makeText(this, "请填写云端地址和令牌，然后点保存", Toast.LENGTH_LONG).show();
            } else {
                Toast.makeText(this, "云端通知已启用，正在连接…", Toast.LENGTH_SHORT).show();
            }
        } else {
            if (NotifyService.isRunning()) NotifyService.restart(this);
            Toast.makeText(this, "云端通知已关闭", Toast.LENGTH_SHORT).show();
        }
        cloudSwitch.postDelayed(this::refreshUi, 700);
    }

    private void testNotification() {
        if (!NotificationHelper.notificationsEnabled(this)) {
            requestNotificationPermission();
            Toast.makeText(this, "请先允许通知权限", Toast.LENGTH_SHORT).show();
            return;
        }
        NotificationHelper.showTest(this);
        Toast.makeText(this, "测试通知已发送，可以锁屏看一下", Toast.LENGTH_SHORT).show();
        refreshUi();
    }

    private void startReceiverService() {
        Intent intent = new Intent(this, NotifyService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    private void saveSettings() {
        int port;
        try {
            port = Integer.parseInt(inputPort.getText().toString().trim());
        } catch (NumberFormatException error) {
            inputPort.setError("请输入 1024-65535 之间的端口");
            return;
        }
        if (port < 1024 || port > 65535) {
            inputPort.setError("端口范围是 1024-65535");
            return;
        }
        String name = inputName.getText().toString().trim();
        if (name.isEmpty()) {
            inputName.setError("请输入设备名称");
            return;
        }
        if (name.length() > 40) {
            inputName.setError("最多 40 个字符");
            return;
        }
        String token = inputToken.getText().toString().trim();
        if (token.length() > 128) {
            inputToken.setError("最多 128 个字符");
            return;
        }
        String cloudUrlValue = cloudUrl.getText().toString().trim().replaceAll("/+$", "");
        String cloudDeviceValue = cloudDevice.getText().toString().trim();
        String cloudTokenValue = cloudToken.getText().toString().trim();
        boolean cloudOn = cloudSwitch.isChecked();
        if (cloudDeviceValue.isEmpty()) cloudDeviceValue = "my-phone";
        if (cloudOn) {
            if (!cloudUrlValue.matches("(?i)^https?://.+")) {
                cloudUrl.setError("请输入 http:// 或 https:// 开头的地址");
                return;
            }
            if (!cloudDeviceValue.matches("[A-Za-z0-9._-]{1,64}")) {
                cloudDevice.setError("只能包含字母、数字、点、下划线和短横线");
                return;
            }
            if (cloudTokenValue.isEmpty()) {
                cloudToken.setError("请输入云端访问令牌");
                return;
            }
            if (cloudTokenValue.length() > 128) {
                cloudToken.setError("最多 128 个字符");
                return;
            }
        }

        Store store = Store.get(this);
        store.setPort(port);
        store.setDeviceName(name);
        store.setToken(token);
        store.setCloudUrl(cloudUrlValue);
        store.setCloudDevice(cloudDeviceValue);
        store.setCloudToken(cloudTokenValue);
        store.setCloudEnabled(cloudOn);
        store.setEnabled(true);
        if (NotifyService.isRunning()) NotifyService.restart(this);
        else startReceiverService();
        Toast.makeText(this, "已保存，服务正在重启", Toast.LENGTH_SHORT).show();
        serviceSwitch.postDelayed(this::refreshUi, 900);
    }

    private void openBatterySettings() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null && power.isIgnoringBatteryOptimizations(getPackageName())) {
            Toast.makeText(this, "这台手机已忽略电池优化；vivo 还需允许后台高耗电", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (ActivityNotFoundException ignored) {
                Toast.makeText(this, "无法打开电池优化设置", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void showBackgroundGuide() {
        showM3Dialog(
                "后台运行设置",
                "vivo / iQOO：\n"
                        + "1. 设置 → 电池 → 后台耗电管理 → DSH 任务通知 → 允许后台高耗电\n"
                        + "2. 设置 → 权限管理 → 自启动 → DSH 任务通知 → 打开开机启动 / 后台启动\n\n"
                        + "其他品牌：\n"
                        + "允许自启动和后台活动，并把本应用加入电池优化白名单。\n\n"
                        + "手机与电脑需要连接同一个 Wi-Fi、同一网段。",
                "知道了", null, null
        );
    }

    private void showAbout() {
        showM3Dialog(
                "DSH 任务通知",
                "版本 " + AppInfo.VERSION + "\n\n"
                        + "局域网直连 + 自托管云端中继。任务完成或需要授权时，通知可直达同一 Wi-Fi 下的手机，"
                        + "也可经你的 HTTPS 服务器转发；不经过第三方云。\n\n"
                        + "图标来自 DSH 桌面端。\n\n"
                        + "MIT License",
                "关闭", null, null
        );
    }

    private void confirmClearHistory() {
        showM3Dialog(
                "清空通知记录",
                "只清除这台手机上的历史记录，不影响电脑端插件。",
                "清空", "取消",
                () -> {
                    Store.get(this).clearHistory();
                    refreshUi();
                }
        );
    }

    private void showM3Dialog(String title, String message, String positive, String negative, Runnable onPositive) {
        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(R.layout.dialog_message);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams params = window.getAttributes();
            params.dimAmount = 0.62f;
            window.setAttributes(params);
        }

        TextView titleView = dialog.findViewById(R.id.dialogTitle);
        TextView bodyView = dialog.findViewById(R.id.dialogBody);
        TextView positiveView = dialog.findViewById(R.id.dialogPositive);
        TextView negativeView = dialog.findViewById(R.id.dialogNegative);
        titleView.setText(title);
        bodyView.setText(message);
        positiveView.setText(positive);
        positiveView.setOnClickListener(view -> {
            dialog.dismiss();
            if (onPositive != null) onPositive.run();
        });
        if (negative == null) {
            negativeView.setVisibility(View.GONE);
        } else {
            negativeView.setVisibility(View.VISIBLE);
            negativeView.setText(negative);
            negativeView.setOnClickListener(view -> dialog.dismiss());
        }

        dialog.show();
        if (dialog.getWindow() != null) {
            int width = (int) (getResources().getDisplayMetrics().widthPixels * 0.92f);
            dialog.getWindow().setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        }
    }

    private void scrollToHistory() {
        homeScroll.post(() -> homeScroll.smoothScrollTo(0, Math.max(0, historyHeader.getTop() - dp(8))));
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
    }

    private void registerEventsReceiver() {
        if (receiverRegistered) return;
        eventsReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                refreshUi();
            }
        };
        IntentFilter filter = new IntentFilter(AppInfo.ACTION_EVENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(eventsReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(eventsReceiver, filter);
        }
        receiverRegistered = true;
    }

    private void unregisterEventsReceiver() {
        if (!receiverRegistered) return;
        try {
            unregisterReceiver(eventsReceiver);
        } catch (IllegalArgumentException ignored) {
            // Already unregistered by the framework.
        }
        eventsReceiver = null;
        receiverRegistered = false;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
