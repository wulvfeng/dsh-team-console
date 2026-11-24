#!/usr/bin/env node
/**
 * 把 dsh-team-console 装进一个 DSH profile（默认 desktop profile）。
 * - 备份 package.json / cordis.patch.yml
 * - 在 profile node_modules 下建立目录联接（junction），无需 pnpm
 * - 在 package.json dependencies 里登记 dsh-team-console
 * - 在 cordis.patch.yml 里插入 team-console 行（幂等）
 * 装完需重启 DSH（Host 插件在启动时加载）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const home = process.env.USERPROFILE || process.env.HOME || "";
const args = process.argv.slice(2);
const profileArgIndex = args.indexOf("--profile");
const profileDir = profileArgIndex !== -1
  ? path.resolve(args[profileArgIndex + 1])
  : path.join(home, ".dsh", "profiles", "desktop");
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, file + ".team-console-backup-" + stamp);
}

console.log("profile: " + profileDir);
console.log("package: " + packageRoot);

const pkgPath = path.join(profileDir, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("找不到 profile package.json：" + pkgPath);
  process.exit(1);
}

// 1. junction in node_modules
const nodeModules = path.join(profileDir, "node_modules");
fs.mkdirSync(nodeModules, { recursive: true });
const linkPath = path.join(nodeModules, "dsh-team-console");
try {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    console.log("移除已有链接：" + linkPath);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
} catch {
  /* ignore */
}
if (process.platform === "win32") {
  execFileSync("cmd", ["/c", "mklink", "/J", linkPath, packageRoot], { stdio: "inherit" });
} else {
  fs.symlinkSync(packageRoot, linkPath, "dir");
}

// 2. package.json dependency
backup(pkgPath);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies["dsh-team-console"] = "link:" + packageRoot.replace(/\\/g, "/");
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("已登记依赖 dsh-team-console");

// 3. cordis.patch.yml row
const patchPath = path.join(profileDir, "cordis.patch.yml");
let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "[]\n";
if (patch.indexOf("team-console") !== -1) {
  console.log("cordis.patch.yml 已有 team-console 行，跳过。");
} else {
  backup(patchPath);
  const row = [
    "- id: team-console",
    "  name: \"dsh-team-console\"",
    "  config:",
    "    port: 4318",
    ""
  ].join("\n");
  const trimmed = patch.replace(/\s*$/, "");
  patch = trimmed === "[]" ? row : trimmed + "\n" + row;
  fs.writeFileSync(patchPath, patch);
  console.log("已插入 cordis.patch.yml 插件行");
}

console.log("");
console.log("完成。重启 DSH 后，插件会在 Host 内启动：http://127.0.0.1:4318/");
console.log("也可以随时用 start.bat 单独启动，不依赖 DSH。");
