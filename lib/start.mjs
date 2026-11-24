#!/usr/bin/env node
/** 独立启动器：不依赖 DSH Host，直接跑仪表盘（便于验证或单独使用）。 */
import { spawn } from "node:child_process";
import http from "node:http";
import { startTeamConsole } from "./server.js";
import { defaultSessionsRoot } from "./sessions.js";

const args = process.argv.slice(2);
const portArg = args.find((item) => /^\d+$/.test(item));
const port = portArg ? Number(portArg) : 4318;
const shouldOpen = args.indexOf("--open") !== -1;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("[team-console] 端口必须是 0-65535 的整数，收到: " + (portArg || port));
  console.error("换一个端口重试，例如: node lib/start.mjs 4321");
  process.exit(1);
}

/**
 * 探测端口上是否已经有一个 team-console 在跑（可能是 DSH 主程序里的插件实例）。
 * 只有"连接被拒绝"(ECONNREFUSED) 才算端口空闲；其它错误/超时/非预期响应都按"被其它程序占用"处理。
 */
function probe(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data && data.ok) {
            finish({ ok: true, version: data.version, sessionsRoot: data.sessionsRoot });
            return;
          }
          finish({ ok: false, occupied: true });
        } catch {
          finish({ ok: false, occupied: true });
        }
      });
      res.on("error", () => finish({ ok: false, occupied: true }));
    });
    req.on("timeout", () => { req.destroy(); finish({ ok: false, occupied: true }); });
    req.on("error", (error) => {
      if (error && error.code === "ECONNREFUSED") {
        finish({ ok: false, free: true });
        return;
      }
      finish({ ok: false, occupied: true });
    });
  });
}

const existing = await probe(port);
if (existing.ok) {
  const url = "http://127.0.0.1:" + port + "/";
  console.log("[team-console] 端口 " + port + " 上已经有一个实例在跑（版本 " + existing.version + "），无需重复启动。");
  console.log("打开: " + url);
  console.log("提示: 如果这是 DSH 主程序里的插件实例，关掉插件的行即可；不要按端口去杀进程，会连带杀掉 DSH 本身。");
  if (shouldOpen) openBrowser(url);
  process.exit(0);
}
if (existing.occupied || existing.timeout) {
  console.error("[team-console] 端口 " + port + " 已被其它程序占用，且不是 team-console。");
  console.error("换一个端口重试，例如: node lib/start.mjs 4321");
  process.exit(2);
}

let ready;
try {
  const handle = startTeamConsole({ port });
  ready = await handle.ready;
} catch (error) {
  console.error("[team-console] 启动失败: " + (error && error.message ? error.message : error));
  console.error("换一个端口重试，例如: node lib/start.mjs 4321");
  process.exit(1);
}

if (!ready || !ready.url) {
  console.error("[team-console] 无法监听端口 " + port);
  process.exit(1);
}

let sessionsDir = "";
try {
  sessionsDir = defaultSessionsRoot();
} catch {
  sessionsDir = "（无法确定用户主目录，请用 sessionsRoot 显式配置）";
}

console.log("团队控制台: " + ready.url);
console.log("会话目录:  " + sessionsDir);
console.log("按 Ctrl+C 退出。");

if (shouldOpen) openBrowser(ready.url);

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* 打开浏览器失败不影响服务 */
  }
}
