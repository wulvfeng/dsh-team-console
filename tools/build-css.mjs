#!/usr/bin/env node
/**
 * 把 tmp-css.txt（唯一 CSS 源）分别注入两处消费方：
 *   1. lib/client.js    —— DSH 面板里的 CSS 常量
 *   2. public/style.css —— 独立网页版（补 :root 变量与 light-dark 调色板）
 *
 * 用法：node tools/build-css.mjs [--check]
 *   --check 只校验两侧是否与源一致，不写文件（审查用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CSS_SOURCE = path.join(ROOT, "tmp-css.txt");
const CLIENT = path.join(ROOT, "lib", "client.js");
const STANDALONE = path.join(ROOT, "public", "style.css");
const CSS_LINE_PREFIX = "    var CSS = ";

const VARS = [
  ':root{color-scheme:light dark;--dtc-bg:#f6f7fb;--dtc-card:#fff;--dtc-card2:#f4f6fa;--dtc-card3:#e9edf5;--dtc-edge:#e3e7ef;--dtc-edge2:#cbd3e1;--dtc-text:#0f172a;--dtc-dim:#48566b;--dtc-dim2:#63718a;--dtc-brand:#4f46e5;--dtc-ok:#047857;--dtc-warn:#b45309;--dtc-bad:#dc2626;--dtc-hover:rgba(15,23,42,.045);--dtc-active:rgba(79,70,229,.09);--dtc-r:14px;--dtc-r-sm:10px;--dtc-shadow-sm:0 1px 2px rgba(15,23,42,.05),0 1px 3px rgba(15,23,42,.04);--dtc-shadow-md:0 12px 28px -12px rgba(15,23,42,.18),0 4px 10px -4px rgba(15,23,42,.08);--dtc-shadow-glow:0 0 0 1px rgba(79,70,229,.18),0 10px 24px -12px rgba(79,70,229,.45);--dtc-mono:ui-monospace,SFMono-Regular,Consolas,"Cascadia Code",monospace}',
  ':root{--dtc-bg:light-dark(#f6f7fb,#0a0e14);--dtc-card:light-dark(#ffffff,#121820);--dtc-card2:light-dark(#f4f6fa,#18202b);--dtc-card3:light-dark(#e9edf5,#212b38);--dtc-edge:light-dark(#e3e7ef,#263040);--dtc-edge2:light-dark(#cbd3e1,#38445a);--dtc-text:light-dark(#0f172a,#e6edf5);--dtc-dim:light-dark(#48566b,#9aa7b8);--dtc-dim2:light-dark(#63718a,#7c8a9c);--dtc-brand:light-dark(#4f46e5,#7d8bff);--dtc-ok:light-dark(#047857,#34d399);--dtc-warn:light-dark(#b45309,#fbbf24);--dtc-bad:light-dark(#dc2626,#fb7185);--dtc-hover:light-dark(rgba(15,23,42,.045),rgba(255,255,255,.055));--dtc-active:light-dark(rgba(79,70,229,.09),rgba(125,139,255,.14));--dtc-shadow-sm:0 1px 2px light-dark(rgba(15,23,42,.05),rgba(0,0,0,.5)),0 1px 3px light-dark(rgba(15,23,42,.04),rgba(0,0,0,.42));--dtc-shadow-md:0 12px 28px -12px light-dark(rgba(15,23,42,.18),rgba(0,0,0,.66)),0 4px 10px -4px light-dark(rgba(15,23,42,.08),rgba(0,0,0,.5));--dtc-shadow-glow:0 0 0 1px color-mix(in oklab,var(--dtc-brand) 18%,transparent),0 10px 24px -12px color-mix(in oklab,var(--dtc-brand) 45%,transparent)}',
  "html,body{height:100%;margin:0;background:light-dark(#f6f7fb,#080b10)}"
].join("\n");

function standaloneCss(source) {
  const base = source.replace(/(\.dtc-root\{)([^}]*)(\})/, (match, open, body, close) => {
    const kept = body.split(";").filter((decl) => decl.trim() && decl.trim().indexOf("--dtc-") !== 0).join(";");
    return open + kept + close;
  });
  return VARS + "\n" + base + "\n";
}

function injectedClient(source) {
  const text = fs.readFileSync(CLIENT, "utf8");
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.indexOf(CSS_LINE_PREFIX) === 0);
  if (index === -1) throw new Error("lib/client.js 里找不到 CSS 常量定义行");
  lines[index] = CSS_LINE_PREFIX + JSON.stringify(source) + ";";
  return lines.join("\n");
}

export { VARS, standaloneCss, injectedClient };

function main() {
  const checkOnly = process.argv.includes("--check");
  const source = fs.readFileSync(CSS_SOURCE, "utf8");
  const nextClient = injectedClient(source);
  const nextStandalone = standaloneCss(source);
  const currentClient = fs.readFileSync(CLIENT, "utf8");
  const currentStandalone = fs.existsSync(STANDALONE) ? fs.readFileSync(STANDALONE, "utf8") : "";
  const clientFresh = currentClient === nextClient;
  const standaloneFresh = currentStandalone === nextStandalone;

  if (checkOnly) {
    console.log("lib/client.js    : " + (clientFresh ? "已同步" : "未同步"));
    console.log("public/style.css : " + (standaloneFresh ? "已同步" : "未同步"));
    process.exit(clientFresh && standaloneFresh ? 0 : 1);
  }

  if (!clientFresh) fs.writeFileSync(CLIENT, nextClient);
  if (!standaloneFresh) fs.writeFileSync(STANDALONE, nextStandalone);
  console.log("CSS 源        : " + CSS_SOURCE);
  console.log("lib/client.js : " + (clientFresh ? "无变化" : "已更新"));
  console.log("style.css     : " + (standaloneFresh ? "无变化" : "已更新"));
}

// 被 import 时（例如 tools/verify.mjs 的 EPERM 回退分支）不要执行 main。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
