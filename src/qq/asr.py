#!/usr/bin/env python3
"""B 站音频转写（faster-whisper，本地 CPU，不联网除了第一次下模型）。

## 用法
    python asr.py <音频文件> [模型] [语言]

输出一行 JSON 到 stdout：
    {"ok": true, "text": "...", "lang": "zh", "duration": 41.2, "model": "tiny"}

失败：
    {"ok": false, "error": "..."}

## 为什么用 tiny
群里分享的视频大多几十秒到几分钟，**转写只要"说了什么"**，不需要逐字精确。
tiny 模型约 75MB，CPU 转 1 分钟音频大约 5-15 秒（int8 量化）。
base 更准但慢一倍、模型大一倍 —— 需要时用参数切换。

## 模型从哪来
第一次运行会从 HuggingFace 下载。国内慢的话设环境变量：
    HF_ENDPOINT=https://hf-mirror.com
调用方（asr.js）已经默认注入了这个镜像。
"""

import json
import os
import sys

# ⚠️ **Windows 下必须强制 UTF-8 输出**（2026-11-01 实测）。
#
# Python 在 Windows 的默认 stdout 编码是 GBK(cp936)，而调用方（Node）按 UTF-8 解码，
# 于是中文全变乱码：
#   「DeepSeek Harness 注意了」 → 「��DipSikHanis��ע�����Ђ」
# （乱码里还能认出 DeepSeek / 16KB / 431，说明转写本身是对的，只是编码错了。）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频文件参数"}, ensure_ascii=False))
        return 2

    audio = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "tiny"
    lang = sys.argv[3] if len(sys.argv) > 3 else "zh"

    if not os.path.exists(audio):
        print(json.dumps({"ok": False, "error": f"文件不存在: {audio}"}, ensure_ascii=False))
        return 2

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"faster_whisper 没装好: {e}"}, ensure_ascii=False))
        return 3

    # 繁体 → 简体。装不上就跳过（输出繁体也能读，不影响流程）。
    #
    # ⚠️ 为什么不用 `initial_prompt` 让 whisper 直接出简体：
    # 试过，简体是出来了，但**识别质量明显下降**
    # （「DeepSeek Harness」→「Deep Secret Honest」、「第一步」→「第一一日」）。
    # prompt 会被当成上文干扰声学对齐。所以改成「识别不动，事后纯文本转换」。
    try:
        from opencc import OpenCC
        cc = OpenCC("t2s")
    except Exception:  # noqa: BLE001
        cc = None

    try:
        # int8 量化：CPU 上快 2-3 倍，质量几乎无损
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            audio,
            language=lang,
            vad_filter=True,          # 跳过静音段，短视频常见大段无声
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=1,              # 贪心解码，够用且快
            # ⚠️ **不要加 `initial_prompt`**（2026-11-01 实测）。
            #
            # 试过 `initial_prompt="以下是普通话的句子，请用简体中文输出。"`：
            # 简体确实出来了（繁体字 0 个），**但识别质量明显变差** ——
            #   「DeepSeek Harness」→ 有 prompt 时变成「Deep Secret Honest」
            #   （没 prompt 时是「DipSikHanis」，更接近）
            #   「第一步」→「第一步」 vs 「第一一日」
            # 因为 prompt 会被当成上文，干扰声学对齐。
            #
            # **正确做法**：不加 prompt（保准确），繁体在下面用 OpenCC 转。
        )
        parts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        text = "".join(parts)
        # 繁体 → 简体（只在中文时做；opencc 没装就原样返回）
        if cc is not None and lang == "zh" and text:
            try:
                text = cc.convert(text)
            except Exception:  # noqa: BLE001
                pass
        print(json.dumps({
            "ok": True,
            "text": text,
            "lang": getattr(info, "language", lang),
            "duration": round(float(getattr(info, "duration", 0) or 0), 1),
            "model": model_size,
        }, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
