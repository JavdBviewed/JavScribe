/* 浏览器本地提音轨（ffmpeg.wasm）：与服务端完全相同的参数
 * （16kHz 单声道 opus @32kbps，见 audio.py 的 audio_args）。
 * 暴露 window.JavExtract：
 *   extractAudio(file, { onProgress }) -> Promise<Blob | { skipped: true }>
 *     - 超过 MAX_BYTES 或空文件返回 { skipped: true }，由调用方决定回退
 *     - onProgress(p)：0..1，节流至 ~100 次
 *   MAX_BYTES：wasm 线性内存上限 ~2GB，1.6GB 是含中间数据的安全上限
 * 串行队列：批量时一次只跑一个文件，避免 wasm 内存叠加。
 */
(function () {
  "use strict";
  var MAX_BYTES =
    window.JAV_EXTRACT_MAX_BYTES != null
      ? Number(window.JAV_EXTRACT_MAX_BYTES)
      : Math.floor(1.6 * 1024 * 1024 * 1024);
  var inst = null;
  var loading = null;
  var queue = Promise.resolve();

  function ensure() {
    if (inst && inst.loaded) return Promise.resolve(inst);
    if (!loading) {
      var F = window.FFmpegWASM;
      if (!F || !F.FFmpeg) {
        return Promise.reject(new Error("ffmpeg.wasm 未加载"));
      }
      var f = new F.FFmpeg();
      loading = f
        .load({
          // 不传 classWorkerURL：wrapper 按 /lib/ffmpeg.js 位置自动定位 worker chunk；
          // core/wasm 必须用绝对路径——importScripts 在 worker 内按 worker 自身 URL 解析
          coreURL: "/ffmpeg/ffmpeg-core.js",
          wasmURL: "/ffmpeg/ffmpeg-core.wasm",
        })
        .then(function () {
          inst = f;
          return f;
        })
        .catch(function (e) {
          loading = null;
          throw e;
        });
    }
    return loading;
  }

  function runOne(f, onProgress) {
    return ensure().then(function (ff) {
      var ext = /\.([a-z0-9]{1,8})$/i.exec(f.name);
      var inName = "in" + (ext ? "." + ext[1].toLowerCase() : ".bin");
      var outName = "out.opus";
      var last = -1;
      var handler = function (ev) {
        var p = ev && typeof ev.progress === "number" ? ev.progress : 0;
        p = Math.max(0, Math.min(1, p));
        if (onProgress && (p - last >= 0.01 || p >= 1)) {
          last = p;
          onProgress(p);
        }
      };
      function cleanup() {
        ff.off("progress", handler);
        // 释放 wasm 内存，供批量下一个文件使用
        ff.deleteFile(inName).catch(function () {});
        ff.deleteFile(outName).catch(function () {});
      }
      ff.on("progress", handler);
      return ff
        .deleteFile(outName)
        .catch(function () {})
        .then(function () { return f.arrayBuffer(); })
        .then(function (buf) { return ff.writeFile(inName, new Uint8Array(buf)); })
        .then(function () {
          // 与服务端 audio_args 完全一致
          return ff.exec([
            "-i", inName,
            "-vn", "-c:a", "libopus", "-ar", "16000", "-ac", "1",
            "-b:a", "32k",
            outName,
          ]);
        })
        .then(function (rc) {
          if (rc !== 0) throw new Error("ffmpeg 本地提取失败（退出码 " + rc + "）");
          return ff.readFile(outName);
        })
        .then(function (data) {
          var blob = new Blob([data.buffer], { type: "audio/ogg" });
          cleanup();
          return blob;
        })
        .catch(function (e) {
          cleanup();
          throw e;
        });
    });
  }

  function extractAudio(f, opts) {
    if (!f) return Promise.reject(new Error("没有文件"));
    if (f.size <= 0) return Promise.resolve({ skipped: true });
    if (f.size > MAX_BYTES) return Promise.resolve({ skipped: true });
    var onProgress = opts && opts.onProgress;
    var prev = queue;
    var release;
    queue = new Promise(function (r) { release = r; });
    return prev
      .then(function () { return runOne(f, onProgress); })
      .finally(function () { release(); });
  }

  window.JavExtract = {
    extractAudio: extractAudio,
    MAX_BYTES: MAX_BYTES,
    fits: function (f) { return !!f && f.size > 0 && f.size <= MAX_BYTES; },
  };
})();
