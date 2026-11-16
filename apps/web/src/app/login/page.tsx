"use client";

/**
 * 登录页 —— 静态导出下的纯客户端页面，调用 /api/auth/login
 * 未登录也能浏览/做题，登录后才有云端记录（本项目按「不登录不保存记录」设计）。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { accountApi, type SiteConfig } from "@/lib/account";

export default function LoginPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    accountApi
      .config()
      .then((c) => setCfg({ registrationOpen: c.registrationOpen, siteName: c.siteName }))
      .catch(() => setCfg({ registrationOpen: true, siteName: "聪聪学堂" }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const user = await accountApi.login(email.trim(), password);
      router.replace(user.role === "admin" ? "/admin" : "/account");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-5 py-10 bg-bg-soft">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-extrabold text-ink text-center mb-1">
          {cfg?.siteName ?? "聪聪学堂"}
        </h1>
        <p className="text-center text-ink-light text-sm mb-7">登录后才会保存学习记录</p>

        <form onSubmit={submit} className="bg-white rounded-2xl border-2 border-swan p-5 space-y-4">
          <label className="block">
            <span className="text-sm font-bold text-ink">邮箱</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="text-sm font-bold text-ink">密码</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
              placeholder="至少 8 位"
            />
          </label>

          {err && <p className="text-sm font-bold text-cardinal">{err}</p>}

          <button type="submit" disabled={busy} className="btn-chunky-primary w-full">
            {busy ? "登录中…" : "登录"}
          </button>
        </form>

        <div className="mt-5 text-center text-sm text-ink-light space-y-2">
          {cfg?.registrationOpen ? (
            <p>
              还没有账号？
              <Link href="/register" className="text-macaw font-bold ml-1">
                注册
              </Link>
            </p>
          ) : (
            <p>站点已关闭自助注册，请联系管理员开号</p>
          )}
          <p>
            <Link href="/" className="text-ink-light underline">
              先随便逛逛（不保存记录）
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
