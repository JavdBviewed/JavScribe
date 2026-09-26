// e2e：mock GitHub Releases API（127.0.0.1:8303）
//  - GET /repos/JavdBviewed/JavScribe/releases?per_page=30 → 可配置数组（创建时间倒序）
//    默认 serve-v{v} + client-v{v} = 当前版本 → 「无新版本」角标，基线零影响
//  - POST /_mock/releases { app?: "serve-v0.2.0"|null, client?: "client-v0.2.0"|null, body?: string }
//      字符串=切换该类 tag（其余字段沿用），null=删除该类 Release
//  - POST /_mock/reset → 恢复默认
import http from "node:http";

const PORT = Number(process.argv[2] || 8303);

// 默认 Release 版本 = 工作台当前版本（启动时向 /api/health 取；取不到回退 0.1.0）。
// 这样 web 版本 bump 后「同版本无角标」基线不用改测试。
const FALLBACK_VERSION = "0.1.0";
async function currentWebVersion() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8901/api/health", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        if (d && d.version) return d.version;
      }
    } catch (_e) { /* 工作台还没就绪，重试 */ }
    await new Promise((rs) => setTimeout(rs, 250));
  }
  console.warn("[mock-github] 取不到工作台版本，回退", FALLBACK_VERSION);
  return FALLBACK_VERSION;
}

const DEFAULTS = (v) => ({
  app: {
    tag_name: `serve-v${v}`,
    name: `serve-v${v}`,
    body: "JavScribe 首次发布",
    html_url: `https://github.com/JavdBviewed/JavScribe/releases/tag/serve-v${v}`,
    published_at: "2026-09-05T00:00:00Z",
  },
  client: {
    tag_name: `client-v${v}`,
    name: `JavScribe Client v${v}`,
    body: "桌面端首次发布",
    html_url: `https://github.com/JavdBviewed/JavScribe/releases/tag/client-v${v}`,
    published_at: "2026-09-05T00:00:00Z",
  },
});

let state = null;

function releases() {
  return [state.client, state.app].filter(Boolean).map((x) => ({ ...x }));
}

function applyRelease(d) {
  for (const k of ["app", "client"]) {
    if (d[k] === undefined) continue;
    if (d[k] === null) { state[k] = null; continue; }
    const prefix = k === "client" ? "client-" : "serve-";
    const tag = typeof d[k] === "string" ? d[k] : d[k].tag;
    state[k] = {
      ...(state[k] || {}),
      tag_name: tag,
      name: d[k].name || `${prefix}${tag}`,
      html_url: d[k].html_url || `https://github.com/JavdBviewed/JavScribe/releases/tag/${tag}`,
    };
    if (d.body !== undefined) state[k].body = d.body;
  }
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && req.url.startsWith("/repos/JavdBviewed/JavScribe/releases")) {
    return send(200, releases());
  }
  if (req.method === "POST" && req.url === "/_mock/releases") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let d = {};
      try { d = JSON.parse(body || "{}"); } catch { /* 非法 body 按空处理 */ }
      applyRelease(d);
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/_mock/reset") {
    state = DEFAULTS(stateVersion);
    return send(200, { ok: true });
  }
  send(404, { error: "not found" });
});

// 先确定当前版本再对外服务，避免「同版本」基线与默认 Release 竞态
// 版本优先取 playwright config 传入（argv[3]），独立运行时回退向 /api/health 取
const argvVersion = process.argv[3];
let stateVersion = argvVersion && /^\d+\.\d+\.\d+$/.test(argvVersion)
  ? argvVersion
  : await currentWebVersion();
state = DEFAULTS(stateVersion);
server.listen(PORT, "127.0.0.1", () => console.log(`[mock-github] :${PORT} (当前版本 v${stateVersion})`));
