// e2e：mock electron-updater 的 generic feed（127.0.0.1:8304）
//  - GET /latest.yml | /latest-linux.yml | /latest-mac.yml → 同一份 manifest（version 9.9.9 > 应用 0.1.0）
//    sha512 为下方假安装包的真值（electron-updater 下载后强校验，错一个字节就挂）
//  - GET /JavScribe-9.9.9.AppImage → 假安装包，分块慢速下发（64KB/25ms），
//    让 download-progress 事件可观测（UI 进度条有真实推进）
//  - POST /_mock/state → { requests: string[] }（记录请求路径，断言平台 manifest 名）
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 8304);
const FILE = "JavScribe-9.9.9.AppImage";
const VERSION = "9.9.9";

// 确定性假安装包：1.5MB（前 64KB 模式字节 + 余量零），任何机器生成结果一致
const SIZE = 1_572_864;
const CHUNK = 64 * 1024;
const head = Buffer.alloc(CHUNK);
for (let i = 0; i < CHUNK; i++) head[i] = (i * 7 + 13) & 0xff;
const fileBuf = Buffer.alloc(SIZE);
head.copy(fileBuf, 0);
const sha512 = crypto.createHash("sha512").update(fileBuf).digest("base64");

const MANIFEST = `version: ${VERSION}
files:
  - url: ${FILE}
    sha512: ${sha512}
    size: ${SIZE}
path: ${FILE}
sha512: ${sha512}
releaseDate: '2026-09-06T00:00:00.000Z'
releaseNotes: |
  e2e 测试内容
  - 更新功能自动化用例
`;

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
  if (req.method === "GET" && path === `/${FILE}`) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(SIZE),
    });
    let off = 0;
    const timer = setInterval(() => {
      res.write(fileBuf.subarray(off, off + CHUNK));
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

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-update-feed] :${PORT} sha512=${sha512.slice(0, 12)}…`));
