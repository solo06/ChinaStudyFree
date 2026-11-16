"use client";

/** 账号中心：查看资料 / 改密码 / 退出 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { accountApi, type AccountUser } from "@/lib/account";

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    accountApi
      .me()
      .then((r) => setUser(r.user))
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setErr("");
    try {
      await accountApi.changePassword(oldPwd, newPwd);
      setMsg("密码已修改");
      setOldPwd("");
      setNewPwd("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function logout() {
    await accountApi.logout();
    router.replace("/login");
  }

  if (loading) return <main className="min-h-screen grid place-items-center text-ink-light">加载中…</main>;
  if (!user) return null;

  return (
    <main className="min-h-screen px-5 py-10 bg-bg-soft">
      <div className="mx-auto w-full max-w-lg space-y-5">
        <h1 className="text-2xl font-extrabold text-ink">账号中心</h1>

        <section className="bg-white rounded-2xl border-2 border-swan p-5 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-extrabold text-ink">{user.name}</p>
              <p className="text-sm text-ink-light">{user.email}</p>
            </div>
            <span className="text-xs font-bold px-2 py-1 rounded-lg bg-bg-soft text-ink-light">
              {user.role === "admin" ? "管理员" : "普通用户"}
            </span>
          </div>
          <div className="pt-2 text-sm text-ink-light space-y-1">
            <p>在线 AI：{user.flags.aiEnabled ? "可用" : "已关闭"}</p>
            <p>每日 AI 配额：{user.flags.aiDailyQuota === 0 ? "不限" : `${user.flags.aiDailyQuota} 次`}</p>
            <p>商店：{user.flags.shopEnabled ? "可用" : "已关闭"}</p>
            {user.lastLoginAt && <p>上次登录：{new Date(user.lastLoginAt).toLocaleString()}</p>}
          </div>
          {user.role === "admin" && (
            <Link href="/admin" className="inline-block mt-3 text-sm font-bold text-macaw">
              进入管理后台 →
            </Link>
          )}
        </section>

        <section className="bg-white rounded-2xl border-2 border-swan p-5">
          <h2 className="font-extrabold text-ink mb-3">修改密码</h2>
          <form onSubmit={changePassword} className="space-y-3">
            <input
              type="password"
              required
              placeholder="原密码"
              autoComplete="current-password"
              value={oldPwd}
              onChange={(e) => setOldPwd(e.target.value)}
              className="w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
            />
            <input
              type="password"
              required
              placeholder="新密码（至少 8 位）"
              autoComplete="new-password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              className="w-full rounded-xl border-2 border-swan px-3 py-2.5 text-ink outline-none focus:border-macaw"
            />
            {msg && <p className="text-sm font-bold text-primary">{msg}</p>}
            {err && <p className="text-sm font-bold text-cardinal">{err}</p>}
            <button type="submit" className="btn-chunky-primary w-full">
              保存
            </button>
          </form>
        </section>

        <button onClick={logout} className="btn-chunky-ghost w-full">
          退出登录
        </button>
      </div>
    </main>
  );
}
