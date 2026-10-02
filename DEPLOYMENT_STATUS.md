# Cloud Netdisk 部署状态文档

> **文档用途**：记录当前线上部署的完整状态，供运维和接手开发者参考。
>
> **最后更新**：2026-09-18  
> **当前部署 commit**：`6ceda3a`  
> **线上地址**：https://frpz.cc  
> **预览地址**：https://cloud-netdisk.pages.dev  
> **GitHub 仓库**：https://github.com/a13621173445/cloud-netdisk  
> **分支**：`main`

---

## 目录

1. [域名与 DNS](#1-域名与-dns)
2. [Cloudflare Pages 项目](#2-cloudflare-pages-项目)
3. [D1 数据库](#3-d1-数据库)
4. [环境变量](#4-环境变量)
5. [D1 绑定](#5-d1-绑定)
6. [构建配置](#6-构建配置)
7. [部署历史](#7-部署历史)
8. [线上功能状态](#8-线上功能状态)
9. [D1 数据库表结构](#9-d1-数据库表结构)
10. [线上检查清单](#10-线上检查清单)

---

## 1. 域名与 DNS

| 项目 | 值 |
|------|-----|
| 域名 | `frpz.cc` |
| NS 管理商 | Cloudflare |
| NS 地址 | `houston.ns.cloudflare.com`、`nola.ns.cloudflare.com` |
| 域名注册商 | myhostadmin.net（已将 NS 指向 Cloudflare） |
| CNAME 记录 | `frpz.cc` → `cloud-netdisk.pages.dev`（Cloudflare 自动创建） |
| Pages 自定义域名 | `frpz.cc`（已绑定，状态 Active） |

### 域名验证

- `https://frpz.cc` — 可正常访问
- `https://cloud-netdisk.pages.dev` — 可正常访问（默认 Pages 域名）
- HTTPS 证书由 Cloudflare 自动签发

---

## 2. Cloudflare Pages 项目

| 项目 | 值 |
|------|-----|
| 项目名称 | `cloud-netdisk` |
| 项目类型 | Pages（连接 GitHub 仓库） |
| 关联仓库 | `a13621173445/cloud-netdisk` |
| 生产分支 | `main` |
| 自动部署 | 是（push 到 main 触发） |
| 构建命令 | `mkdir -p dist/netdisk && cp index.html dist/ && cp -r netdisk/css netdisk/js netdisk/img dist/netdisk/ && cp netdisk/*.html dist/netdisk/` |
| 构建输出目录 | `dist` |
| 根目录 | `/` |
| Framework preset | None |

---

## 3. D1 数据库

| 项目 | 值 |
|------|-----|
| 数据库名称 | `netdisk-db` |
| 数据库类型 | Cloudflare D1 (SQLite) |
| 绑定变量名 | `DB`（在 Pages Functions 中通过 `env.DB` 访问） |
| 绑定位置 | Pages → Settings → Bindings |
| 创建时间 | 2026 年 8 月 |

### D1 控制台访问路径

Cloudflare Dashboard → Workers & Pages → D1 SQLite Database → `netdisk-db` → Console

---

## 4. 环境变量

位置：Cloudflare Dashboard → Pages → `cloud-netdisk` → Settings → Environment Variables → Production

| 变量名 | 值 | 类型 | 用途 |
|--------|-----|------|------|
| `GITHUB_TOKEN` | `ghp_****（已脱敏）` | Text | GitHub API 调用（文件上传/下载/元数据）。真实值只在 Cloudflare 控制台可见，切勿写入仓库 |
| `SMTP_SERVER` | `smtp.163.com` | Text | 网易邮箱 SMTP 服务器 |
| `SMTP_PORT` | `465` | Text | 隐式 TLS (SSL) 端口 |
| `SMTP_USERNAME` | `a13621173445@163.com` | Text | SMTP 认证用户名 |
| `SMTP_PASSWORD` | `KBf9tPqFLt34Lk7x` | **Secret** | 网易邮箱授权码（加密存储，不可查看） |
| `SMTP_FROM` | `a13621173445@163.com` | Text | 发件人邮箱 |

### 注意事项

- `SMTP_PASSWORD` 设置为 Secret 类型，保存后不可查看明文。如需修改，直接覆盖输入新值。
- `GITHUB_TOKEN` 为明文存储，有泄露风险。前端通过 `config.js` 中的 AES-256-GCM 加密版本使用 Token。
- 环境变量修改后需要重新部署才会生效。

---

## 5. D1 绑定

位置：Cloudflare Dashboard → Pages → `cloud-netdisk` → Settings → Bindings

| 变量名 | 绑定类型 | 目标 |
|--------|---------|------|
| `DB` | D1 database | `netdisk-db` |

Pages Functions 中通过 `context.env.DB` 访问 D1 数据库。

---

## 6. 构建配置

### 构建命令

```bash
mkdir -p dist/netdisk && cp index.html dist/ && cp -r netdisk/css netdisk/js netdisk/img dist/netdisk/ && cp netdisk/*.html dist/netdisk/
```

### 构建产物结构

```
dist/
├── index.html              # 首页
└── netdisk/
    ├── index.html
    ├── login.html
    ├── register.html
    ├── account.html
    ├── admin.html
    ├── verify.html
    ├── reset.html
    ├── reset-confirm.html
    ├── shared.html
    ├── sponsor.html
    ├── eula.html
    ├── css/
    │   └── style.css
    ├── js/
    │   ├── config.js
    │   ├── github.js
    │   ├── netdisk.js
    │   └── ui.js
    └── img/
        ├── delete-icon.webp
        └── sponsor.png
```

### 不包含在构建产物中的目录

以下目录/文件在源码仓库中存在，但不会被复制到 `dist/`：

- `functions/` — Pages Functions 由 Cloudflare 自动处理，不需要构建到 dist
- `netdisk/data/` — 数据文件（GitHub API 管理）
- `netdisk/storage/` — 文件存储（GitHub API 管理）
- `.github/workflows/` — GitHub Actions（已废弃）
- `push_files.ps1` — 批量推送脚本
- `files_batch2.json` — 用途不明的数据文件

---

## 7. 部署历史

### 最近部署记录

| # | Commit | 时间 | 状态 | 说明 |
|---|--------|------|------|------|
| 最新 | `6ceda3a` | 2026-08-30 09:10 | ✅ 成功 | 修复 cloudflare:sockets 导入方式 |
| - | `57d1fff` | 2026-08-30 09:04 | ❌ 失败 | startTls 不是模块导出，部署后修复 |
| - | `eda8f05` | 2026-08-30 07:25 | ✅ 成功 | 修复解冻申请字段名映射 |

### 部署失败原因

`57d1fff` 部署失败原因：
```
Uncaught SyntaxError: The requested module 'cloudflare:sockets' does not provide an export named 'startTls'
```

修复方式：将 `import { connect, startTls }` 改为 `import { connect }`，465 端口用 `{ tls: true }`，587 端口用 `socket.startTls()` 实例方法。

---

## 8. 线上功能状态

### ✅ 正常运行

| 功能 | 说明 |
|------|------|
| 首页访问 | `https://frpz.cc` |
| 用户注册 | D1 存储 + SMTP 验证码邮件 |
| 邮箱验证 | 6 位验证码，10 分钟有效 |
| 用户登录 | D1 验证 + 会话管理 |
| 退出登录 | 清除 D1 会话 |
| 文件上传 | GitHub Contents API |
| 文件下载 | raw.githubusercontent.com 直链 |
| 文件分享 | Token 鉴权分享链接 |
| 公共分享 | 复制文件到 public_storage |
| 修改邮箱 | SMTP 直发新邮箱验证码 |
| 注销账户 | 密码+验证码双重验证 |
| 管理员用户管理 | 列出/冻结/恢复/注销用户 |
| 管理员角色管理 | superadmin 设置/取消管理员 |
| 解冻申请 | 用户提交 → 管理员审批 |

### ❌ 功能失效

| 功能 | 原因 |
|------|------|
| 修改密码 | 仍操作 `users.json`，未迁移到 D1 |
| 密码重置请求 | 仍操作 `users.json`，未迁移到 D1 |
| 密码重置确认 | 仍操作 `users.json`，未迁移到 D1 |
| 自动登录 | 仍操作 `sessions.json`，未迁移到 D1 |
| 管理员文件管理 | API 返回空列表，未迁移 |

### ⚠️ 已废弃

| 功能 | 状态 |
|------|------|
| GitHub Actions 邮件发送 | `.github/workflows/send-email.yml` 保留但不再使用 |
| 前端 `sendVerificationCode()` | 通过 dispatchEvent 触发 Actions，已被 SMTP 替代 |

---

## 9. D1 数据库表结构

### users 表

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'user',              -- user / admin / superadmin
    status TEXT DEFAULT 'active',         -- active / frozen / deleted
    verified INTEGER DEFAULT 0,           -- 0=未验证 1=已验证
    created_at TEXT,
    verification_code TEXT,
    verification_code_expiry TEXT,
    delete_account_code TEXT,             -- ALTER TABLE 后添加
    delete_account_code_expiry TEXT,      -- ALTER TABLE 后添加
    status_reason TEXT,
    status_updated_at TEXT,
    status_updated_by TEXT,
    unfreeze_requested INTEGER DEFAULT 0,
    unfreeze_requested_at TEXT,
    unfreeze_reason TEXT
);
```

### sessions 表

```sql
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT,
    remember_me INTEGER DEFAULT 0,
    ip TEXT,
    last_login_date TEXT
);
```

### 已执行的 ALTER TABLE

```sql
ALTER TABLE users ADD COLUMN delete_account_code TEXT;
ALTER TABLE users ADD COLUMN delete_account_code_expiry TEXT;
```

---

## 10. 线上检查清单

### 日常检查

- [ ] 访问 `https://frpz.cc` 确认站点在线
- [ ] 访问 `https://frpz.cc/netdisk/login` 确认登录页正常
- [ ] 在 Cloudflare Dashboard 查看最新部署状态

### 功能检查

- [ ] 注册新用户 → 验证码邮件能否收到
- [ ] 登录已有账户 → 会话是否正常
- [ ] 上传文件 → GitHub 仓库是否有新文件
- [ ] 下载文件 → 文件内容是否正确
- [ ] 管理员后台 → 用户列表是否正常

### 故障排查

| 症状 | 排查方向 |
|------|---------|
| 验证码收不到 | 检查 SMTP 环境变量、查看 Pages Functions 日志 |
| 登录失败 | 检查 D1 `users` 表、`sessions` 表 |
| 文件上传失败 | 检查 `GITHUB_TOKEN` 有效性、GitHub API 速率限制 |
| 部署失败 | 查看 Cloudflare Pages 构建日志 |
| 页面 404 | 检查构建产物结构、CNAME 配置 |
| API 500 | 查看 Pages Functions 实时日志 (Dashboard → Functions → Real-time Logs) |

### 关键运维操作

| 操作 | 方法 |
|------|------|
| 更新代码 | `git push` 到 `main`，自动部署 |
| 修改环境变量 | Dashboard → Pages → Settings → Environment variables |
| 修改 D1 数据 | Dashboard → D1 → `netdisk-db` → Console 执行 SQL |
| 查看 API 日志 | Dashboard → Pages → Functions → Real-time Logs |
| 回滚部署 | Dashboard → Pages → Deployments → 选择历史部署 → Retry deployment |
| 创建超管 | D1 Console 执行 `UPDATE users SET verified=1, role='superadmin' WHERE email='...'` |
