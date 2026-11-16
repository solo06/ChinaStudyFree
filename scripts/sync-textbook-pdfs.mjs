#!/usr/bin/env node
/**
 * sync-textbook-pdfs.mjs —— 把上游教材 PDF 镜像到本地，供离线维护与增量更新
 *
 * 上游：TapXWorld/ChinaTextbook（master，约 41.5 GB 全量，按「学段/学科/版本/册次.pdf」组织）
 *
 * 用法：
 *   node scripts/sync-textbook-pdfs.mjs --dry-run --scope 小学/英语        # 只列清单与总体积
 *   node scripts/sync-textbook-pdfs.mjs --scope 小学/英语                  # 实际下载（可续传）
 *   node scripts/sync-textbook-pdfs.mjs --scope 小学/英语 --only 一年级    # 只拉文件名含「一年级」的
 *
 * 参数：
 *   --scope <path>   仓库内相对路径，默认 小学/英语；可多次传，例如 --scope 小学/数学 --scope 小学/语文
 *   --out <dir>      落地目录，默认 data/textbook-pdfs
 *   --only <kw>      只处理路径里含该关键词的文件（可多次）
 *   --dry-run        只统计，不下载
 *   --jobs <n>       并发下载数，默认 3
 *   --force          忽略 manifest，全部重下（校验 sha256 时仍会记录）
 *
 * 需要 GitHub token 才能稳定跑（匿名 API 有速率限制）：GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT_* 任一。
 *
 * 落盘结构：<out>/<scope 原样路径>/...
 *   manifest.json 记录每个文件的相对路径、大小、sha256、来源 URL 与同步时间；
 *   下次运行时大小一致即跳过（--force 可强制）。
 *
 * 断点续传：raw.githubusercontent.com 经常中途断流，这里用 Range 续传 + 重试，并以
 * 「大小等于 API 报告的 size」+「文件末尾有 %%EOF」作为完成判据。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const REPO = process.env.TEXTBOOK_REPO || "TapXWorld/ChinaTextbook";
const BRANCH = process.env.TEXTBOOK_BRANCH || "master";
const TOKEN =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_PAT_FINE_GRAINED ||
  process.env.GITHUB_PAT_CLASSIC ||
  "";

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
function argValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${name}=`)) out.push(argv[i].slice(name.length + 1));
  }
  return out;
}
const flag = (name) => argv.includes(name);

const scopes = argValues("--scope");
if (scopes.length === 0) scopes.push("小学/英语");
const OUT = path.resolve(argValues("--out")[0] || "data/textbook-pdfs");
const ONLYS = argValues("--only");
const JOBS = Math.max(1, Math.min(8, Number(argValues("--jobs")[0] || 3)));
const DRY = flag("--dry-run");
const FORCE = flag("--force");

const apiHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "csf-textbook-sync",
  ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {}),
};

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

async function api(pathname) {
  const url = `https://api.github.com/repos/${REPO}/${pathname}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: apiHeaders });
    if (res.ok) return res.json();
    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000 - Date.now();
      const ms = wait > 0 && wait < 120_000 ? wait : 5_000 * attempt;
      console.warn(`  速率限制，${Math.round(ms / 1000)}s 后重试…`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`API ${res.status} ${pathname}`);
  }
  throw new Error(`API 重试失败 ${pathname}`);
}

/** 递归列出一个目录下的所有文件（只走 contents API，避免 tree API 被截断） */
async function walk(dir, acc = []) {
  const items = await api(`contents/${enc(dir)}?ref=${BRANCH}`);
  for (const it of items) {
    if (it.type === "dir") await walk(it.path, acc);
    else if (it.type === "file" && /\.pdf$/i.test(it.name)) {
      acc.push({ path: it.path, size: it.size, sha: it.sha, download_url: it.download_url });
    }
  }
  return acc;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function hasEofTail(file) {
  try {
    const st = await fsp.stat(file);
    const len = Math.min(2048, st.size);
    const fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    await fh.close();
    return buf.includes("%%EOF");
  } catch {
    return false;
  }
}

/** 断点续传下载：失败重试，直至大小匹配且尾部有 %%EOF */
async function download(file, url, size) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let lastErr = "";
  for (let attempt = 1; attempt <= 12; attempt++) {
    const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (have >= size && (await hasEofTail(file))) return;
    try {
      const headers = { "User-Agent": "csf-textbook-sync" };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const res = await fetch(url, { headers });
      if (res.status === 416) return; // 已经下完
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("收到 0 字节");
      const fh = await fsp.open(file, have > 0 && res.status === 206 ? "a" : "w");
      try {
        await fh.writeFile(buf);
      } finally {
        await fh.close();
      }
      const now = fs.statSync(file).size;
      if (now >= size && (await hasEofTail(file))) return;
      lastErr = `不完整 ${now}/${size}`;
    } catch (e) {
      lastErr = String(e?.message || e);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error(`下载失败（${lastErr}）`);
}

async function main() {
  console.log(`上游：${REPO}@${BRANCH}`);
  console.log(`范围：${scopes.join("、")}`);
  console.log(`落地：${OUT}${DRY ? "（dry-run，不下载）" : ""}`);
  if (!TOKEN) console.warn("⚠️ 未检测到 GitHub token，匿名 API 速率较低，建议设置 GITHUB_TOKEN");

  const all = [];
  for (const scope of scopes) {
    const files = await walk(scope);
    console.log(`  ${scope}: ${files.length} 个 PDF`);
    all.push(...files);
  }
  const picked = ONLYS.length ? all.filter((f) => ONLYS.some((k) => f.path.includes(k))) : all;
  const totalBytes = picked.reduce((s, f) => s + (f.size || 0), 0);
  console.log(`待处理：${picked.length} 个文件，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  if (DRY) {
    for (const f of picked.slice(0, 40)) {
      console.log(`  ${(f.size / 1024 / 1024).toFixed(1).padStart(7)} MB  ${f.path}`);
    }
    if (picked.length > 40) console.log(`  … 其余 ${picked.length - 40} 个`);
    return;
  }

  const manifestPath = path.join(OUT, "manifest.json");
  let manifest = { repo: REPO, branch: BRANCH, syncedAt: "", files: {} };
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch {
    /* 首次 */
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  async function handle(f) {
    const dest = path.join(OUT, f.path);
    const known = manifest.files[f.path];
    if (!FORCE && known && known.size === f.size && fs.existsSync(dest) && fs.statSync(dest).size === f.size) {
      skipped++;
      return;
    }
    try {
      process.stdout.write(`↓ ${f.path} (${(f.size / 1024 / 1024).toFixed(1)} MB) … `);
      await download(dest, f.download_url, f.size);
      const sha = await sha256File(dest);
      manifest.files[f.path] = {
        size: f.size,
        sha256: sha,
        source: f.download_url,
        syncedAt: new Date().toISOString(),
      };
      done++;
      console.log("ok");
    } catch (e) {
      failed++;
      failures.push({ path: f.path, error: String(e?.message || e) });
      console.log(`失败：${e?.message || e}`);
    }
  }

  const queue = picked.slice();
  await Promise.all(
    Array.from({ length: JOBS }, async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        await handle(f);
      }
    }),
  );

  manifest.syncedAt = new Date().toISOString();
  manifest.totalFiles = Object.keys(manifest.files).length;
  await fsp.mkdir(OUT, { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n完成：新增/更新 ${done}，跳过 ${skipped}，失败 ${failed}`);
  console.log(`清单：${manifestPath}`);
  if (failed) {
    for (const f of failures.slice(0, 10)) console.log(`  ✗ ${f.path} — ${f.error}`);
    process.exitCode = 1;
  }
}

await main();
