package com.chinastudyfree.app;

import android.content.Context;
import android.speech.tts.TextToSpeech;

import java.util.Locale;

/**
 * 离线语音导读：包装系统 TTS（android.speech.tts），中文（zh-CN）。
 *
 * 设计约定：
 *   - 只是「锦上添花」：没装 TTS 引擎、语音数据缺失、初始化失败时全部静默降级，
 *     绝不抛异常打断阅读或答题流程。
 *   - 同一时间只播一段（QUEUE_FLUSH），进入下一题/答题时调用 stop() 打断。
 *   - 引擎是进程级单例，Activity 销毁时 shutdown() 并清空，下次使用重新初始化。
 */
public class Tts {

    private static final String UTTERANCE_PREFIX = "csf-tts-";

    private static Tts instance;

    private TextToSpeech engine;
    private boolean ready;
    private boolean failed;
    private int counter;
    /** 引擎是异步初始化的：未就绪时点朗读，把文本存下来，就绪后补播一次 */
    private String pending;

    public static synchronized Tts get(Context context) {
        if (instance == null) instance = new Tts(context.getApplicationContext());
        return instance;
    }

    private Tts(Context appContext) {
        try {
            engine = new TextToSpeech(appContext, status -> {
                if (status != TextToSpeech.SUCCESS || engine == null) {
                    failed = true;
                    return;
                }
                try {
                    int result = engine.setLanguage(Locale.SIMPLIFIED_CHINESE);
                    ready = result != TextToSpeech.LANG_MISSING_DATA
                            && result != TextToSpeech.LANG_NOT_SUPPORTED;
                    failed = !ready;
                    if (ready) {
                        engine.setSpeechRate(0.95f);
                        String queued = pending;
                        pending = null;
                        if (queued != null) speak(queued);
                    }
                } catch (Throwable t) {
                    failed = true;
                }
            });
        } catch (Throwable t) {
            failed = true;
        }
    }

    /** 引擎就绪且支持中文才返回 true（初始化是异步的，刚进页面时可能为 false）。 */
    public boolean available() {
        return ready && !failed && engine != null;
    }

    /** 返回 false 表示本机没有可用的语音引擎（调用方可以据此提示用户）。 */
    public boolean speak(String text) {
        if (text == null) return false;
        String body = text.trim();
        if (body.isEmpty()) return false;
        if (!available()) {
            if (failed) return false;
            pending = body;
            return true;
        }
        try {
            stop();
            String id = UTTERANCE_PREFIX + (++counter);
            engine.speak(body, TextToSpeech.QUEUE_FLUSH, null, id);
            return true;
        } catch (Throwable ignored) {
            // 静默：语音失败不影响学习流程
            return false;
        }
    }

    public void stop() {
        if (engine == null) return;
        try {
            engine.stop();
        } catch (Throwable ignored) {
        }
    }

    public synchronized void shutdown() {
        if (engine != null) {
            try {
                engine.stop();
                engine.shutdown();
            } catch (Throwable ignored) {
            }
        }
        engine = null;
        ready = false;
        failed = false;
        instance = null;
    }
}
