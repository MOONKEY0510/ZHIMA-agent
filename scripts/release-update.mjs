/**
 * ChatFloat 自动更新发布脚本
 *
 * 用法：
 *   node scripts/release-update.mjs              # 构建 + 签名 + 生成 latest.json
 *   node scripts/release-update.mjs --skip-build # 跳过构建，仅对已有安装包签名并生成清单
 *
 * 环境变量：
 *   TAURI_SIGNING_PRIVATE_KEY_PATH  签名私钥路径（默认自动探测 ~/.tauri）
 *   CHATFLOAT_UPDATE_BASE_URL       更新服务器静态目录地址，如
 *                                   https://example.com/chatfloat
 *                                   （不设置时产物 URL 为占位符，需手动替换）
 *   CHATFLOAT_DEPLOY_HOST           部署目标，如 admin@47.101.71.21。
 *                                   设置后脚本会把 release/updates/ 自动 scp 上传到
 *                                   CHATFLOAT_DEPLOY_PATH（默认 /var/www/chatfloat），
 *                                   并清理服务器上旧版本安装包。无需服务器密码（用密钥）。
 *   CHATFLOAT_DEPLOY_PATH           服务器静态目录，默认 /var/www/chatfloat
 *   CHATFLOAT_DEPLOY_KEY            SSH 私钥路径，默认 ~/.ssh/chatfloat_deploy
 *
 * 产物输出到 release/updates/，整目录上传到服务器即可：
 *   release/updates/
 *     ChatFloat_<version>_x64-setup.exe   安装包
 *     ChatFloat_<version>_x64-setup.exe.sig   minisign 签名
 *     latest.json                          更新清单（客户端拉取此文件判断更新）
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = conf.version;
const productName = conf.productName;

const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const outDir = join(root, "release", "updates");
const exeName = `${productName}_${version}_x64-setup.exe`;
const exePath = join(nsisDir, exeName);
const sigPath = `${exePath}.sig`;

const baseUrl = (
  process.env.CHATFLOAT_UPDATE_BASE_URL ||
  "https://zhima778.cloud/chatfloat"
)
  .trim()
  .replace(/\/+$/, "");

function resolveKeyPath() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  }
  const home = homedir();
  for (const candidate of [
    join(home, ".tauri"),
    join(home, ".tauri", `${productName}.key`),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function run(cmd, cwd, env = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

// 从 release/release-notes.txt 提取当前版本段的更新说明。
function extractNotes() {
  const notesPath = join(root, "release", "release-notes.txt");
  if (!existsSync(notesPath)) return "";
  const text = readFileSync(notesPath, "utf8");
  const start = text.indexOf(`v${version}`);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.search(/\nv\d+\.\d+\.\d+/);
  return next > 0 ? rest.slice(0, next).trim() : rest.trim();
}

const keyPath = resolveKeyPath();
if (!keyPath) {
  console.error(
    "未找到签名私钥。请先运行 `npx @tauri-apps/cli signer generate -w ~/.tauri`，",
    "或用环境变量 TAURI_SIGNING_PRIVATE_KEY_PATH 指定私钥路径。",
  );
  process.exit(1);
}
console.log(`签名私钥：${keyPath}`);

// 1. 构建安装包（构建过程会使用私钥生成 updater 签名产物）
if (!process.argv.includes("--skip-build")) {
  const privateKey = readFileSync(keyPath, "utf8").trim();
  run("npm run tauri:build", root, {
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  });
}

if (!existsSync(exePath)) {
  console.error(`未找到安装包：${exePath}\n请确认已成功构建，或使用 --skip-build 跳过构建。`);
  process.exit(1);
}

// 2. 始终重新签名，确保签名与当前安装包匹配。绝不信任可能已过期或与
//    安装包不匹配的旧签名（例如 --skip-build 复用了残留的 .sig）。
run(
  `npx @tauri-apps/cli signer sign -p "" -f "${keyPath}" "${exePath}"`,
  root,
);

// 3. 组装更新清单
const signature = readFileSync(sigPath, "utf8").trim();
const manifest = {
  version,
  notes: extractNotes() || undefined,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${baseUrl}/${exeName}`,
    },
  },
};

// 4. 复制产物到 release/updates/
mkdirSync(outDir, { recursive: true });
copyFileSync(exePath, join(outDir, exeName));
copyFileSync(sigPath, join(outDir, `${exeName}.sig`));
writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log("\n==========================================");
console.log(`更新包已生成：${outDir}`);
console.log(`版本：${version}`);
console.log(`服务器地址：${baseUrl}`);
console.log("==========================================\n");

// 5. 可选：自动部署到服务器（基于已配置的 SSH 密钥，无需密码）
const deployHost = process.env.CHATFLOAT_DEPLOY_HOST?.trim() || "";
if (deployHost) {
  const deployPath = (process.env.CHATFLOAT_DEPLOY_PATH || "/var/www/chatfloat").replace(/\/+$/, "");
  const deployKey =
    process.env.CHATFLOAT_DEPLOY_KEY ||
    join(homedir(), ".ssh", "chatfloat_deploy");
  const sigName = `${exeName}.sig`;

  console.log(`\n部署到 ${deployHost}:${deployPath}/ ...`);
  // 1) 确保远程目录存在
  run(`ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} "mkdir -p ${deployPath}"`);
  // 2) 上传到版本化暂存目录，避免中途失败破坏线上文件
  const staging = `${deployPath}/.staging-${version}`;
  run(
    `ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} ` +
      `"rm -rf ${staging} && mkdir -p ${staging}"`,
  );
  for (const f of [exeName, sigName, "latest.json"]) {
    run(`scp -i "${deployKey}" -o StrictHostKeyChecking=accept-new "${join(outDir, f)}" ${deployHost}:${staging}/`);
  }
  // 3) 校验暂存文件大小与本地一致，防止上传不完整
  const files = [exeName, sigName, "latest.json"];
  const localSizes = files.map((f) => statSync(join(outDir, f)).size);
  const remoteOut = execSync(
    `ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} ` +
      `"cd ${staging} && stat -c '%s %n' ${files.join(" ")}"`,
    { encoding: "utf8" },
  );
  const remoteSizes = new Map(
    remoteOut
      .trim()
      .split("\n")
      .map((line) => {
        const [size, name] = line.trim().split(/\s+/, 2);
        return [name, Number(size)];
      }),
  );
  for (let i = 0; i < files.length; i++) {
    if (remoteSizes.get(files[i]) !== localSizes[i]) {
      console.error(`校验失败：${files[i]} 大小不一致（本地 ${localSizes[i]}，远端 ${remoteSizes.get(files[i])}）`);
      process.exit(1);
    }
  }
  console.log("暂存文件大小校验通过。");
  // 4) 原子替换：先移入安装包与签名，最后发布 latest.json（客户端据此判断更新）
  run(
    `ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} ` +
      `"mv -f ${staging}/${exeName} ${staging}/${sigName} ${deployPath}/"`,
  );
  run(
    `ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} ` +
      `"mv -f ${staging}/latest.json ${deployPath}/latest.json"`,
  );
  // 5) 清理暂存目录（保留旧版本安装包以便回滚）
  run(`ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} "rm -rf ${staging}"`);
  // 6) 服务器内自检
  run(
    `ssh -i "${deployKey}" -o StrictHostKeyChecking=accept-new ${deployHost} ` +
      `"ls -lh ${deployPath} && curl -sI https://${new URL(baseUrl).host}${new URL(baseUrl).pathname}/latest.json | head -1"`,
  );
  console.log("\n部署完成。");
} else {
  console.log("\n提示：设置 CHATFLOAT_DEPLOY_HOST 可自动上传到服务器（如");
  console.log('  CHATFLOAT_DEPLOY_HOST=admin@47.101.71.21 node scripts/release-update.mjs');
  console.log("）。需要先配置好 SSH 免密登录（~/.ssh/chatfloat_deploy）。");
}
