// e2e：mock electron-updater 的 generic feed（127.0.0.1:8304）
//  - GET /latest.yml | /latest-linux.yml | /latest-mac.yml → 同一份 manifest（version 9.9.9 > 应用 0.1.0）
//    sha512 为下方假安装包的真值（electron-updater 下载后强校验，错一个字节就挂）
//  - GET /JavScribe-9.9.9.AppImage → 假 AppImage，分块慢速下发（64KB/25ms），
//    让 download-progress 事件可观测（UI 进度条有真实推进）
//  - GET /jav-scribe-client_9.9.9_amd64.deb → 假 deb（同上分块逻辑）。
//    linux-unpacked 多 target 构建后 resources/package-type 残留 "deb"，
//    electron-updater 据此选 DebUpdater 只认 .deb 条目，manifest 缺则 fileInfo undefined 崩溃。
//    真实 latest-linux.yml 本就同时含 AppImage+deb，这里对齐真实 feed。
//  - POST /_mock/state → { requests: string[] }（记录请求路径，断言平台 manifest 名）
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 8304);
const VERSION = "9.9.9";
const SIZE = 1_572_864;
const CHUNK = 64 * 1024;

// 确定性假安装包：1.5MB（前 64KB 模式字节 + 余量零），任何机器生成结果一致。
// 两个文件用不同模式字节，避免误用对方 buffer。
function makeFileBuf(pattern) {
  const head = Buffer.alloc(CHUNK);
  for (let i = 0; i < CHUNK; i++) head[i] = pattern(i);
  const buf = Buffer.alloc(SIZE);
  head.copy(buf, 0);
  return buf;
}

const APPIMAGE_FILE = "JavScribe-9.9.9.AppImage";
const DEB_FILE = `jav-scribe-client_${VERSION}_amd64.deb`;
const appimageBuf = makeFileBuf((i) => (i * 7 + 13) & 0xff);
const debBuf = makeFileBuf((i) => (i * 11 + 5) & 0xff);
const appimageSha = crypto.createHash("sha512").update(appimageBuf).digest("base64");
const debSha = crypto.createHash("sha512").update(debBuf).digest("base64");

const MANIFEST = `version: ${VERSION}
files:
  - url: ${APPIMAGE_FILE}
    sha512: ${appimageSha}
    size: ${SIZE}
  - url: ${DEB_FILE}
    sha512: ${debSha}
    size: ${SIZE}
path: ${APPIMAGE_FILE}
sha512: ${appimageSha}
releaseDate: '2026-09-06T00:00:00.000Z'
releaseNotes: |
  e2e 测试内容
  - 更新功能自动化用例
`;

const files = {
  [APPIMAGE_FILE]: appimageBuf,
  [DEB_FILE]: debBuf,
};

const requests = [];

const server = http.createServer((req, res) => {
  // electron-updater 拉 manifest 时带 ?noCache=xxx，必须按 pathname 匹配（裸 req.url 会让 $ 锚定 404）
  const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
  requests.push(req.url || "/");
  if (requests.length > 200) requests.shift();
  if (req.method === "GET" && /^\/latest(-linux|-mac)?\.yml$/.test(path)) {
    res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
    return res.end(MANIFEST);
  }
  const buf = files[path.slice(1)];
  if (req.method === "GET" && buf) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(SIZE),
    });
    let off = 0;
    const timer = setInterval(() => {
      res.write(buf.subarray(off, off + CHUNK));
      off += CHUNK;
      if (off >= SIZE) {
        clearInterval(timer);
        res.end();
      }
    }, 25);
    return;
  }
  if (req.method === "POST" && path === "/_mock/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ requests }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[mock-update-feed] :${PORT} appimageSha=${appimageSha.slice(0, 12)}… debSha=${debSha.slice(0, 12)}…`)
);
