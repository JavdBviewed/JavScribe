// e2e：mock GitHub Releases API（127.0.0.1:8303）
//  - GET /repos/JavdBviewed/JavScribe/releases?per_page=30 → 可配置数组（创建时间倒序）
//    默认 v0.1.0 + client-v0.1.0 = 当前版本 → 「无新版本」角标，现有 web 基线零影响
//  - POST /_mock/releases { app?: "v0.2.0"|null, client?: "client-v0.2.0"|null, body?: string }
//      字符串=切换该类 tag（其余字段沿用），null=删除该类 Release
//  - POST /_mock/reset → 恢复默认
import http from "node:http";

const PORT = Number(process.argv[2] || 8303);

const DEFAULTS = () => ({
  app: {
    tag_name: "v0.1.0",
    name: "v0.1.0",
    body: "JavScribe 首次发布",
    html_url: "https://github.com/JavdBviewed/JavScribe/releases/tag/v0.1.0",
    published_at: "2026-09-05T00:00:00Z",
  },
  client: {
    tag_name: "client-v0.1.0",
    name: "JavScribe Client v0.1.0",
    body: "桌面端首次发布",
    html_url: "https://github.com/JavdBviewed/JavScribe/releases/tag/client-v0.1.0",
    published_at: "2026-09-05T00:00:00Z",
  },
});

let state = DEFAULTS();

function releases() {
  return [state.client, state.app].filter(Boolean).map((x) => ({ ...x }));
}

function applyRelease(d) {
  for (const k of ["app", "client"]) {
    if (d[k] === undefined) continue;
    if (d[k] === null) { state[k] = null; continue; }
    const prefix = k === "client" ? "client-" : "";
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
    state = DEFAULTS();
    return send(200, { ok: true });
  }
  send(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-github] :${PORT}`));
