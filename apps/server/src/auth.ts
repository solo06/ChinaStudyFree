/**
 * auth.ts —— 密码哈希、JWT 签发/校验、会话 Cookie、登录限流
 *
 * 只依赖 Node 内置模块（crypto），保证 esbuild 打包后仍是零依赖单文件。
 *
 * 会话形态：
 *   - Web（同源）：httpOnly Cookie `csf_session`，SameSite=Lax，HTTPS 下加 Secure
 *   - 移动端（Capacitor / 原生 Android）：登录响应里同时返回 Bearer token，放 Authorization 头
 *   两者是同一个 JWT，校验逻辑一致。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { Request, Response, NextFunction } from "express";
import type { Store, User } from "./store.js";

export const SESSION_COOKIE = "csf_session";
const SESSION_TTL_SEC = 7 * 24 * 3600;
const SCRYPT_KEYLEN = 64;

// ---------------- 密码 ----------------

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  try {
    const got = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const want = Buffer.from(hash, "hex");
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ---------------- JWT（HS256，手写以避免引入依赖） ----------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface SessionPayload {
  sub: string;
  email: string;
  role: "user" | "admin";
  iat: number;
  exp: number;
}

export function signSession(user: User, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    iat: now,
    exp: now + SESSION_TTL_SEC,
  };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expect = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload?.sub || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------- Cookie ----------------

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function readToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  const cookie = req.header("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

// ---------------- 中间件 ----------------

export interface AuthedRequest extends Request {
  user?: User;
}

export function attachUser(store: Store, secret: string) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const token = readToken(req);
    if (token) {
      const payload = verifySession(token, secret);
      if (payload) {
        const user = store.findUserById(payload.sub);
        if (user && user.status === "active") req.user = user;
      }
    }
    next();
  };
}

export function requireUser(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ ok: false, error: "请先登录", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ ok: false, error: "请先登录", code: "AUTH_REQUIRED" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ ok: false, error: "需要管理员权限", code: "FORBIDDEN" });
    return;
  }
  next();
}

// ---------------- 简易限流（单进程内存） ----------------

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ---------------- 会话密钥 ----------------

export function resolveSecret(dataDir: string): string {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = `${dataDir}/auth.key`;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 首次启动 */
  }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
    console.log(`[auth] 已生成会话密钥 ${file}（可用 AUTH_SECRET 覆盖）`);
  } catch (e) {
    console.error("[auth] 写入 auth.key 失败，本次使用临时密钥：", e);
  }
  return generated;
}
