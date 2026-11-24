#!/usr/bin/env node
/**
 * 把 dsh-team-console 装进一个 DSH profile（默认 desktop profile）。
 * 负责四件事（都可重复执行，幂等）：
 *   1. 在 profile node_modules 下建立目录联接（junction），无需 pnpm
 *   2. 在 profile package.json 的 dependencies 里登记 dsh-team-console（link: 本目录）
 *   3. 在 profile package.json 的 dsh.profile.bundles 里注册 dsh-team-console
 *      （DSH 只加载 bundles 里列出的组合包；少了这一步 patch 行不会生效）
 *   4. 在 cordis.patch.yml 里插入 team-console 行（按行匹配，幂等）
 *
 * 修改前会把 package.json / cordis.patch.yml 备份成 *.team-console-backup-<时间戳>；
 * 中途失败会尽量回滚本次新建的联接与改写的文件。装完需重启 DSH（Host 插件在启动时加载）。
 *
 * 用法：node install.mjs [--profile <profile 目录>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "dsh-team-console";
const PLUGIN_ID = "team-console";
/** 只认真正的插件行（行首 - id: team-console）；注释或别的插件名里出现 team-console 不算。 */
const PATCH_ROW_RE = /^\s*-\s*id:\s*team-console\s*$/m;
const USAGE = "用法: node install.mjs [--profile <profile 目录>]";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const done = [];
const undoStack = [];
let profileDir = "";
let pkgPath = "";
let patchPath = "";

function formatError(error) {
  if (!error) return "未知错误";
  return error && error.message ? error.message : String(error);
}

function printUsage() {
  console.error(USAGE);
}

/** 备份文件；文件不存在时返回 null（回滚时据此删除新建文件）。 */
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const target = file + ".team-console-backup-" + STAMP;
  fs.copyFileSync(file, target);
  return target;
}

/**
 * 原子写：先写同目录 .tmp- 临时文件，再 rename 覆盖。
 * Windows 上 rename 覆盖偶发 EEXIST/EPERM，退回直接写并说明。
 */
function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), ".tmp-" + path.basename(file) + "-" + process.pid + "-" + STAMP);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
    return;
  } catch (error) {
    const code = error && error.code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
    console.warn("（原子替换不可用：" + code + "，退回直接写入 " + path.basename(file) + "）");
  }
  try {
    fs.writeFileSync(file, content, "utf8");
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

const normalizePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function createLink(linkPath, target) {
  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "ignore" });
    } else {
      fs.symlinkSync(target, linkPath, "dir");
    }
  } catch (error) {
    throw new Error("建立目录联接失败：" + linkPath + " → " + target + "（" + formatError(error) + "）");
  }
}

/** 解析链接/目录联接的真实目标；Windows 上必须用 realpathSync.native，普通 realpathSync 不解析 junction。 */
function realPathOf(targetPath) {
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
    return real || null;
  } catch {
    return null;
  }
}

function sameLink(linkPath, target) {
  const real = realPathOf(linkPath);
  return real !== null && normalizePath(real) === normalizePath(target);
}

function rollback() {
  const failures = [];
  for (let i = undoStack.length - 1; i >= 0; i -= 1) {
    const step = undoStack[i];
    try {
      step.undo();
    } catch (error) {
      failures.push(step.label + "：" + formatError(error));
    }
  }
  return failures;
}

function parseArgs(argv) {
  let profileArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("--profile 缺少目录参数。");
        printUsage();
        process.exit(2);
      }
      profileArg = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    console.error("未知参数：" + arg);
    printUsage();
    process.exit(2);
  }
  return profileArg;
}

function main() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const profileArg = parseArgs(process.argv.slice(2));
  if (profileArg !== null) {
    profileDir = path.resolve(profileArg);
  } else {
    if (!home) {
      console.error("无法确定用户主目录（USERPROFILE / HOME 均为空），请用 --profile 指定 profile 目录。");
      printUsage();
      process.exit(1);
    }
    profileDir = path.join(home, ".dsh", "profiles", "desktop");
  }

  const profileStat = fs.statSync(profileDir, { throwIfNoEntry: false });
  if (!profileStat || !profileStat.isDirectory()) {
    console.error("profile 目录不存在或不是目录：" + profileDir);
    printUsage();
    process.exit(2);
  }

  pkgPath = path.join(profileDir, "package.json");
  patchPath = path.join(profileDir, "cordis.patch.yml");
  console.log("profile: " + profileDir);
  console.log("package: " + packageRoot);

  if (!fs.existsSync(pkgPath)) {
    throw new Error("找不到 profile package.json：" + pkgPath);
  }

  /* ---------- 1. 先完成所有读取 + 校验，再动文件系统 ---------- */
  const rawPkg = fs.readFileSync(pkgPath, "utf8");
  const hadBom = rawPkg.charCodeAt(0) === 0xfeff;
  const pkgText = hadBom ? rawPkg.slice(1) : rawPkg;
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    throw new Error(
      "profile package.json 不是合法 JSON（可能是 BOM/尾随逗号）：" + pkgPath + "\n  " + formatError(error)
    );
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("profile package.json 顶层必须是一个 JSON 对象：" + pkgPath);
  }

  const dependencies = pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)
    ? pkg.dependencies
    : {};
  const linkValue = "link:" + packageRoot.replace(/\\/g, "/");
  const dependencyChanged = dependencies[PACKAGE_NAME] !== linkValue;
  pkg.dependencies = dependencies;
  if (dependencyChanged) pkg.dependencies[PACKAGE_NAME] = linkValue;

  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" && !Array.isArray(pkg.dsh) ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" && !Array.isArray(pkg.dsh.profile)
    ? pkg.dsh.profile
    : {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const bundlesChanged = pkg.dsh.profile.bundles.indexOf(PACKAGE_NAME) === -1;
  if (bundlesChanged) pkg.dsh.profile.bundles.push(PACKAGE_NAME);

  const pkgChanged = dependencyChanged || bundlesChanged || hadBom;
  const nextPkgText = JSON.stringify(pkg, null, 2) + "\n";

  const patchExists = fs.existsSync(patchPath);
  const patchText = patchExists ? fs.readFileSync(patchPath, "utf8") : "[]\n";
  const hasPatchRow = PATCH_ROW_RE.test(patchText);
  let nextPatchText = null;
  if (!hasPatchRow) {
    const row = [
      "- id: " + PLUGIN_ID,
      '  name: "' + PACKAGE_NAME + '"',
      "  config:",
      "    port: 4318",
      ""
    ].join("\n");
    const trimmed = patchText.replace(/\s*$/, "");
    nextPatchText = trimmed === "" || trimmed === "[]" ? row : trimmed + "\n" + row;
  }

  /* ---------- 2. 走到这里才开始改文件系统（失败可回滚） ---------- */
  let replacedDirBackup = null;
  try {
    const nodeModules = path.join(profileDir, "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });
    const linkPath = path.join(nodeModules, PACKAGE_NAME);
    const existingLink = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (existingLink && sameLink(linkPath, packageRoot)) {
      console.log("node_modules 链接已存在且指向本目录，跳过。");
    } else {
      let replacedTarget = null;
      if (existingLink) {
        const real = realPathOf(linkPath);
        const isLink = real !== null && normalizePath(real) !== normalizePath(linkPath);
        if (isLink) {
          replacedTarget = real;
          console.log("移除已有链接：" + linkPath);
        } else {
          /* 已有真实目录（例如之前用 dsh plugin add github: 装的副本）：先确认是本插件再挪走，
             避免把用户放在同名目录里的其它内容整目录删掉。成功后删除备份，失败时回滚。 */
          let existingName = null;
          try {
            existingName = JSON.parse(fs.readFileSync(path.join(linkPath, "package.json"), "utf8")).name;
          } catch {
            existingName = null;
          }
          if (existingName !== PACKAGE_NAME) {
            throw new Error(
              "node_modules\\dsh-team-console 已存在且不是本插件的目录联接/安装副本，为避免误删请手工移除后重试：" + linkPath
            );
          }
          replacedDirBackup = linkPath + ".team-console-replaced-" + STAMP;
          fs.renameSync(linkPath, replacedDirBackup);
          console.log("已有安装副本，已移到备份：" + path.basename(replacedDirBackup));
        }
      }
      undoStack.push({
        label: "恢复 node_modules 链接",
        undo() {
          if (fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          if (replacedTarget) createLink(linkPath, replacedTarget);
          else if (replacedDirBackup && fs.existsSync(replacedDirBackup)) fs.renameSync(replacedDirBackup, linkPath);
        }
      });
      createLink(linkPath, packageRoot);
      done.push("建立 node_modules 目录联接");
      console.log("已建立 node_modules 目录联接 → " + packageRoot);
    }

    if (pkgChanged) {
      const pkgBackup = backup(pkgPath);
      writeAtomic(pkgPath, nextPkgText);
      undoStack.push({
        label: "恢复 package.json",
        undo() {
          if (pkgBackup) fs.copyFileSync(pkgBackup, pkgPath);
        }
      });
      if (dependencyChanged) {
        done.push("登记 dependencies.dsh-team-console");
        console.log("已登记依赖 dsh-team-console");
      }
      if (bundlesChanged) {
        done.push("注册 dsh.profile.bundles");
        console.log("已注册 dsh.profile.bundles");
      } else {
        console.log("dsh.profile.bundles 已包含 dsh-team-console，跳过。");
      }
      if (hadBom) {
        done.push("移除 package.json BOM");
        console.log("package.json 含 BOM，已重写为 UTF-8 无 BOM。");
      }
    } else {
      console.log("package.json 已包含依赖与 dsh.profile.bundles，跳过。");
    }

    if (hasPatchRow) {
      console.log("cordis.patch.yml 已有 team-console 行，跳过。");
    } else {
      const patchBackup = backup(patchPath);
      writeAtomic(patchPath, nextPatchText);
      undoStack.push({
        label: "恢复 cordis.patch.yml",
        undo() {
          if (patchBackup) fs.copyFileSync(patchBackup, patchPath);
          else fs.rmSync(patchPath, { force: true });
        }
      });
      done.push("插入 cordis.patch.yml 插件行");
      console.log("已插入 cordis.patch.yml 插件行");
    }

    if (replacedDirBackup) {
      try {
        fs.rmSync(replacedDirBackup, { recursive: true, force: true });
        console.log("已清理旧安装副本备份。");
      } catch {
        console.log("旧安装副本备份保留在：" + replacedDirBackup);
      }
    }
  } catch (error) {
    const rollbackFailures = rollback();
    console.error("");
    console.error("安装失败：" + formatError(error));
    console.error("本次已完成步骤（已尝试回滚）：" + (done.length === 0 ? " 无" : ""));
    done.forEach((step) => console.error("  - " + step));
    if (rollbackFailures.length > 0) {
      console.error("以下回滚步骤失败，请手工处理：");
      rollbackFailures.forEach((item) => console.error("  - " + item));
    }
    process.exit(1);
  }

  console.log("");
  console.log("完成。重启 DSH 后，插件会在 Host 内启动：http://127.0.0.1:4318/");
  console.log("也可以随时用 start.bat 单独启动，不依赖 DSH。");
}

try {
  main();
} catch (error) {
  console.error("");
  console.error("安装失败：" + formatError(error));
  process.exit(1);
}
