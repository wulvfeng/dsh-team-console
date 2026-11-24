#!/usr/bin/env node
/**
 * 面板验收脚本（Lead 终审 / worker 自测 / reviewer 复跑）
 *
 * 检查项：
 *   1. node --check lib/client.js / public/app.js
 *   2. node tools/build-css.mjs --check（CSS 双端同步）
 *   3. 面板端（React 桩）：步骤标题说人话、方向 out/in、无 dangerouslySetInnerHTML、无 undefined
 *   4. 独立端（DOM 桩）：步骤标题说人话、XSS 输出已转义、无裸标签
 *   5. 两端步骤文案一致
 *   6. Markdown 双端渲染：块级/行内子集、链接白名单、原始 HTML 转义、表格、未闭合代码块
 *   7. Markdown 双端纯文本一致（含 13 组边界输入）
 *
 * 用法：node tools/verify.mjs    退出码 0 = 全通过
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

/* ---------- 1. 语法 ---------- */
for (const rel of ["lib/client.js", "public/app.js"]) {
  const full = path.join(ROOT, rel);
  const run = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
  if (run.error && run.error.code === "EPERM") {
    let ok = true;
    let msg = "";
    try {
      new Function(fs.readFileSync(full, "utf8"));
    } catch (e) {
      ok = false;
      msg = e && e.message ? e.message : String(e);
    }
    check("语法 " + rel, ok, msg);
  } else {
    check("语法 " + rel, run.status === 0, (run.stderr || "").split("\n")[0]);
  }
}

/* ---------- 2. CSS 双端同步 ---------- */
{
  const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-css.mjs"), "--check"], { encoding: "utf8" });
  if (run.error && run.error.code === "EPERM") {
    const cssSrc = fs.readFileSync(path.join(ROOT, "tmp-css.txt"), "utf8");
    const clientSrc = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
    const styleSrc = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
    const hasClientCss = clientSrc.indexOf("    var CSS = " + JSON.stringify(cssSrc) + ";") !== -1;
    const stripped = cssSrc.replace(/(\.dtc-root\{)([^}]*)(\})/, (m, o, b, c) =>
      o + b.split(";").filter((d) => d.trim() && d.trim().indexOf("--dtc-") !== 0).join(";") + c
    );
    const hasStyleCss = styleSrc.indexOf(stripped) !== -1;
    check("CSS 双端同步 (build-css --check)", hasClientCss && hasStyleCss, (hasClientCss ? "client:ok " : "client:stale ") + (hasStyleCss ? "style:ok" : "style:stale"));
  } else {
    check("CSS 双端同步 (build-css --check)", run.status === 0, (run.stdout || "").replace(/\n/g, " ").trim());
  }
}

/* ---------- 测试数据 ---------- */
const PAYLOAD = '<img src=x onerror="alert(1)">';
const SCRIPT = '"><script>alert(1)</script>';
const now = Date.now();
const T = (offset) => now + offset;

const member = {
  id: "m-1", name: PAYLOAD, description: "写文件", phase: "active",
  activity: { label: "空闲" }, steps: [], stepCount: 3, failedSteps: 0,
  assignment: { description: "写文件", prompt: "PROMPT-TEXT" + SCRIPT, replies: [{ text: "REPLY-TEXT", at: now }] }
};
const team = {
  leadId: "lead-1", title: "验收团队", cwd: "C:/tmp", agentPreset: "default",
  createdAt: T(-60000), model: "test-model",
  lead: { id: "lead-1", title: "验收团队", activity: { label: "活跃" }, taskIds: [] },
  members: [member], tasks: [], dispatches: [], generatedAt: now,
  requests: [{ turn: 1, title: "请求一" + SCRIPT, time: T(-50000), memberCount: 1, taskCount: 0, activeTaskCount: 0, memberIds: ["m-1"], taskIds: [] }]
};
const transcript = {
  sessionId: "m-1", label: PAYLOAD, model: "test-model", total: 6, activity: { label: "活跃" },
  items: [
    { id: "i1", kind: "user", time: T(-40000), text: "TASK-PROMPT " + PAYLOAD },
    { id: "i2", kind: "reasoning", time: T(-39000), text: "think " + PAYLOAD },
    { id: "i3", kind: "tool", time: T(-38000), resultTime: T(-36500), name: "pwsh", args: '{"command":"Get-Process -Name node"}', headline: PAYLOAD, result: "ok" },
    { id: "i4", kind: "tool", time: T(-36000), resultTime: T(-35500), name: "glob", args: '{"pattern":"**/*.ts","path":"src"}', headline: "src", result: "3 files" },
    { id: "i5", kind: "tool", time: T(-35000), resultTime: T(-34000), name: "write", args: '{"file_path":"C:/tmp/a.md","content":"x"}', headline: "C:/tmp/a.md", result: "written" },
    { id: "i6", kind: "assistant", time: T(-30000), text: "DONE " + PAYLOAD }
  ]
};
const HINT = /运行命令|查找文件|写文件|搜索内容|读文件|修改文件|执行脚本|发消息/;

/* ---------- 3. 面板端（React 桩） ---------- */
function renderClient() {
  let stateQueue = [];
  let stateIndex = 0;
  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => { if (Array.isArray(c)) c.forEach(push); else if (c !== null && c !== undefined && c !== false) flat.push(c); };
      children.forEach(push);
      return { type, props: Object.assign({}, props || {}, { children: flat }) };
    },
    useState(initial) {
      const v = stateIndex < stateQueue.length ? stateQueue[stateIndex] : (typeof initial === "function" ? initial() : initial);
      stateIndex += 1;
      return [v, () => {}];
    },
    useEffect() {},
    useRef(v) { return { current: v }; }
  };
  let loaded = null;
  new Function("window", "document", "fetch", "setInterval", "clearInterval", fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8"))(
    { __ModuleLoader__: { load(def) { loaded = def; } } },
    { querySelector() { return null; }, createElement() { return { setAttribute() {}, textContent: "" }; }, head: { appendChild() {} } },
    async () => { throw new Error("no-fetch"); }, () => 0, () => {}
  );
  const plugin = loaded.factory((name) => (name === "react" ? React : { IconUserOutlineRegular: () => null }));
  const regs = [];
  plugin.apply({ slots: { inject(n, f) { regs.push(f()); }, register(d, C) { return { definition: d, Component: C }; } } });
  const Page = regs.find((r) => r.definition.name === "main").Component;
  stateQueue = [{ ready: true, error: null, api: "http://127.0.0.1:4318", teams: [{ leadId: "lead-1", title: team.title, memberCount: 1, openTaskCount: 0, taskCount: 0 }], leadId: "lead-1", team, selected: "m-1", transcript, updatedAt: now }];
  stateIndex = 0;
  return Page();
}

function walk(node, acc) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, acc)); return acc; }
  if (typeof node.type === "function") { walk(node.type(node.props || {}), acc); return acc; }
  const props = node.props || {};
  if (typeof props.className === "string") acc.classes.push(props.className);
  if (props.dangerouslySetInnerHTML) acc.dangerous.push(true);
  if (typeof props.className === "string" && props.className.indexOf("dtc-stepItem") === 0) acc.stepNodes.push(node);
  walk(props.children, acc);
  return acc;
}
function text(node) {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return text(node.type(node.props || {}));
  return text(node.props && node.props.children);
}

const clientTree = renderClient();
const clientAcc = walk(clientTree, { classes: [], dangerous: [], stepNodes: [] });
const clientStepText = clientAcc.stepNodes.map(text).join(" || ");
check("面板端：无 dangerouslySetInnerHTML", clientAcc.dangerous.length === 0);
check("面板端：步骤 3 条", clientAcc.stepNodes.length === 3, "实际 " + clientAcc.stepNodes.length);
check("面板端：步骤文案是人话", HINT.test(clientStepText), clientStepText.slice(0, 140));
check("面板端：pwsh 用 command 作目标", /Get-Process/.test(clientStepText));
check("面板端：glob 用 pattern 作目标", /\*\*\/\*\.ts/.test(clientStepText), clientStepText.slice(0, 140));
check("面板端：chips 文案无 undefined", !/undefined/.test(clientStepText));
check("面板端：out/in 方向同时存在",
  clientAcc.classes.some((c) => c.indexOf("dtc-talk out") === 0) && clientAcc.classes.some((c) => c.indexOf("dtc-talk in") === 0));
check("面板端：①②③导读存在", text(clientTree).indexOf("①") !== -1 && text(clientTree).indexOf("③") !== -1);

/* ---------- 4. 独立端（DOM 桩） ---------- */
function renderStandalone() {
  const elements = new Map();
  const make = (id) => ({
    id, hidden: false, innerHTML: "", textContent: "", value: "", style: {},
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    getAttribute() { return null; }, setAttribute() {}, addEventListener() {}, dispatch() {},
    lastElementChild: null
  });
  const documentStub = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); },
    querySelector() { return null; }
  };
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/teams")) return { ok: true, json: async () => ({ teams: [{ leadId: "lead-1", title: team.title, memberCount: 1, openTaskCount: 0, taskCount: 0 }] }) };
    if (u.indexOf("/api/team?") !== -1) return { ok: true, json: async () => ({ team }) };
    if (u.indexOf("/api/session/") !== -1) return { ok: true, json: async () => ({ transcript }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  new Function("document", "location", "fetch", "setInterval", "clearInterval", fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8"))(
    documentStub, { hostname: "127.0.0.1", href: "http://127.0.0.1:4318/" }, fetchStub, () => 0, () => {}
  );
  return elements;
}

const elements = renderStandalone();
await new Promise((r) => setTimeout(r, 600));
const feedHtml = String((elements.get("feed") || {}).innerHTML || "");

check("独立端：有内容", feedHtml.length > 200, "长度 " + feedHtml.length);
check("独立端：XSS 已转义（含 &lt;img）", feedHtml.indexOf("&lt;img") !== -1);
check("独立端：无裸 <img", feedHtml.indexOf("<img") === -1);
check("独立端：无 <script", feedHtml.indexOf("<script") === -1);
check("独立端：onerror 未逃逸", feedHtml.indexOf("onerror=") === -1 || feedHtml.indexOf("&quot;") !== -1);
const stepHtmlMatches = [...feedHtml.matchAll(/<div class="dtc-stepTitle"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
const standaloneStepText = stepHtmlMatches.join(" || ");
check("独立端：步骤 3 条", stepHtmlMatches.length === 3, "实际 " + stepHtmlMatches.length);
check("独立端：步骤文案是人话", HINT.test(standaloneStepText), standaloneStepText.slice(0, 140));
check("独立端：glob 用 pattern 作目标", /\*\*\/\*\.ts/.test(standaloneStepText), standaloneStepText.slice(0, 140));
check("独立端：out/in 方向存在", feedHtml.indexOf("dtc-talk out") !== -1 && feedHtml.indexOf("dtc-talk in") !== -1);
check("独立端：①②③导读存在", String((elements.get("sectBar") || {}).innerHTML || "").indexOf("①") !== -1);

/* ---------- 5. 双端文案一致 ---------- */
const norm = (s) => s.replace(/\s+/g, "").replace(/[0-9.]+(ms|s)/g, "");
const clientNorm = norm(clientStepText);
const standaloneNorm = norm(standaloneStepText);
check("双端：步骤数量一致", (clientAcc.stepNodes.length === stepHtmlMatches.length));
check("双端：步骤目标一致（glob pattern 均在）", clientNorm.indexOf("**/*.ts") !== -1 && standaloneNorm.indexOf("**/*.ts") !== -1);


/* ---------- 6. 边界情况：映射覆盖 + 非法参数 ---------- */
const ORIGINAL_ITEMS = transcript.items.slice();
transcript.items = [{ id: "a0", kind: "assistant", time: T(-21000), text: "EDGE" },
  { id: "e1", kind: "tool", time: T(-20000), resultTime: T(-19800), name: "send_message", args: '{"agent":"lead","message":"hi"}', headline: "hi", result: "sent" },
  { id: "e2", kind: "tool", time: T(-19000), resultTime: T(-18800), name: "grep", args: '{"pattern":"TODO","path":"src"}', headline: "src", result: "2 hits" },
  { id: "e3", kind: "tool", time: T(-18000), resultTime: T(-17800), name: "edit", args: '{"file_path":"C:/tmp/b.md","old_string":"a","new_string":"b"}', headline: "C:/tmp/b.md", result: "ok" },
  { id: "e4", kind: "tool", time: T(-17000), resultTime: T(-16800), name: "mystery_tool", args: '{"foo":1}', headline: "", result: "ok" },
  { id: "e5", kind: "tool", time: T(-16000), resultTime: T(-15800), name: "pwsh", args: "not-json{{{", headline: "broken args", result: "ok" },
  { id: "e6", kind: "tool", time: T(-15000), resultTime: T(-14800), name: "read", args: undefined, headline: "", result: "ok" }
];

const edgeClient = renderClient();
const edgeClientAcc = walk(edgeClient, { classes: [], dangerous: [], stepNodes: [] });
const edgeClientText = edgeClientAcc.stepNodes.map(text).join(" || ");
check("边界：面板端步骤 6 条", edgeClientAcc.stepNodes.length === 6, "实际 " + edgeClientAcc.stepNodes.length);
check("边界：send_message → 发消息给 lead", /发消息给 lead/.test(edgeClientText), edgeClientText.slice(0, 200));
check("边界：grep → 搜索内容 · TODO", /搜索内容 · TODO/.test(edgeClientText));
check("边界：edit → 修改文件 · C:/tmp/b.md", /修改文件 · C:\/tmp\/b\.md/.test(edgeClientText));
check("边界：未知工具保留工具名 mystery_tool", /mystery_tool/.test(edgeClientText));
check("边界：非法 JSON 参数不崩且不显示 undefined", !/undefined/.test(edgeClientText), edgeClientText.slice(0, 200));
check("边界：read 无 args 不崩", edgeClientAcc.stepNodes.length === 6);

const edgeElements = renderStandalone();
await new Promise((r) => setTimeout(r, 600));
const edgeFeed = String((edgeElements.get("feed") || {}).innerHTML || "");
const edgeTitles = [...edgeFeed.matchAll(/<div class="dtc-stepTitle"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
const edgeStandaloneText = edgeTitles.join(" || ");
check("边界：独立端步骤 6 条", edgeTitles.length === 6, "实际 " + edgeTitles.length);
check("边界：独立端 发消息给 lead", /发消息给 lead/.test(edgeStandaloneText), edgeStandaloneText.slice(0, 200));
check("边界：独立端 搜索内容 · TODO", /搜索内容 · TODO/.test(edgeStandaloneText));
check("边界：独立端 无 undefined", !/undefined/.test(edgeStandaloneText));
check("边界：独立端有内容且长度合理", edgeFeed.length > 500, "长度 " + edgeFeed.length);


/* ---------- 7. P3 边界：emoji 截断 + POSIX 路径 ---------- */
const ORIGINAL_ITEMS2 = transcript.items.slice();
transcript.items = [
  { id: "p0", kind: "assistant", time: T(-21000), text: "P3" },
  // 让高代理项正好落在 oneLine(72) 的截断点上：71 个 a 之后切
  { id: "p1", kind: "tool", time: T(-20000), resultTime: T(-19800), name: "pwsh", args: JSON.stringify({ command: "a".repeat(70) + "\u{1F600}" + "zzzz" }), headline: "", result: "ok" },
  // POSIX 长路径（> 58 字符）不应被改写成反斜杠
  { id: "p2", kind: "tool", time: T(-19000), resultTime: T(-18800), name: "read", args: JSON.stringify({ file_path: "/home/user/project/src/subsystem/deep/file-name-very-long.md" }), headline: "", result: "ok" }
];

const safe = (s) => Array.from(String(s)).slice(0, 60).join("");
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const p3Client = renderClient();
const p3Acc = walk(p3Client, { classes: [], dangerous: [], stepNodes: [] });
const p3Text = p3Acc.stepNodes.map(text).join(" || ");
check("P3：面板端无孤立代理字符（emoji 截断安全）", !loneSurrogate.test(p3Text), JSON.stringify(safe(p3Text)));
check("P3：面板端无替换字符 U+FFFD", p3Text.indexOf("\uFFFD") === -1);
check("P3：面板端 POSIX 长路径保留正斜杠", p3Text.indexOf("file-name-very-long.md") !== -1 && !/\bhome\\/.test(p3Text), JSON.stringify(safe(p3Text.slice(-80))));

const p3Elements = renderStandalone();
await new Promise((r) => setTimeout(r, 600));
const p3Feed = String((p3Elements.get("feed") || {}).innerHTML || "");
const p3Titles = [...p3Feed.matchAll(/<div class="dtc-stepTitle"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
const p3Standalone = p3Titles.join(" || ");
check("P3：独立端无孤立代理字符", !loneSurrogate.test(p3Standalone), JSON.stringify(safe(p3Standalone)));
check("P3：独立端无 U+FFFD", p3Standalone.indexOf("\uFFFD") === -1);
check("P3：独立端 POSIX 长路径保留正斜杠", p3Standalone.indexOf("file-name-very-long.md") !== -1 && !/\bhome\\/.test(p3Standalone), JSON.stringify(safe(p3Standalone)));

transcript.items = ORIGINAL_ITEMS2;

/* ---------- 8. Markdown 双端渲染（同一套解析，两种序列化） ---------- */
const MD_TICK = String.fromCharCode(96);
const MD_FENCE = MD_TICK + MD_TICK + MD_TICK;
const MD_SAMPLE = [
  "## 走查结论",
  "",
  "第一行 **加粗** 与 " + MD_TICK + "inline code" + MD_TICK + "、*斜体*、~~删除~~ 和 [链接](https://example.com/a)。",
  "第二行带 <br> 标签应当转义。",
  "",
  "- 无序一",
  "- 无序二",
  "  - 嵌套项",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "> 引用一行",
  "",
  "---",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| a1 | b1 |",
  "| a2 | b2 |",
  "",
  "危险 [点我](javascript:alert(1)) 与 [相对](//evil.com/x)、[数据](data:text/html,<b>x</b>) 以及 <img src=x onerror=alert(1)>",
  "",
  "✓ 通过",
  "",
  MD_FENCE + "js",
  "const a = 1 < 2;",
  MD_FENCE,
  "",
  MD_FENCE,
  "未闭合代码块结尾"
].join("\n");

/* 在 React 桩树里找节点 / 收集 type */
function findNodes(node, pred, acc) {
  const out = acc || [];
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findNodes(n, pred, out)); return out; }
  if (typeof node.type === "function") { findNodes(node.type(node.props || {}), pred, out); return out; }
  if (pred(node)) out.push(node);
  if (node.props) findNodes(node.props.children, pred, out);
  return out;
}
function nodeTypes(node, acc) {
  const out = acc || [];
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => nodeTypes(n, out)); return out; }
  if (typeof node.type === "function") { nodeTypes(node.type(node.props || {}), out); return out; }
  out.push(node.type);
  if (node.props) nodeTypes(node.props.children, out);
  return out;
}
const hasClassToken = (className, token) => typeof className === "string" && className.split(/\s+/).indexOf(token) !== -1;
const mdBubbleNodes = (tree) => findNodes(tree, (n) => typeof n.type === "string" && hasClassToken((n.props || {}).className, "dtc-md"));

/* 从独立端 innerHTML 里按 <div> 配对切出每个气泡 */
function htmlBubbles(html) {
  const found = [];
  const open = /<div class="dtc-bubble[^"]*">/g;
  let m;
  while ((m = open.exec(html))) {
    const scan = /<div\b|<\/div>/g;
    scan.lastIndex = m.index;
    let depth = 0;
    let end = -1;
    let t;
    while ((t = scan.exec(html))) {
      if (t[0] === "</div>") { depth -= 1; if (depth === 0) { end = t.index + t[0].length; break; } }
      else depth += 1;
    }
    found.push({ cls: m[0], html: end === -1 ? html.slice(m.index) : html.slice(m.index, end) });
    open.lastIndex = end === -1 ? html.length : end;
  }
  return found;
}
const mdNorm = (s) => String(s).replace(/\s+/g, "");
function htmlPlain(chunk) {
  return chunk.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/* 两端解析器必须逐字一致（同一份代码复制到两个文件，任何漂移都会被这里抓住） */
{
  const extract = (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const a = src.indexOf("/* >>> md-parser");
    const b = src.indexOf("/* <<< md-parser */");
    return a === -1 || b === -1 ? null : src.slice(a, b).replace(/\r\n/g, "\n");
  };
  const left = extract("public/app.js");
  const right = extract("lib/client.js");
  check("MD 双端：解析器区块逐字一致", !!left && !!right && left === right);
}

/* 边界输入：两端纯文本必须一致，且都不抛异常、都不出现 undefined */
{
  const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const clientSrc = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
  const parserSrc = appSrc.slice(appSrc.indexOf("/* >>> md-parser"), appSrc.indexOf("/* <<< md-parser */"));
  const htmlSrc = appSrc.slice(appSrc.indexOf("/* >>> md-html"), appSrc.indexOf("/* <<< md-html */"));
  const reactSrc = clientSrc.slice(clientSrc.indexOf("/* >>> md-react"), clientSrc.indexOf("/* <<< md-react */"));
  function stubH(type, props) { return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }; }
  const htmlApi = new Function(parserSrc + htmlSrc + "\nreturn { formatRichText };")();
  const reactApi = new Function("h", parserSrc + reactSrc + "\nreturn { renderBubbleText };")(stubH);
  const treePlain = (node) => {
    if (node === null || node === undefined) return "";
    if (Array.isArray(node)) return node.map(treePlain).join("");
    if (typeof node === "string" || typeof node === "number") return String(node);
    return treePlain(node.children);
  };
  const FENCE = MD_FENCE;
  const edges = [
    "", "   \n\n \t \n", FENCE + "js\nconst a = 1;\n" + FENCE, "x".repeat(6000),
    FENCE + "\n没有结尾", "**没闭合的粗体", "第一段\n\n\n\n第二段", "###### 六级\n##### 五级\n#### 四级",
    "| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |", "---", "| a | b |\n| --- | --- |",
    "> > > 深", "- a\n  - b\n    - c\n- d", "[](https://a.com)", "[x](", "\\*不是斜体\\*",
    "__b__ 与 my__file 与 a__b__c 与 _i_"
  ];
  let broken = [];
  edges.forEach((input, idx) => {
    let htmlOut = "", treeOut = null;
    try { htmlOut = htmlApi.formatRichText(input); } catch (e) { broken.push("#" + idx + " html:" + e.message); return; }
    try { treeOut = reactApi.renderBubbleText(input); } catch (e) { broken.push("#" + idx + " react:" + e.message); return; }
    if (mdNorm(htmlPlain(htmlOut)) !== mdNorm(treePlain(treeOut))) broken.push("#" + idx + " 文本不一致");
    if (/undefined|NaN/.test(htmlOut) || /undefined|NaN/.test(JSON.stringify(treeOut))) broken.push("#" + idx + " undefined");
  });
  check("MD 双端：13+ 组边界输入不抛异常且纯文本一致", broken.length === 0, broken.slice(0, 4).join(" | "));

  /* Reviewer minor #1：__bold__ 必须渲染成粗体，词内双下划线不得被拆成斜体 */
  const strongSrc = "__b__ 与 my__file 与 __粗体__ 与 a__b__c 与 文件__名__后缀 与 变量__名__称";
  const strongHtml = htmlApi.formatRichText(strongSrc);
  const strongTree = reactApi.renderBubbleText(strongSrc);
  const strongTypes = [];
  (function collectStrong(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(collectStrong); return; }
    strongTypes.push(n.type);
    collectStrong(n.children);
  })(strongTree);
  check("MD 双端：__bold__ → 粗体（不是斜体残留，_i_ 仍是斜体）",
    strongHtml.indexOf("<b>b</b>") !== -1 && strongHtml.indexOf("<b>粗体</b>") !== -1 &&
    strongHtml.indexOf("_<i>") === -1 && strongTypes.indexOf("b") !== -1 &&
    htmlApi.formatRichText("_i_").indexOf("<i>i</i>") !== -1,
    JSON.stringify(strongHtml.slice(0, 110)));
  check("MD 双端：词内双下划线保持原样（含 CJK 侧翼 my__file / a__b__c / 文件__名__后缀 / 变量__名__称）",
    ["my__file", "a__b__c", "文件__名__后缀", "变量__名__称"].every((t) => strongHtml.indexOf(t) !== -1) &&
    strongHtml.indexOf("<i>") === -1 && strongHtml.indexOf("<b>名</b>") === -1 && strongTypes.indexOf("i") === -1,
    JSON.stringify(strongHtml.slice(0, 110)));
}

const MD_ORIGINAL_ITEMS = transcript.items.slice();
transcript.items = [
  { id: "md0", kind: "user", time: T(-20000), text: "请用 markdown 回答" },
  { id: "md1", kind: "assistant", time: T(-19000), text: MD_SAMPLE }
];

/* --- 面板端 --- */
const mdClientTree = renderClient();
const mdClientBubbles = mdBubbleNodes(mdClientTree);
const mdClientBubble = mdClientBubbles.length ? mdClientBubbles[mdClientBubbles.length - 1] : null;
const mdClientText = mdClientBubble ? text(mdClientBubble) : "";
const mdClientTypes = mdClientBubble ? nodeTypes(mdClientBubble) : [];
const mdClientLinks = mdClientBubble ? findNodes(mdClientBubble, (n) => n.type === "a") : [];

check("MD 面板端：标题 → h2", mdClientTypes.indexOf("h2") !== -1, "types=" + mdClientTypes.slice(0, 12).join(","));
check("MD 面板端：无序列表 → ul/li", mdClientTypes.indexOf("ul") !== -1 && mdClientTypes.indexOf("li") !== -1);
check("MD 面板端：有序列表 → ol/li", mdClientTypes.indexOf("ol") !== -1);
check("MD 面板端：段落内换行 → br", mdClientTypes.indexOf("br") !== -1);
check("MD 面板端：行内 code/b/i/del", ["code", "b", "i", "del"].every((t) => mdClientTypes.indexOf(t) !== -1));
check("MD 面板端：链接 href / target", mdClientLinks.some((n) => n.props.href === "https://example.com/a" && n.props.target === "_blank"));
check("MD 面板端：javascript: 链接降级为纯文本",
  mdClientLinks.every((n) => String(n.props.href || "").indexOf("javascript") === -1) && mdClientText.indexOf("[点我](javascript:alert(1))") !== -1,
  JSON.stringify(safe(mdClientText.slice(0, 60))));
check("MD 面板端：链接协议白名单（javascript: / // / data: 全降级）",
  mdClientLinks.every((n) => /^(https?:\/\/|mailto:|\/(?!\/|\\))/i.test(String(n.props.href || ""))) &&
  mdClientText.indexOf("//evil.com/x") !== -1 && mdClientText.indexOf("data:text/html") !== -1);
check("MD 面板端：原始 HTML 以文本呈现（无 img 元素）",
  mdClientText.indexOf("<img src=x onerror=alert(1)>") !== -1 && mdClientTypes.indexOf("img") === -1);
check("MD 面板端：管道表格 → table/th/td",
  ["table", "thead", "tbody", "th", "td"].every((t) => mdClientTypes.indexOf(t) !== -1) && mdClientText.indexOf("a1") !== -1);
check("MD 面板端：未闭合代码块不崩且无 undefined",
  mdClientTypes.indexOf("pre") !== -1 && mdClientText.indexOf("未闭合代码块结尾") !== -1 && !/undefined/.test(mdClientText));
check("MD 面板端：✓ 高亮 passMark", mdClientTypes.indexOf("span") !== -1 && findNodes(mdClientBubble, (n) => n.props && n.props.className === "dtc-passMark").length > 0);

/* --- 独立端 --- */
const mdElements = renderStandalone();
await new Promise((r) => setTimeout(r, 600));
const mdFeed = String((mdElements.get("feed") || {}).innerHTML || "");
const mdBubbleList = htmlBubbles(mdFeed).filter((b) => b.cls.indexOf("dtc-md") !== -1);
const mdHtml = mdBubbleList.length ? mdBubbleList[mdBubbleList.length - 1].html : "";

check("MD 独立端：标题 → h2", mdHtml.indexOf("<h2>走查结论</h2>") !== -1);
check("MD 独立端：无序列表 → ul/li", /<ul><li>无序一<\/li><li>无序二/.test(mdHtml) && mdHtml.indexOf("<li>嵌套项</li>") !== -1);
check("MD 独立端：有序列表 → ol/li", /<ol><li>有序一<\/li><li>有序二<\/li><\/ol>/.test(mdHtml));
check("MD 独立端：段落内换行 → br", /<br>第二行带 &lt;br&gt; 标签/.test(mdHtml));
check("MD 独立端：行内码/粗体/斜体/删除线",
  mdHtml.indexOf('<code class="dtc-inlineCode">inline code</code>') !== -1 &&
  mdHtml.indexOf("<b>加粗</b>") !== -1 && mdHtml.indexOf("<i>斜体</i>") !== -1 && mdHtml.indexOf("<del>删除</del>") !== -1);
check("MD 独立端：链接渲染",
  mdHtml.indexOf('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">链接</a>') !== -1);
check("MD 独立端：javascript: 链接降级为纯文本",
  mdHtml.indexOf('href="javascript') === -1 && mdHtml.indexOf("[点我](javascript:alert(1))") !== -1);
check("MD 独立端：链接协议白名单（javascript: / // / data: 全降级）",
  !/ href="(?:javascript|data|vbscript):/i.test(mdHtml) && mdHtml.indexOf(' href="//') === -1 && mdHtml.indexOf("//evil.com/x") !== -1);
check("MD 独立端：原始 HTML 已转义",
  mdHtml.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1 && mdHtml.indexOf("<img") === -1);
check("MD 独立端：管道表格 → table/thead/th/td",
  mdHtml.indexOf("<table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>a1</td><td>b1</td></tr>") !== -1);
check("MD 独立端：代码块复用 dtc-codeBlock",
  mdHtml.indexOf('<pre class="dtc-codeBlock"><code class="language-js">const a = 1 &lt; 2;</code></pre>') !== -1);
check("MD 独立端：未闭合代码块不崩且无 undefined",
  mdHtml.indexOf("未闭合代码块结尾") !== -1 && mdHtml.indexOf("undefined") === -1);
check("MD 独立端：✓ 高亮 passMark", mdHtml.indexOf('<span class="dtc-passMark">✓</span>') !== -1);

/* --- 双端纯文本一致 --- */
check("MD 双端：同一段 markdown 的纯文本一致", mdNorm(htmlPlain(mdHtml)) === mdNorm(mdClientText),
  JSON.stringify(mdNorm(htmlPlain(mdHtml)).slice(0, 60)) + " vs " + JSON.stringify(mdNorm(mdClientText).slice(0, 60)));

transcript.items = MD_ORIGINAL_ITEMS;

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("共 " + results.length + " 项，" + (results.length - failed.length) + " 通过，" + failed.length + " 失败");
if (failed.length) { failed.forEach((r) => console.log("  FAIL: " + r.name + (r.detail ? "  [" + r.detail + "]" : ""))); }
process.exit(failed.length === 0 ? 0 : 1);