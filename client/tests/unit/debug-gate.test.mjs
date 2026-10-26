// client/desktop/debug-gate.ts 常驻单测（node 直接跑，esbuild 打包 TS 后断言，与 disk-split 套件同模式）
// 0.2.62：远程调试 token 门禁——HTTP 鉴权 / WS subprotocol 鉴权 / 代理转发 / 端口计算。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as http from "node:http";
import * as net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../desktop/debug-gate.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "dbg-gate-"));
try {
  const out = resolve(tmp, "gate.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { DebugGate, internalPortFor, makeDebugToken, TOKEN_PROTO_PREFIX } = mod.default ?? mod;

  // ---------- 纯函数：内部端口 / token ----------
  assert.equal(internalPortFor(9222, 4000), 13222, "常规偏移");
  assert.equal(internalPortFor(9222, 4001), 13223, "inspector 偏移");
  const big = internalPortFor(65000, 4000);
  assert.ok(big >= 1024 && big <= 65535, "越界折回合法区间");
  assert.notEqual(big, 65000, "内部端口不与外部端口撞");
  const t1 = makeDebugToken();
  const t2 = makeDebugToken();
  assert.match(t1, /^[0-9a-f]{12}$/, "12 位 hex");
  assert.notEqual(t1, t2, "随机不重复");
  assert.equal(TOKEN_PROTO_PREFIX, "debug-token-");
  console.log("ok 1 - internalPortFor / makeDebugToken");

  // ---------- 上游 mock（内部端口）：HTTP + WS upgrade ----------
  const wsHeadersSeen = [];
  let upPort = 0; // /json 路由在请求时引用（listen 后才有值）
  const upstream = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8" });
      res.end(
        JSON.stringify([
          {
            type: "page",
            url: "file:///app/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${upPort}/devtools/page/ABC`,
          },
        ]),
      );
    } else if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "MockChrome/134" }));
    } else if (req.url === "/needs-body") {
      httpSeenHeaders = req.headers;
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("echo:" + b);
      });
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nf");
    }
  });
  let httpSeenHeaders = null;
  upstream.on("upgrade", (req, socket) => {
    // 模拟真实上游：对端 FIN 后显式销毁，避免 upgraded 半开连接卡住 server.close()
    socket.on("end", () => socket.destroy());
    wsHeadersSeen.push(req.headers);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: mockaccept\r\n" +
      "\r\n",
    );
    socket.on("data", () => {
      // 回一帧未掩码 text 帧 "pong-hi"（server→client 不掩码）
      const payload = Buffer.from("pong-hi", "utf8");
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });
  const pickPort = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  upPort = await pickPort(upstream);

  const TOKEN = "gate-test-token";
  const gate = new DebugGate({ port: 0, internalPort: upPort, token: TOKEN, host: "127.0.0.1" });
  await gate.listen();
  const gp = gate.boundPort;
  assert.ok(gp > 0, "门禁外部端口已绑定");
  const base = `http://127.0.0.1:${gp}`;

  // ---------- HTTP 鉴权 ----------
  let r = await fetch(base + "/json/version");
  assert.equal(r.status, 401, "无 token → 401");
  r = await fetch(base + "/json/version", { headers: { "x-debug-token": "wrong" } });
  assert.equal(r.status, 401, "错误 token → 401");
  r = await fetch(base + "/json/version", { headers: { "x-debug-token": TOKEN } });
  assert.equal(r.status, 200, "x-debug-token 通过");
  assert.equal((await r.json()).Browser, "MockChrome/134", "响应体来自上游");
  r = await fetch(base + "/json/version", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200, "Bearer 通过");
  r = await fetch(base + "/json/version", { headers: { authorization: `Bearer wrong` } });
  assert.equal(r.status, 401, "Bearer 错误 → 401");
  r = await fetch(base + "/needs-body", { method: "POST", headers: { "x-debug-token": TOKEN }, body: "hello" });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "echo:hello", "POST body 透传");
  assert.equal(httpSeenHeaders["x-debug-token"], undefined, "token 头未泄漏到上游");
  assert.equal(httpSeenHeaders["authorization"], undefined, "鉴权头未泄漏到上游");
  // JSON 响应改写：上游 ws 地址指内部端口 → 门禁回给客户端的必须是外部端口（远程连门禁才通）
  r = await fetch(base + "/json", { headers: { "x-debug-token": TOKEN } });
  assert.equal(r.status, 200, "GET /json 通过");
  const jsonText = await r.text();
  assert.ok(!jsonText.includes(`127.0.0.1:${upPort}`), "内部端口不泄漏给外部客户端");
  assert.ok(jsonText.includes(`ws://127.0.0.1:${gp}/devtools/page/ABC`), "ws 地址改写为外部端口");
  assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(jsonText), "content-length 随改写同步");
  const targets = JSON.parse(jsonText);
  assert.equal(targets[0].url, "file:///app/index.html", "非地址字段原样");
  console.log("ok 2 - HTTP 401 / 双通道通过 / body 透传 / token 不泄漏 / JSON 地址改写");

  // ---------- WS upgrade 鉴权（raw socket 手工握手） ----------
  const wsHandshake = (withProto) =>
    new Promise((resolveP, rejectP) => {
      const s = net.connect(gp, "127.0.0.1");
      let buf = "";
      const onData = (d) => {
        buf += d.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx >= 0) {
          s.off("data", onData);
          resolveP({ head: buf.slice(0, idx), socket: s });
        }
      };
      s.on("data", onData);
      s.on("connect", () => {
        const lines = [
          "GET /devtools/page/XYZ HTTP/1.1",
          `host: 127.0.0.1:${gp}`,
          "upgrade: websocket",
          "connection: Upgrade",
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version: 13",
        ];
        if (withProto) lines.push(`sec-websocket-protocol: ${TOKEN_PROTO_PREFIX}${TOKEN}`);
        s.write(lines.join("\r\n") + "\r\n\r\n");
      });
      s.on("error", rejectP);
      setTimeout(() => rejectP(new Error("ws 握手超时")), 3000).unref();
    });

  let h = await wsHandshake(false);
  assert.match(h.head, /^HTTP\/1\.1 401/, "无 subprotocol/token → 401");
  h.socket.destroy();

  h = await wsHandshake(true);
  assert.match(h.head, /^HTTP\/1\.1 101/, "subprotocol token → 101");
  // undici 严格校验 101 必带 Upgrade/Connection/Accept：rawHeaders 重建错就断连（回归护栏）
  assert.match(h.head, /Upgrade: websocket/i, "101 带 Upgrade: websocket");
  assert.match(h.head, /Connection: [Uu]pgrade/, "101 带 Connection: Upgrade");
  assert.match(h.head, /Sec-WebSocket-Accept: \S+/, "101 带 Sec-WebSocket-Accept");
  assert.match(
    h.head,
    /sec-websocket-protocol:\s*debug-token-gate-test-token/i,
    "101 回显客户端请求的协议（undici 严格 RFC6455 依赖此）",
  );
  // 客户端发掩码 text 帧 "hi"（client→server 必须掩码）
  const payload = Buffer.from("hi", "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  h.socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  const respFrame = await new Promise((resolveP, rejectP) => {
    const t = setTimeout(() => rejectP(new Error("等上游帧超时")), 3000);
    h.socket.once("data", (d) => { clearTimeout(t); resolveP(d); });
    h.socket.once("error", rejectP);
  });
  assert.ok(respFrame.includes(Buffer.from("pong-hi")), "双向 pipe：客户端收到上游帧");
  const upSeen = wsHeadersSeen[wsHeadersSeen.length - 1];
  assert.equal(upSeen["x-debug-token"], undefined, "WS token 头未泄漏到上游");
  assert.equal(upSeen["sec-websocket-protocol"], undefined, "subprotocol 已剥离再转发内部端口");
  h.socket.destroy();
  console.log("ok 3 - WS 401 / 101 协议回显 / 双向 pipe / 头不泄漏");

  // ---------- 上游不可达 → 502 ----------
  const dead = http.createServer(() => {});
  const deadPort = await pickPort(dead);
  dead.close();
  const gate2 = new DebugGate({ port: 0, internalPort: deadPort, token: TOKEN, host: "127.0.0.1" });
  await gate2.listen();
  r = await fetch(`http://127.0.0.1:${gate2.boundPort}/x`, { headers: { "x-debug-token": TOKEN } });
  assert.equal(r.status, 502, "token 对但上游未监听 → 502");
  await gate2.close();
  console.log("ok 4 - 上游不可达 502");

  await gate.close();
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  await rm(tmp, { recursive: true, force: true });
  console.log("debug-gate.test 全部通过");
} catch (e) {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  throw e;
}
