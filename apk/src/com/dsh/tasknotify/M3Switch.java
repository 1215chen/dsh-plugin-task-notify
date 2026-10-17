package com.dsh.tasknotify;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * A small Material 3 switch: 52x32dp track, animated thumb, 48dp touch target.
 * Implemented locally because the app has no AndroidX/Material Components
 * dependency and the platform Switch cannot express the M3 track/thumb shapes.
 */
public final class M3Switch extends View {
    public interface OnCheckedChangeListener {
        void onCheckedChanged(M3Switch view, boolean isChecked);
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF track = new RectF();
    private final ArgbEvaluator evaluator = new ArgbEvaluator();
    private final float density;

    private boolean checked;
    private float fraction;
    private ValueAnimator animator;
    private OnCheckedChangeListener listener;

    private final int trackOn;
    private final int trackOff;
    private final int thumbOn;
    private final int thumbOff;
    private final int outline;

    public M3Switch(Context context) {
        this(context, null);
    }

    public M3Switch(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public M3Switch(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        density = context.getResources().getDisplayMetrics().density;
        trackOn = context.getColor(R.color.primary);
        trackOff = context.getColor(R.color.surface_container_highest);
        thumbOn = context.getColor(R.color.on_primary);
        thumbOff = context.getColor(R.color.outline);
        outline = context.getColor(R.color.outline);
        setClickable(true);
        setFocusable(true);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }

    public void setOnCheckedChangeListener(OnCheckedChangeListener listener) {
        this.listener = listener;
    }

    public boolean isChecked() {
        return checked;
    }

    public void setChecked(boolean checked) {
        setChecked(checked, false);
    }

    public void setChecked(boolean checked, boolean animate) {
        if (this.checked == checked && (animator == null || !animator.isRunning())) {
            this.checked = checked;
            fraction = checked ? 1f : 0f;
            invalidate();
            return;
        }
        this.checked = checked;
        if (!animate) {
            if (animator != null) animator.cancel();
            fraction = checked ? 1f : 0f;
            invalidate();
            return;
        }
        if (animator != null) animator.cancel();
        animator = ValueAnimator.ofFloat(fraction, checked ? 1f : 0f);
        animator.setDuration(180);
        animator.addUpdateListener(valueAnimator -> {
            fraction = (float) valueAnimator.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int desiredWidth = Math.round(52 * density);
        int desiredHeight = Math.round(48 * density);
        setMeasuredDimension(
                resolveSize(desiredWidth, widthMeasureSpec),
                resolveSize(Math.max(desiredHeight, getSuggestedMinimumHeight()), heightMeasureSpec)
        );
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        float trackWidth = 52 * density;
        float trackHeight = 32 * density;
        float left = (getWidth() - trackWidth) / 2f;
        float top = (getHeight() - trackHeight) / 2f;
        track.set(left, top, left + trackWidth, top + trackHeight);
        float radius = trackHeight / 2f;

        int currentTrack = blend(trackOff, trackOn, fraction);
        int currentThumb = blend(thumbOff, thumbOn, fraction);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(currentTrack);
        canvas.drawRoundRect(track, radius, radius, paint);

        if (fraction < 1f) {
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(2 * density);
            paint.setColor(outline);
            paint.setAlpha((int) (255 * (1f - fraction)));
            RectF border = new RectF(track);
            border.inset(density, density);
            canvas.drawRoundRect(border, radius - density, radius - density, paint);
            paint.setAlpha(255);
        }

        float thumbRadius = (10 + 2 * fraction) * density;
        float thumbX = left + (16 + 18 * fraction) * density;
        float thumbY = getHeight() / 2f;
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(currentThumb);
        canvas.drawCircle(thumbX, thumbY, thumbRadius, paint);

        if (isPressed()) {
            paint.setColor(0x1FFFFFFF);
            canvas.drawCircle(thumbX, thumbY, thumbRadius + 8 * density, paint);
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                setPressed(true);
                return true;
            case MotionEvent.ACTION_CANCEL:
                setPressed(false);
                return true;
            case MotionEvent.ACTION_UP:
                setPressed(false);
                if (isEnabled()) performClick();
                return true;
            default:
                return super.onTouchEvent(event);
        }
    }

    @Override
    public boolean performClick() {
        super.performClick();
        setChecked(!checked, true);
        if (listener != null) listener.onCheckedChanged(this, checked);
        return true;
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Switch");
        info.setCheckable(true);
        info.setChecked(checked);
    }

    @Override
    public void onInitializeAccessibilityEvent(AccessibilityEvent event) {
        super.onInitializeAccessibilityEvent(event);
        event.setClassName("android.widget.Switch");
        event.setChecked(checked);
    }

    private int blend(int from, int to, float fraction) {
        return (int) evaluator.evaluate(fraction, from, to);
    }
}
