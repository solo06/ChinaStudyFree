"use client";

/**
 * account.ts —— 账号 / 管理后台的 API 客户端
 *
 * 认证方式：
 *   - 同源 Web：服务端下发 httpOnly Cookie（csf_session），fetch 带 credentials 即可
 *   - 跨源（Capacitor / 原生端）：登录响应里的 token 存 localStorage，用 Authorization 头
 * 两套同时存在也没问题：服务端先看 Authorization，再看 Cookie。
 */

import { aiUrl, AI_BASE } from "./ai";

const TOKEN_KEY = "csf-auth-token";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  flags: { aiEnabled: boolean; aiDailyQuota: number; shopEnabled: boolean };
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SiteConfig {
  registrationOpen: boolean;
  siteName: string;
}

export interface AuditEntry {
  at: string;
  actorEmail: string;
  action: string;
  target?: string;
  detail?: string;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(aiUrl(path), {
    ...init,
    headers,
    credentials: AI_BASE ? "include" : "same-origin",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string } | null;
    throw new ApiError(err?.error || `请求失败（${res.status}）`, res.status, err?.code);
  }
  return data as T;
}

export const accountApi = {
  config: () => request<{ ok: true } & SiteConfig>("/api/auth/config"),

  me: () => request<{ ok: true; user: AccountUser }>("/api/auth/me"),

  async login(email: string, password: string) {
    const r = await request<{ ok: true; token: string; user: AccountUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(r.token);
    return r.user;
  },

  async register(email: string, password: string, name?: string) {
    const r = await request<{ ok: true; token: string; user: AccountUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
    setToken(r.token);
    return r.user;
  },

  async logout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } finally {
      setToken(null);
    }
  },

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  adminUsers: (q = "") =>
    request<{ ok: true; users: AccountUser[] }>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  adminCreateUser: (payload: { email: string; password: string; name?: string; role?: "user" | "admin" }) =>
    request<{ ok: true; user: AccountUser }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  adminUpdateUser: (
    id: string,
    patch: { role?: "user" | "admin"; status?: "active" | "disabled"; flags?: Partial<AccountUser["flags"]> },
  ) =>
    request<{ ok: true; user: AccountUser }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  adminSettings: () => request<{ ok: true; settings: SiteConfig }>("/api/admin/settings"),

  adminSaveSettings: (patch: Partial<SiteConfig>) =>
    request<{ ok: true; settings: SiteConfig }>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  adminAudit: () => request<{ ok: true; audit: AuditEntry[] }>("/api/admin/audit"),
};
