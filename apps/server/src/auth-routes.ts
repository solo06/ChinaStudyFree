/**
 * auth-routes.ts —— 账号 / 会话 / 管理后台接口
 *
 * 路由分组：
 *   公开：POST /api/auth/register  POST /api/auth/login   GET /api/auth/config
 *   登录：GET  /api/auth/me        POST /api/auth/logout   POST /api/auth/password
 *   管理：GET  /api/admin/users    POST /api/admin/users   PATCH /api/admin/users/:id
 *          GET  /api/admin/settings PUT /api/admin/settings GET /api/admin/audit
 *
 * 设计约定：
 *   - 用 SQLite 之外最轻的 JSON 存储（见 store.ts），写操作串行、原子落盘
 *   - 登录/注册按 IP 限流；密码错误统一文案，避免枚举账号
 *   - 关闭注册后 register 返回 403，只能管理员开号
 */

import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  attachUser,
  clearSessionCookie,
  clientIp,
  hashPassword,
  rateLimit,
  requireAdmin,
  requireUser,
  setSessionCookie,
  signSession,
  verifyPassword,
  type AuthedRequest,
} from "./auth.js";
import { publicUser, type Store, type User, type UserFlags } from "./store.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function bad(res: Response, status: number, error: string, code?: string) {
  res.status(status).json({ ok: false, error, code });
}

function defaultFlags(): UserFlags {
  return { aiEnabled: true, aiDailyQuota: 0, shopEnabled: true };
}

function sanitizeFlags(input: unknown, base: UserFlags): UserFlags {
  const out = { ...base };
  if (input && typeof input === "object") {
    const f = input as Partial<UserFlags>;
    if (typeof f.aiEnabled === "boolean") out.aiEnabled = f.aiEnabled;
    if (typeof f.shopEnabled === "boolean") out.shopEnabled = f.shopEnabled;
    if (typeof f.aiDailyQuota === "number" && f.aiDailyQuota >= 0) {
      out.aiDailyQuota = Math.min(Math.floor(f.aiDailyQuota), 100000);
    }
  }
  return out;
}

export interface AuthRoutesOptions {
  store: Store;
  secret: string;
  log: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export function registerAuthRoutes(app: Express, opts: AuthRoutesOptions): void {
  const { store, secret, log } = opts;

  // Express 4 不接 async 路由的 rejection：统一包一层，异常落日志并回 500，避免请求悬挂
  const safe =
    (fn: (req: AuthedRequest, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response): void => {
      Promise.resolve(fn(req as AuthedRequest, res)).catch((err: unknown) => {
        log("error", "账号接口异常", { err: String((err as Error)?.stack || err) });
        if (!res.headersSent) bad(res, 500, "服务器内部错误", "INTERNAL");
      });
    };

  app.use("/api/auth", attachUser(store, secret));
  app.use("/api/admin", attachUser(store, secret));

  // ---------- 公开：站点配置（登录页需要知道能不能自助注册） ----------
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    const s = store.read().settings;
    res.json({ ok: true, registrationOpen: s.registrationOpen, siteName: s.siteName });
  });

  // ---------- 注册 ----------
  app.post("/api/auth/register", safe(async (req, res) => {
    if (!rateLimit(`reg:${clientIp(req)}`, 5, 60_000)) {
      return bad(res, 429, "请求过于频繁，请稍后再试", "RATE_LIMITED");
    }
    const { email, password, name } = (req.body || {}) as {
      email?: string;
      password?: string;
      name?: string;
    };
    const mail = (email || "").trim();
    if (!EMAIL_RE.test(mail)) return bad(res, 400, "邮箱格式不正确", "EMAIL_INVALID");
    if (!password || password.length < MIN_PASSWORD) {
      return bad(res, 400, `密码至少 ${MIN_PASSWORD} 位`, "PASSWORD_TOO_SHORT");
    }
    if (!store.read().settings.registrationOpen) {
      return bad(res, 403, "站点已关闭自助注册，请联系管理员开号", "REGISTRATION_CLOSED");
    }
    if (store.findUserByEmail(mail)) {
      return bad(res, 409, "该邮箱已注册", "EMAIL_TAKEN");
    }

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      email: mail,
      name: (name || mail.split("@")[0]).slice(0, 32),
      role: "user",
      status: "active",
      salt,
      hash,
      createdAt: now,
      updatedAt: now,
      flags: defaultFlags(),
    };
    await store.write((d) => {
      d.users.push(user);
      store.pushAudit({
        actorId: user.id,
        actorEmail: user.email,
        action: "user.register",
        target: user.id,
      });
    });

    const token = signSession(user, secret);
    setSessionCookie(res, token);
    log("info", "新用户注册", { userId: user.id });
    res.status(201).json({ ok: true, token, user: publicUser(user) });
  }));

  // ---------- 登录 ----------
  app.post("/api/auth/login", safe(async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`login:${ip}`, 10, 60_000)) {
      return bad(res, 429, "尝试过于频繁，请稍后再试", "RATE_LIMITED");
    }
    const { email, password } = (req.body || {}) as { email?: string; password?: string };
    const user = store.findUserByEmail((email || "").trim());
    if (!user || !verifyPassword(password || "", user.salt, user.hash)) {
      return bad(res, 401, "邮箱或密码不正确", "BAD_CREDENTIALS");
    }
    if (user.status !== "active") {
      return bad(res, 403, "账号已被停用，请联系管理员", "ACCOUNT_DISABLED");
    }

    await store.write(() => {
      user.lastLoginAt = new Date().toISOString();
    });

    const token = signSession(user, secret);
    setSessionCookie(res, token);
    res.json({ ok: true, token, user: publicUser(user) });
  }));

  // ---------- 当前用户 ----------
  app.get("/api/auth/me", requireUser, (req: AuthedRequest, res: Response) => {
    res.json({ ok: true, user: publicUser(req.user!) });
  });

  // ---------- 退出 ----------
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ---------- 修改密码 ----------
  app.post("/api/auth/password", requireUser, safe(async (req, res) => {
    const { oldPassword, newPassword } = (req.body || {}) as {
      oldPassword?: string;
      newPassword?: string;
    };
    const user = req.user!;
    if (!verifyPassword(oldPassword || "", user.salt, user.hash)) {
      return bad(res, 400, "原密码不正确", "BAD_OLD_PASSWORD");
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD) {
      return bad(res, 400, `新密码至少 ${MIN_PASSWORD} 位`, "PASSWORD_TOO_SHORT");
    }
    const { salt, hash } = hashPassword(newPassword);
    await store.write(() => {
      user.salt = salt;
      user.hash = hash;
      user.updatedAt = new Date().toISOString();
      store.pushAudit({
        actorId: user.id,
        actorEmail: user.email,
        action: "user.change_password",
        target: user.id,
      });
    });
    res.json({ ok: true });
  }));

  // ---------- 管理：用户列表 ----------
  app.get("/api/admin/users", requireAdmin, (req: Request, res: Response) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const users = store
      .read()
      .users.filter((u) => !q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicUser);
    res.json({ ok: true, users });
  });

  // ---------- 管理：开号 ----------
  app.post("/api/admin/users", requireAdmin, safe(async (req, res) => {
    const { email, password, name, role } = (req.body || {}) as {
      email?: string;
      password?: string;
      name?: string;
      role?: "user" | "admin";
    };
    const mail = (email || "").trim();
    if (!EMAIL_RE.test(mail)) return bad(res, 400, "邮箱格式不正确", "EMAIL_INVALID");
    if (!password || password.length < MIN_PASSWORD) {
      return bad(res, 400, `密码至少 ${MIN_PASSWORD} 位`, "PASSWORD_TOO_SHORT");
    }
    if (store.findUserByEmail(mail)) return bad(res, 409, "该邮箱已存在", "EMAIL_TAKEN");

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      email: mail,
      name: (name || mail.split("@")[0]).slice(0, 32),
      role: role === "admin" ? "admin" : "user",
      status: "active",
      salt,
      hash,
      createdAt: now,
      updatedAt: now,
      flags: defaultFlags(),
    };
    await store.write((d) => {
      d.users.push(user);
      store.pushAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "admin.create_user",
        target: user.id,
        detail: user.role,
      });
    });
    res.status(201).json({ ok: true, user: publicUser(user) });
  }));

  // ---------- 管理：改角色 / 状态 / 权限 ----------
  app.patch("/api/admin/users/:id", requireAdmin, safe(async (req, res) => {
    const target = store.findUserById(req.params.id);
    if (!target) return bad(res, 404, "用户不存在", "USER_NOT_FOUND");
    const { role, status, flags } = (req.body || {}) as {
      role?: "user" | "admin";
      status?: "active" | "disabled";
      flags?: Partial<UserFlags>;
    };

    // 不允许管理员把自己降级或停用，避免把自己锁在门外
    if (target.id === req.user!.id && (role === "user" || status === "disabled")) {
      return bad(res, 400, "不能修改自己的角色或状态", "SELF_LOCKOUT");
    }

    await store.write(() => {
      if (role === "user" || role === "admin") target.role = role;
      if (status === "active" || status === "disabled") target.status = status;
      target.flags = sanitizeFlags(flags, target.flags);
      target.updatedAt = new Date().toISOString();
      store.pushAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "admin.update_user",
        target: target.id,
        detail: JSON.stringify({ role: target.role, status: target.status, flags: target.flags }),
      });
    });
    res.json({ ok: true, user: publicUser(target) });
  }));

  // ---------- 管理：站点设置 ----------
  app.get("/api/admin/settings", requireAdmin, (_req: Request, res: Response) => {
    res.json({ ok: true, settings: store.read().settings });
  });

  app.put("/api/admin/settings", requireAdmin, safe(async (req, res) => {
    const { registrationOpen, siteName } = (req.body || {}) as {
      registrationOpen?: boolean;
      siteName?: string;
    };
    await store.write((d) => {
      if (typeof registrationOpen === "boolean") d.settings.registrationOpen = registrationOpen;
      if (typeof siteName === "string" && siteName.trim()) {
        d.settings.siteName = siteName.trim().slice(0, 32);
      }
      store.pushAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "admin.update_settings",
        detail: JSON.stringify(d.settings),
      });
    });
    res.json({ ok: true, settings: store.read().settings });
  }));

  // ---------- 管理：审计日志 ----------
  app.get("/api/admin/audit", requireAdmin, (_req: Request, res: Response) => {
    res.json({ ok: true, audit: store.read().audit.slice(-200).reverse() });
  });
}

/** 首次启动时按环境变量确保管理员存在（ADMIN_EMAIL + ADMIN_PASSWORD） */
export async function ensureBootstrapAdmin(store: Store, log: AuthRoutesOptions["log"]): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";
  const hasAdmin = store.read().users.some((u) => u.role === "admin");
  if (hasAdmin) return;
  if (!email || password.length < MIN_PASSWORD) {
    log("warn", "尚未创建管理员：请设置 ADMIN_EMAIL 与 ADMIN_PASSWORD（≥8 位）后重启");
    return;
  }
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  const user: User = {
    id: crypto.randomUUID(),
    email,
    name: "管理员",
    role: "admin",
    status: "active",
    salt,
    hash,
    createdAt: now,
    updatedAt: now,
    flags: defaultFlags(),
  };
  await store.write((d) => {
    d.users.push(user);
    store.pushAudit({ actorId: user.id, actorEmail: user.email, action: "system.bootstrap_admin" });
  });
  log("info", "已按环境变量创建初始管理员", { email });
}
