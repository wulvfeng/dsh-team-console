/**
 * dsh-team-console — 本地 Web 仪表盘（HTTP 服务）。
 *
 * 安全边界：
 *  - 只接受回环地址（127.0.0.1 / localhost / ::1），拒绝 0.0.0.0 等对外绑定；
 *  - 校验 Host 头，降低 DNS rebinding 风险；
 *  - 静态资源走白名单路由，不接受任意文件名；
 *  - sessionId 走白名单（字母数字 . _ -），拒绝路径穿越。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { defaultSessionsRoot, isSafeSessionId } from "./sessions.js";
import { buildTeamIndexAsync, buildTeamModel, buildTreeTeamModel, sessionTranscript } from "./team.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")).version || PKG_VERSION;
} catch {
  /* 版本号读取失败不影响服务 */
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const STATIC_ROUTES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEFAULT_PORT = 4318;
const DEFAULT_PORT_ATTEMPTS = 20;
const DEFAULT_MAX_AGE_DAYS = 14;

/** IPv6 回环判定：把 :: 展开成 8 段后要求等于 ::1（兼容全零写法 0:0:0:0:0:0:0:1）。 */
function isLoopbackIpv6(name) {
  if (!net.isIPv6(name)) return false;
  const halves = name.split("::");
  if (halves.length > 2) return false;
  const headParts = halves[0] ? halves[0].split(":") : [];
  const tailParts = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = 8 - headParts.length - tailParts.length;
  if (zeros < 0) return false;
  const parts = headParts.concat(new Array(zeros).fill("0"), tailParts);
  if (parts.length !== 8) return false;
  return parts.slice(0, 7).every((part) => /^0+$/.test(part)) && /^0*1$/.test(parts[7]);
}

/** 回环主机名判定（大小写不敏感，方括号 IPv6 自动剥离）。 */
function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  return isLoopbackIpv6(name);
}

/**
 * 严格解析 Host 头：只接受 host[:port]，IPv6 必须带方括号，端口必须是纯数字。
 * 格式不合法（含 127.0.0.1:9999evil 这类注入）返回 null。
 */
function parseHostHeader(headerValue) {
  if (typeof headerValue !== "string") return null;
  const raw = headerValue.trim();
  if (!raw) return null;
  let host = "";
  let port = "";
  if (raw.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:]+)\](?::([0-9]{1,5}))?$/.exec(raw);
    if (!match) return null;
    host = match[1];
    port = match[2] || "";
  } else {
    const match = /^([^:\[\]]+)(?::([0-9]{1,5}))?$/.exec(raw);
    if (!match) return null;
    host = match[1];
    port = match[2] || "";
  }
  if (port && Number(port) > 65535) return null;
  return { host: host.toLowerCase(), port };
}

/** Host 头必须存在且指向回环地址；缺失（HTTP/1.0）一律拒绝。 */
function hostHeaderAllowed(headerValue) {
  const parsed = parseHostHeader(headerValue);
  return Boolean(parsed) && isLoopbackHost(parsed.host);
}

/** 仅回环 Origin 允许跨源读取；https 也允许（面板可能通过 https 回环访问）。 */
function isLoopbackOrigin(origin) {
  if (typeof origin !== "string") return false;
  const raw = origin.trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "/" || url.search || url.hash) return false;
  if (raw.replace(/\/+$/, "").toLowerCase() !== url.origin.toLowerCase()) return false;
  return isLoopbackHost(url.hostname);
}

/**
 * 跨源许可：只对回环 Origin 回显，其它 Origin 不发送 ACAO（浏览器自会拦截读取）。
 * 无 Origin 的同源请求不需要 ACAO。vary: origin 让缓存按来源区分。
 */
function corsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : "";
  const headers = { vary: "origin" };
  if (!isLoopbackOrigin(origin)) return headers;
  return Object.assign(headers, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
}

/** 解析 accept-encoding 里 gzip 的 q 值：gzip;q=0 视为不接受。 */
function acceptsGzip(headerValue) {
  if (typeof headerValue !== "string") return false;
  const match = /(?:^|,)\s*gzip\s*(?:;\s*q\s*=\s*([0-9.]+))?/i.exec(headerValue);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const q = Number(match[1]);
  return Number.isFinite(q) && q > 0;
}

function sendJson(res, status, value, req) {
  const body = JSON.stringify(value);
  const request = req || (res && res.__req) || null;
  const accept = request && request.headers ? request.headers["accept-encoding"] : "";
  const gzipOk = acceptsGzip(accept);
  if (gzipOk && body.length > 4096) {
    const gzipped = zlib.gzipSync(Buffer.from(body, "utf8"));
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      ...corsHeaders(request),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": gzipped.length,
    });
    res.end(gzipped);
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(request),
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType, req) {
  const request = req || (res && res.__req) || null;
  res.writeHead(status, {
    "content-type": contentType || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(request),
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function serveStatic(res, name) {
  const file = path.resolve(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, "forbidden");
  fs.readFile(file, (error, buffer) => {
    if (error) return sendText(res, 404, "not found");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(buffer);
  });
}

/** 安全调用 logger（可能是任意桩对象），绝不让日志失败影响启动。 */
function warn(logger, message) {
  try {
    logger?.warn?.("[team-console] " + message);
  } catch {
    /* ignore */
  }
}

/** maxAgeDays 必须是有限正数，否则回退 14 天（NaN 会让时间过滤静默失效）。 */
function normalizeMaxAgeDays(value, logger) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (value !== undefined && value !== null) {
    warn(logger, "maxAgeDays 非法（" + String(value) + "），已回退 " + DEFAULT_MAX_AGE_DAYS + " 天");
  }
  return DEFAULT_MAX_AGE_DAYS;
}

/**
 * 端口归一化：数字必须是 0-65535 的整数（非法直接抛中文错误，便于调用方立刻发现）；
 * 其它类型（如 YAML 写成字符串 "4318"）回退默认端口，避免插件整体加载失败。
 */
function normalizePort(value, logger) {
  if (value === undefined || value === null) return DEFAULT_PORT;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error("team-console 端口必须是 0-65535 的整数，收到：" + String(value));
    }
    return value;
  }
  warn(logger, "port 类型非法（" + String(value) + "），已回退 " + DEFAULT_PORT);
  return DEFAULT_PORT;
}

/** 端口重试次数：0-100 的整数，默认 20。 */
function normalizePortAttempts(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_PORT_ATTEMPTS;
}

/**
 * sessionsRoot 校验：显式传入必须是非空字符串且是已存在目录（启动期失败优于运行期 500）；
 * 默认目录（%USERPROFILE%\.dsh\sessions）可能尚不存在，这种情况不报错、列表为空即可。
 */
function normalizeSessionsRoot(value) {
  if (value === undefined || value === null) return defaultSessionsRoot();
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("team-console 的 sessionsRoot 必须是非空字符串，收到：" + String(value));
  }
  const root = path.resolve(value.trim());
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error("team-console 的 sessionsRoot 不存在或无法访问：" + root);
  }
  if (!stat.isDirectory()) {
    throw new Error("team-console 的 sessionsRoot 不是目录：" + root);
  }
  return root;
}

/**
 * 启动仪表盘服务。
 * @param {{port?: number, host?: string, sessionsRoot?: string, maxAgeDays?: number, logger?: any, portAttempts?: number}} options
 * @returns {{port: number, url: string, ready: Promise<any>, close: Function}}
 */
export function startTeamConsole(options) {
  const opts = options || {};
  const logger = opts.logger;
  const sessionsRoot = normalizeSessionsRoot(opts.sessionsRoot);
  const host = opts.host ? String(opts.host) : "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("team-console 只允许绑定回环地址，收到：" + host);
  }
  const bindHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const maxAgeDays = normalizeMaxAgeDays(opts.maxAgeDays, logger);
  const basePort = normalizePort(opts.port, logger);
  const attempts = normalizePortAttempts(opts.portAttempts);

  let disposed = false;
  let resolved = false;
  let resolveReady = null;
  let rejectReady = null;
  const servers = [];
  const state = { port: basePort, url: "" };

  const handler = (req, res) => {
    res.__req = req;
    if (!hostHeaderAllowed(req.headers.host)) {
      return sendJson(res, 403, { error: "host not allowed" }, req);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const body = JSON.stringify({ error: "method not allowed", method: req.method });
      res.writeHead(405, Object.assign({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "allow": "GET, HEAD, OPTIONS",
        "content-length": Buffer.byteLength(body),
      }, corsHeaders(req)));
      res.end(body);
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://" + host);
    } catch {
      return sendJson(res, 400, { error: "bad url" }, req);
    }
    const pathname = url.pathname;
    try {
      if (STATIC_ROUTES[pathname]) return serveStatic(res, STATIC_ROUTES[pathname]);
      if (pathname === "/favicon.ico") return sendText(res, 204, "");
      if (pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, sessionsRoot, version: PKG_VERSION }, req);
      }
      if (pathname === "/api/teams") {
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        buildTeamIndexAsync({ sessionsRoot, maxAgeDays, includeArchived, archiveFile: opts.archiveFile })
          .then((teams) => {
            sendJson(res, 200, { sessionsRoot, teams, generatedAt: Date.now() }, req);
          })
          .catch((error) => {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) }, req);
          });
        return;
      }
      if (pathname === "/api/team") {
        const leadId = url.searchParams.get("lead") || "";
        if (!isSafeSessionId(leadId)) return sendJson(res, 400, { error: "invalid lead id" }, req);
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        let team = buildTeamModel({ sessionsRoot, leadId, archiveFile: opts.archiveFile });
        if (!team || !team.members || team.members.length === 0) {
          team = buildTreeTeamModel({ sessionsRoot, leadId, includeArchived, archiveFile: opts.archiveFile }) || team;
        }
        // 普通会话（既没有成员也没有任务）不是团队：两种模型都兜底为空时按 404 处理。
        const memberCount = team && Array.isArray(team.members) ? team.members.length : 0;
        const taskCount = team && Array.isArray(team.tasks) ? team.tasks.length : 0;
        if (!team || (memberCount === 0 && taskCount === 0)) {
          return sendJson(res, 404, { error: "team not found", leadId }, req);
        }
        return sendJson(res, 200, { team }, req);
      }
      if (pathname.indexOf("/api/session/") === 0) {
        let sessionId = "";
        try {
          sessionId = decodeURIComponent(pathname.slice("/api/session/".length));
        } catch {
          return sendJson(res, 400, { error: "bad session id" }, req);
        }
        if (!isSafeSessionId(sessionId)) return sendJson(res, 400, { error: "invalid session id" }, req);
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 200;
        const transcript = sessionTranscript({
          sessionsRoot,
          sessionId,
          limit: Math.max(1, Math.min(1000, limit)),
        });
        if (!transcript) return sendJson(res, 404, { error: "session not found", sessionId }, req);
        return sendJson(res, 200, { transcript }, req);
      }
      return sendJson(res, 404, { error: "not found", pathname }, req);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      try {
        opts.logger?.warn?.("[team-console] " + message);
      } catch {
        /* ignore */
      }
      return sendJson(res, 500, { error: message }, req);
    }
  };

  const tryListen = (port, remaining) => {
    if (disposed || resolved) return;
    const server = http.createServer(handler);
    servers.push(server);
    server.on("error", (error) => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (error && error.code === "EADDRINUSE" && remaining > 0 && !disposed && !resolved) {
        tryListen(port + 1, remaining - 1);
        return;
      }
      const message = error && error.message ? error.message : String(error);
      try {
        opts.logger?.error?.("[team-console] listen failed: " + message);
      } catch {
        /* ignore */
      }
      if (!resolved) {
        resolved = true;
        rejectReady(new Error("team-console 无法监听端口（起始 " + basePort + "）：" + message));
      }
    });
    server.listen(port, bindHost, () => {
      if (disposed) {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        return;
      }
      // port:0 由内核分配实际端口，必须以 server.address().port 为准，否则 url 不可访问。
      const address = server.address();
      const actualPort = address && typeof address === "object" && Number.isInteger(address.port) ? address.port : port;
      state.port = actualPort;
      state.url = "http://" + (bindHost === "::1" ? "[::1]" : bindHost) + ":" + actualPort + "/";
      try {
        opts.logger?.info?.("[team-console] dashboard at " + state.url);
      } catch {
        /* ignore */
      }
      if (!resolved) {
        resolved = true;
        resolveReady(handle);
      }
    });
  };

  const handle = {
    get port() {
      return state.port;
    },
    get url() {
      return state.url;
    },
    get ready() {
      return ready;
    },
    close() {
      disposed = true;
      for (const server of servers) {
        try {
          server.close();
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
      }
    },
  };

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error("team-console 启动超时：端口 " + basePort + " 起连续 " + (attempts + 1) + " 个端口均不可用"));
    }, 8000).unref?.();
  });

  tryListen(basePort, attempts);
  return handle;
}