/**
 * store.ts —— 极简 JSON 文档存储（账号 / 设置 / 审计）
 *
 * 为什么不是 SQLite：
 *   `apps/server` 的产物是 esbuild 打出的**单文件、零依赖** dist/index.js（见 build.mjs），
 *   Docker 运行时只复制 dist，不带 node_modules；而 Node 20 没有内置 node:sqlite，
 *   引 better-sqlite3 又需要原生编译 + node_modules。
 *   本项目规模是「自托管 + 几十个账号」，用「单文件 JSON + 原子写 + 串行队列」足够，
 *   且部署形态完全不变。所有读写都收口在本文件，将来换 SQLite 只改这里。
 *
 * 并发模型：单进程、写操作串行（promise 队列），读走内存快照。
 * 落盘：写 tmp → fsync → rename，避免断电产生半截 JSON。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type Role = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface UserFlags {
  /** 是否允许调用在线 AI（/api/ai/*） */
  aiEnabled: boolean;
  /** 每日 AI 调用上限，0 = 不限 */
  aiDailyQuota: number;
  /** 是否允许使用商店道具 */
  shopEnabled: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  flags: UserFlags;
}

export interface AuditEntry {
  at: string;
  actorId: string;
  actorEmail: string;
  action: string;
  target?: string;
  detail?: string;
}

export interface AppSettings {
  /** 是否开放自助注册；关闭后只能由管理员开号 */
  registrationOpen: boolean;
  /** 站点名称（登录页 / 后台标题用） */
  siteName: string;
}

export interface AppData {
  version: 1;
  users: User[];
  settings: AppSettings;
  audit: AuditEntry[];
}

const AUDIT_LIMIT = 500;

const DEFAULT_DATA: AppData = {
  version: 1,
  users: [],
  settings: { registrationOpen: true, siteName: "聪聪学堂" },
  audit: [],
};

export class Store {
  private file: string;
  private data: AppData = structuredClone(DEFAULT_DATA);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) {
    this.file = path.join(dir, "app.json");
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as AppData;
      this.data = {
        version: 1,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        // 文件损坏：备份后从空库启动，避免整个服务起不来
        const bad = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, bad);
          console.error(`[store] app.json 解析失败，已备份到 ${bad}`);
        } catch {
          /* ignore */
        }
      }
      this.data = structuredClone(DEFAULT_DATA);
      await this.flush();
    }
  }

  read(): AppData {
    return this.data;
  }

  /** 串行执行一次写操作；fn 内直接改 this.data，返回后自动落盘 */
  async write<T>(fn: (data: AppData) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const result = fn(this.data);
      if (this.data.audit.length > AUDIT_LIMIT) {
        this.data.audit = this.data.audit.slice(-AUDIT_LIMIT);
      }
      await this.flush();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async flush(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify(this.data, null, 2);
    const fh = await fsp.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, this.file);
  }

  findUserByEmail(email: string): User | undefined {
    const key = email.trim().toLowerCase();
    return this.data.users.find((u) => u.email.toLowerCase() === key);
  }

  findUserById(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  pushAudit(entry: Omit<AuditEntry, "at">): void {
    this.data.audit.push({ at: new Date().toISOString(), ...entry });
  }
}

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    flags: u.flags,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
  };
}
