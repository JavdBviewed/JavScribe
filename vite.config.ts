import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// web 形态构建：client/ui/index.html → client/dist
//  - root 取 client/ui（html 所在目录），index.html 落到产物根，
//    与 FastAPI StaticFiles(html=True) 挂载 / 的期望布局一致
//  - vendor（ffmpeg.wasm 资产 + favicon）经 publicDir 原样进产物根，
//    运行时路径 /lib/ffmpeg.js、/ffmpeg/ffmpeg-core.{js,wasm}、/favicon.png 保持不变
//  - 产物由 scripts/sync-static.mjs 镜像进 web/src/jav_scribe_web/static/（wheel/容器流程不变）
export default defineConfig({
  root: fileURLToPath(new URL("./client/ui", import.meta.url)),
  publicDir: fileURLToPath(new URL("./client/vendor", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./client/dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./client/ui/index.html", import.meta.url)),
    },
  },
});
