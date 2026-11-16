"use client";

/**
 * 管理后台（第一版）：用户与权限 + 站点设置 + 操作日志
 *
 * 静态导出下没有服务端中间件，页面守卫在客户端做（拿不到 me 就跳登录），
 * 真正的权限判定在后端 /api/admin/* 上（requireAdmin），前端守卫只是体验层。
 * 商店配置、AI 配置在后续阶段接入本页的 tab。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { accountApi, type AccountUser, type AuditEntry, type SiteConfig } from "@/lib/account";

type Tab = "users" | "settings";

export default function AdminPage() {
  const router = useRouter();
  const [me, setMe] = useState<AccountUser | null>(null);
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [settings, setSettings] = useState<SiteConfig | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");

  const reload = useCallback(async () => {
    const [u, s, a] = await Promise.all([accountApi.adminUsers(q), accountApi.adminSettings(), accountApi.adminAudit()]);
    setUsers(u.users);
    setSettings(s.settings);
    setAudit(a.audit);
  }, [q]);

  useEffect(() => {
    accountApi
      .me()
      .then((r) => {
        if (r.user.role !== "admin") {
          router.replace("/account");
          return;
        }
        setMe(r.user);
        return reload();
      })
      .catch(() => router.replace("/login"));
  }, [router, reload]);

  async function guard(fn: () => Promise<unknown>, okMsg?: string) {
    setErr("");
    setNotice("");
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!me) return <main className="min-h-screen grid place-items-center text-ink-light">校验权限…</main>;

  return (
    <main className="min-h-screen px-4 py-8 bg-bg-soft">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-ink">管理后台</h1>
            <p className="text-sm text-ink-light">
              {me.email} · {settings?.siteName ?? "聪聪学堂"}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTab("users")} className={tab === "users" ? "btn-chunky-primary px-4" : "btn-chunky-ghost px-4"}>
              用户
            </button>
            <button
              onClick={() => setTab("settings")}
              className={tab === "settings" ? "btn-chunky-primary px-4" : "btn-chunky-ghost px-4"}
            >
              站点设置
            </button>
          </div>
        </header>

        {err && <p className="text-sm font-bold text-cardinal">{err}</p>}
        {notice && <p className="text-sm font-bold text-primary">{notice}</p>}

        {tab === "users" && (
          <>
            <section className="bg-white rounded-2xl border-2 border-swan p-4">
              <h2 className="font-extrabold text-ink mb-3">新建账号</h2>
              <div className="grid gap-2 sm:grid-cols-4">
                <input
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="邮箱"
                  className="rounded-xl border-2 border-swan px-3 py-2 text-sm"
                />
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="昵称（可选）"
                  className="rounded-xl border-2 border-swan px-3 py-2 text-sm"
                />
                <input
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="初始密码（≥8 位）"
                  className="rounded-xl border-2 border-swan px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as "user" | "admin")}
                    className="rounded-xl border-2 border-swan px-2 py-2 text-sm"
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                  <button
                    onClick={() =>
                      guard(async () => {
                        await accountApi.adminCreateUser({
                          email: newEmail.trim(),
                          password: newPwd,
                          name: newName.trim() || undefined,
                          role: newRole,
                        });
                        setNewEmail("");
                        setNewName("");
                        setNewPwd("");
                      }, "账号已创建")
                    }
                    className="btn-chunky-primary px-3 text-sm"
                  >
                    创建
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-2xl border-2 border-swan p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-extrabold text-ink">用户列表（{users.length}）</h2>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索邮箱/昵称"
                  className="rounded-xl border-2 border-swan px-3 py-1.5 text-sm"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-ink-light">
                    <tr>
                      <th className="py-2">用户</th>
                      <th>角色</th>
                      <th>状态</th>
                      <th>AI 配额</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-t border-swan">
                        <td className="py-2">
                          <p className="font-bold text-ink">{u.name}</p>
                          <p className="text-xs text-ink-light">{u.email}</p>
                        </td>
                        <td>
                          <select
                            value={u.role}
                            disabled={u.id === me.id}
                            onChange={(e) =>
                              guard(() => accountApi.adminUpdateUser(u.id, { role: e.target.value as "user" | "admin" }), "已更新角色")
                            }
                            className="rounded-lg border-2 border-swan px-2 py-1 text-xs"
                          >
                            <option value="user">用户</option>
                            <option value="admin">管理员</option>
                          </select>
                        </td>
                        <td>
                          <button
                            disabled={u.id === me.id}
                            onClick={() =>
                              guard(
                                () =>
                                  accountApi.adminUpdateUser(u.id, {
                                    status: u.status === "active" ? "disabled" : "active",
                                  }),
                                "已更新状态",
                              )
                            }
                            className={`text-xs font-bold ${u.status === "active" ? "text-primary" : "text-cardinal"}`}
                          >
                            {u.status === "active" ? "正常" : "已停用"}
                          </button>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            defaultValue={u.flags.aiDailyQuota}
                            onBlur={(e) =>
                              guard(
                                () =>
                                  accountApi.adminUpdateUser(u.id, {
                                    flags: { aiDailyQuota: Number(e.target.value) || 0 },
                                  }),
                                "已更新配额",
                              )
                            }
                            className="w-16 rounded-lg border-2 border-swan px-2 py-1 text-xs"
                          />
                        </td>
                        <td>
                          <button
                            onClick={() =>
                              guard(
                                () =>
                                  accountApi.adminUpdateUser(u.id, {
                                    flags: { aiEnabled: !u.flags.aiEnabled },
                                  }),
                                "已切换 AI 权限",
                              )
                            }
                            className="text-xs font-bold text-macaw"
                          >
                            AI {u.flags.aiEnabled ? "开" : "关"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-white rounded-2xl border-2 border-swan p-4">
              <h2 className="font-extrabold text-ink mb-2">最近操作</h2>
              <ul className="text-xs text-ink-light space-y-1 max-h-52 overflow-y-auto">
                {audit.slice(0, 40).map((a, i) => (
                  <li key={i}>
                    {new Date(a.at).toLocaleString()} · {a.actorEmail} · {a.action}
                    {a.target ? ` → ${a.target.slice(0, 8)}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {tab === "settings" && settings && (
          <section className="bg-white rounded-2xl border-2 border-swan p-5 space-y-4">
            <h2 className="font-extrabold text-ink">站点设置</h2>
            <label className="flex items-center justify-between">
              <span className="text-sm font-bold text-ink">开放自助注册</span>
              <input
                type="checkbox"
                checked={settings.registrationOpen}
                onChange={(e) => guard(() => accountApi.adminSaveSettings({ registrationOpen: e.target.checked }), "已保存")}
                className="h-5 w-5"
              />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-ink">站点名称</span>
              <input
                defaultValue={settings.siteName}
                onBlur={(e) => guard(() => accountApi.adminSaveSettings({ siteName: e.target.value }), "已保存")}
                className="mt-1 w-full rounded-xl border-2 border-swan px-3 py-2 text-ink"
              />
            </label>
            <p className="text-xs text-ink-light">
              商店配置与 AI 配置将在后续阶段接入本页（数据表已预留 shop_items / ai_settings）。
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
