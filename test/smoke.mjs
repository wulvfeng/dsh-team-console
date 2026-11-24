#!/usr/bin/env node
/**
 * test/smoke.mjs — dsh-team-console 自动化测试套件
 * 校验 build-css、verify.mjs、语法与关键核心组件渲染。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

console.log("=== 1. 运行 build-css 校验 ===");
execFileSync(process.execPath, [path.join(ROOT, "tools", "build-css.mjs"), "--check"], { stdio: "inherit" });

console.log("\n=== 2. 运行 tools/verify.mjs (41 项测试) ===");
execFileSync(process.execPath, [path.join(ROOT, "tools", "verify.mjs")], { stdio: "inherit" });

console.log("\n=== 3. 验证关键功能点 ===");
const clientCode = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
const appCode = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const cssCode = fs.readFileSync(path.join(ROOT, "tmp-css.txt"), "utf8");

const assertions = [
  { name: "CSS 包含驾驶舱中枢样式", ok: cssCode.includes(".dtc-cockpit") && cssCode.includes(".dtc-metricsGrid") },
  { name: "CSS 包含呼吸脉冲动画", ok: cssCode.includes("dtcRadar") && cssCode.includes("dtcBlink") },
  { name: "CSS 包含智能体名册拓扑卡片", ok: cssCode.includes(".dtc-fleetCard") && cssCode.includes(".dtc-fleetGrid") },
  { name: "面板端包含 CockpitView", ok: clientCode.includes("function CockpitView") },
  { name: "面板端包含 MissionCard 任务书", ok: clientCode.includes("function MissionCard") },
  { name: "独立端包含 renderOverview", ok: appCode.includes("function renderOverview") },
  { name: "独立端包含 renderMissionCard", ok: appCode.includes("function renderMissionCard") },
  { name: "双端均支持 __overview__ 模式", ok: clientCode.includes("__overview__") && appCode.includes("__overview__") },
];

let failed = 0;
assertions.forEach((a) => {
  if (a.ok) {
    console.log(`  PASS: ${a.name}`);
  } else {
    console.error(`  FAIL: ${a.name}`);
    failed += 1;
  }
});

if (failed > 0) {
  console.error(`\nSmoke 测试失败: ${failed} 项未通过`);
  process.exit(1);
} else {
  console.log(`\n全部 smoke 测试通过！`);
}
