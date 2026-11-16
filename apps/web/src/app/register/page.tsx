"use client";

/** 注册页 —— 自助注册（管理员可在 /admin 关闭） */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { accountApi } from "@/lib/account";

export default function RegisterPage() {
  const router = useRouter();
  const [open, setOpen] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    accountApi
      .config()
      .then((c) => setOpen(c.registrationOpen))
      .catch(() => setOpen(true));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (password.length < 8) return setErr("密码至少 8 位");
    if (password !== confirm) return setErr("两次输入的密码不一致");
    setBusy(true);
    try {
      await accountApi.register(email.trim(), password, name.trim() || undefined);
      router.replace("/account");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (open === false) {
    return (
      <main className="min-h-screen flex items-center justify-center px-5">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-extrabold text-ink mb-3">站点已关闭自助注册</h1>
          <p className="text-ink-light text-sm mb-6">请联系管理员为你开号。</p>
          <Link href="/login" className="btn-chunky-primary inline-block px-6">
            去登录
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-5 py-10 bg-bg-soft">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-extrabold text-ink text-center mb-1">注册账号</h1>
        <p className="text-center text-ink-light text-sm mb-7">注册后学习记录会保存到服务器</p>

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
            <span className="text-sm font-bold text-ink">昵称（可选）</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
              placeholder="小聪"
            />
          </label>
          <label className="block">
            <span className="text-sm font-bold text-ink">密码</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
              placeholder="至少 8 位"
            />
          </label>
          <label className="block">
            <span className="text-sm font-bold text-ink">确认密码</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
              placeholder="再输一次"
            />
          </label>

          {err && <p className="text-sm font-bold text-cardinal">{err}</p>}

          <button type="submit" disabled={busy} className="btn-chunky-primary w-full">
            {busy ? "注册中…" : "注册并登录"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-ink-light">
          已有账号？
          <Link href="/login" className="text-macaw font-bold ml-1">
            去登录
          </Link>
        </p>
      </div>
    </main>
  );
}
