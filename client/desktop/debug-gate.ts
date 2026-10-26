// 远程调试 token 门禁（0.2.62）
//
// 背景：--remote-debug 早期形态直接把 renderer CDP 与 main inspector 绑 0.0.0.0 无鉴权，
// 内网任意主机可附加调试（eval 主进程 / 读渲染层内存）。本模块在外部端口与内部真实端口之间
// 加一层纯 node:http 代理门禁：
//   - 内部真实端口：127.0.0.1:(base+offset) 确定性偏移（避免模块顶层异步取端口）
//   - 外部端口 0.0.0.0:base 只认 token：
//       HTTP 请求：x-debug-token 头 或 Authorization: Bearer <token>
//       WS upgrade：subprotocol `debug-token-<token>`（关键约束：Node 原生 WebSocket
//                   客户端只能发 subprotocol、不能发自定义请求头）或 x-debug-token 头
//   - 校验通过才代理/转发到内部端口；不通过一律 401
//
// 纯 node:crypto/http/net 实现，无 electron 依赖，可 node 单测。
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** WS subprotocol 前缀：客户端把 token 放 subprotocol（`debug-token-<token>`） */
export const TOKEN_PROTO_PREFIX = "debug-token-";

/** 随机 token：6 字节 hex（12 位），LAN 场景下足够抗猜测 */
export function makeDebugToken(): string {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * 确定性内部端口：base+offset；越界（>65535）时折回 1024..65535 区间。
 * 不用异步取空闲端口：main 模块顶层要在 app ready 前 appendSwitch，必须同步可用。
 */
export function internalPortFor(base: number, offset: number): number {
  let p = base + offset;
  if (p > 65535) p = ((p - 1024) % (65535 - 1024)) + 1024;
  if (p < 1) p = 1024;
  return p;
}

function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从请求提取候选 token：x-debug-token 头 > Bearer > WS subprotocol；无则 null */
function tokenFromRequest(req: IncomingMessage): string | null {
  const h = req.headers["x-debug-token"];
  if (typeof h === "string" && h.trim()) return h.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+\S+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }
  const proto = req.headers["sec-websocket-protocol"];
  const list = Array.isArray(proto) ? proto : typeof proto === "string" ? proto.split(",") : [];
  for (const p of list) {
    const t = (p || "").trim();
    if (t.startsWith(TOKEN_PROTO_PREFIX)) return t.slice(TOKEN_PROTO_PREFIX.length);
  }
  return null;
}

function isWsUpgrade(req: IncomingMessage): boolean {
  const up = req.headers["upgrade"];
  const conn = req.headers["connection"];
  if (typeof up !== "string" || up.toLowerCase() !== "websocket") return false;
  // connection: upgrade 缺失时按宽容处理（部分客户端不写）
  if (typeof conn === "string") return /upgrade/i.test(conn);
  return true;
}

function reject(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("debug token required");
}

export interface DebugGateOptions {
  /** 外部监听端口（用户可见端口，与 --remote-debug-port 一致） */
  port: number;
  /** 内部真实服务端口（127.0.0.1） */
  internalPort: number;
  /** 校验用 token；调用方保证非空且非 "none"（none 走旧裸口路径，不起门禁） */
  token: string;
  /** 监听地址，默认 0.0.0.0（LAN 可达）；单测可指 127.0.0.1 */
  host?: string;
  /** 日志回调（默认静默） */
  log?: (msg: string) => void;
}

export class DebugGate {
  private readonly opts: DebugGateOptions;
  private server: http.Server | null = null;
  /** 已建立的双向 pipe WS 对（客户端侧 + 上游侧）；close 时显式销毁 */
  private wsSockets = new Set<Duplex>();

  constructor(opts: DebugGateOptions) {
    this.opts = opts;
  }

  get port(): number {
    return this.opts.port;
  }

  /** 实际绑定端口（port=0 随机分配时可用）；未监听为 null */
  get boundPort(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  /** 起外部监听；重复调用忽略 */
  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, rejectFn) => {
      const server = http.createServer((req, res) => this.onHttp(req, res));
      server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
      server.on("error", (e) => {
        this.opts.log?.(`[debug-gate]:${this.opts.port} 监听失败: ${e.message}`);
        rejectFn(e);
      });
      server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        this.server = server;
        this.opts.log?.(`[debug-gate] :${this.opts.port} → 127.0.0.1:${this.opts.internalPort}（token 门禁生效）`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    // 已 upgrade 的 WS socket 不在 closeAllConnections 的回收范围（Node 对 upgraded
    // 连接只记账不处置），server.close() 会一直等它们 → 必须手动销毁
    for (const sock of this.wsSockets) sock.destroy();
    this.wsSockets.clear();
    s.closeAllConnections?.(); // 常规 keep-alive 长连接（HTTP 代理连接）
    return new Promise((resolve) => s.close(() => resolve()));
  }

  // ---------- HTTP 代理 ----------

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    if (isWsUpgrade(req)) {
      // 理论上 upgrade 走 upgrade 事件；兜底防呆
      reject(res);
      return;
    }
    const tok = tokenFromRequest(req);
    if (!tokenMatches(tok || "", this.opts.token)) {
      reject(res);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers["x-debug-token"];
    delete headers["authorization"];
    headers["host"] = `127.0.0.1:${this.opts.internalPort}`;
    const up = http.request(
      { host: "127.0.0.1", port: this.opts.internalPort, method: req.method, path: req.url, headers },
      (upRes) => {
        const ctype = String(upRes.headers["content-type"] || "");
        if (!ctype.includes("json")) {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
          return;
        }
        // JSON（CDP /json 等）：响应体里的 ws 地址指内部端口，远程客户端连不上
        // 且绕过门禁 → 缓冲后改写外部地址（见 rewriteJsonHost）
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          const buf = Buffer.from(this.rewriteJsonHost(Buffer.concat(chunks).toString("utf8"), req), "utf8");
          const headers: http.OutgoingHttpHeaders = { ...upRes.headers };
          // 已缓冲全量：改写后长度不定，framing 由门禁接管（显式 content-length，去 chunked）
          delete headers["transfer-encoding"];
          headers["content-length"] = String(buf.length);
          res.writeHead(upRes.statusCode || 502, headers);
          res.end(buf);
        });
        upRes.on("error", () => {
          if (!res.headersSent) res.end();
        });
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("debug upstream unavailable");
    });
    req.pipe(up);
  }

  /**
   * 上游 CDP/inspector 的 JSON 响应（webSocketDebuggerUrl / devtoolsFrontendUrl 的 ?ws= 串）
   * host:port 指内部端口 127.0.0.1:<internal>——远程客户端既连不上、直连还能绕过门禁。
   * 改写为客户端实际连入的外部地址（req.socket.localAddress 即对端路由到的本端接口），
   * 只替换 "127.0.0.1:<internalPort>" 字面量，其余原样。
   */
  private rewriteJsonHost(body: string, req: IncomingMessage): string {
    const from = `127.0.0.1:${this.opts.internalPort}`;
    let la = req.socket.localAddress;
    if (!la || la === "::") la = "127.0.0.1";
    const host = la.includes(":") ? `[${la}]` : la;
    const to = `${host}:${this.boundPort ?? this.opts.port}`;
    if (to === from) return body;
    return body.split(from).join(to);
  }

  // ---------- WS upgrade 代理（双向 pipe） ----------

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const tok = tokenFromRequest(req);
    if (!tokenMatches(tok || "", this.opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // 客户端请求的 subprotocol：101 响应必须回显（undici 严格遵循 RFC6455）
    const clientProto = req.headers["sec-websocket-protocol"];
    const protoEcho = Array.isArray(clientProto) ? clientProto.join(",") : clientProto;

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers["x-debug-token"];
    delete headers["authorization"];
    delete headers["sec-websocket-protocol"];
    headers["host"] = `127.0.0.1:${this.opts.internalPort}`;
    const up = http.request(
      { host: "127.0.0.1", port: this.opts.internalPort, method: req.method || "GET", path: req.url, headers },
    );
    up.on("upgrade", (upRes, upSocket, upHead) => {
      this.wsSockets.add(upSocket);
      const untrack = () => {
        this.wsSockets.delete(socket);
        this.wsSockets.delete(upSocket);
      };
      socket.on("close", untrack);
      upSocket.on("close", untrack);
      // 对端 FIN 后 socket 处于半开态（readable=false, writable=true）：
      // 不触发 close、双向拆链断在半路 → end 时显式销毁，保证连接对必然收敛
      socket.on("end", () => socket.destroy());
      upSocket.on("end", () => upSocket.destroy());
      // rawHeaders 是扁平 [key, value, key, value, ...] 数组，须按偶下标配对重建
      //（对字符串元素解构会拆出单字符 → 101 头损坏，undici 严格校验直接断连）
      const raw = upRes.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .map((k, i) => `${k}: ${upRes.rawHeaders[i * 2 + 1]}`)
        .join("\r\n");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${raw}` +
        (protoEcho ? `\r\nsec-websocket-protocol: ${protoEcho}` : "") +
        "\r\n\r\n",
      );
      if (upHead && upHead.length) upSocket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const dead = (a: Duplex, b: Duplex) => () => {
        a.destroy();
        b.destroy();
      };
      upSocket.on("error", dead(upSocket, socket));
      socket.on("error", dead(socket, upSocket));
      upSocket.on("close", () => socket.destroy());
      socket.on("close", () => upSocket.destroy());
    });
    up.on("error", () => socket.destroy());
    up.end();
  }
}
