import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// desktop 形态 renderer 构建：client/dist-desktop-src/index-desktop.html → client/dist-desktop
//  - root 取 client/（临时输入 html client/index-desktop.html 位于 root 下，
//    产物平铺在 dist 根；html 内 ../desktop-entry/main.ts 相对 html 位置解析不变）
//  - publicDir 关闭：ffmpeg.wasm 资产不进桌面端（提音轨由 main 进程系统 ffmpeg 承担）
//  - base: "./"：产物经 file:// 加载（Electron loadFile），资源走相对路径
//  - main.cjs / preload.cjs / package.json 由 scripts/build-desktop.mjs 在本步骤之后补齐
//    （vite emptyOutDir 会清空 outDir）
export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)),
  publicDir: false,
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./client/dist-desktop", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./client/index-desktop.html", import.meta.url)),
    },
  },
});
