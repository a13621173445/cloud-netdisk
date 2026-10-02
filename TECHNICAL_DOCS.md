# Cloud Netdisk 技术文档

> **文档用途**：供接手开发的智能体快速了解项目当前状态、架构、已知问题和待修复项。
>
> **最后更新**：2026-09-18  
> **当前部署 commit**：`6ceda3a`  
> **线上地址**：https://frpz.cc  
> **GitHub 仓库**：https://github.com/a13621173445/cloud-netdisk

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构总览](#2-架构总览)
3. [目录结构](#3-目录结构)
4. [技术栈与依赖](#4-技术栈与依赖)
5. [数据存储架构](#5-数据存储架构)
6. [D1 数据库 Schema](#6-d1-数据库-schema)
7. [后端 API 全量清单](#7-后端-api-全量清单)
8. [前端 JS 模块说明](#8-前端-js-模块说明)
9. [SMTP 邮件发送机制](#9-smtp-邮件发送机制)
10. [认证与权限体系](#10-认证与权限体系)
11. [页面路由与 URL 规则](#11-页面路由与-url-规则)
12. [环境变量配置](#12-环境变量配置)
13. [当前系统状态](#13-当前系统状态)
14. [已知问题与待修复项](#14-已知问题与待修复项)
15. [历史迁移记录](#15-历史迁移记录)
16. [部署与更新流程](#16-部署与更新流程)

---

## 1. 项目概览

Cloud Netdisk 是一个基于 GitHub + Cloudflare 的网盘系统。

- **用户认证、会话、管理员操作** → Cloudflare Pages Functions + D1 数据库
- **文件上传、下载、分享** → GitHub 仓库存储（通过 GitHub Contents API）
- **验证码邮件** → Cloudflare Pages Function 内原生 SMTP 客户端直发
- **前端** → 纯静态 HTML/CSS/JS，无框架依赖

---

## 2. 架构总览

```
frpz.cc (Cloudflare NS)
    │
    └── Cloudflare Pages (项目名: cloud-netdisk)
            │
            ├── 静态页面: /netdisk/*.html  (由 build 命令从源码复制到 dist/)
            ├── 首页: /index.html
            │
            ├── Pages Functions: /api/*  (functions/api/[[path]].js)
            │   ├── 认证端点 (register/login/logout/me/verify/resend-code)
            │   ├── 用户端点 (change-email/send-delete-code/delete-account/request-unfreeze)
            │   ├── SMTP 邮件发送 (smtpSend 函数，使用 cloudflare:sockets)
            │   └── 管理员端点 (admin-users/admin-files/admin-set-role 等)
            │
            ├── D1 数据库: netdisk-db (变量名: DB)
            │   └── 表: users, sessions
            │
            └── 环境变量: SMTP_SERVER/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/SMTP_FROM
                    + GITHUB_TOKEN (前端通过 AES 解密后调用 GitHub API)
```

### 请求流向

| 操作类型 | 流向 |
|---------|------|
| 注册/登录/验证码 | 前端 → Cloudflare Pages Function → D1 数据库 → SMTP 直发邮件 |
| 修改邮箱/注销账户 | 前端 → Cloudflare Pages Function → D1 数据库 → SMTP 直发邮件 |
| 文件上传/下载/分享 | 前端 → GitHub Contents API（AES 解密的 Token 鉴权）→ 仓库文件 |
| 管理员用户管理 | 前端 → Cloudflare Pages Function → D1 数据库 |
| 管理员文件管理 | 前端 → GitHub API（管理员端 API 当前返回空列表，未迁移） |

---

## 3. 目录结构

```
cloud-netdisk/
├── index.html                        # 首页（跳转到 netdisk/index）
├── CNAME                             # 自定义域名 frpz.cc
├── .nojekyll                         # 禁用 Jekyll
│
├── functions/
│   └── api/
│       └── [[path]].js               # ★ 后端核心：所有 API 端点 + SMTP 客户端
│
├── netdisk/
│   ├── index.html                    # 网盘主页面（文件列表/上传/分享）
│   ├── login.html                    # 登录页
│   ├── register.html                 # 注册页
│   ├── account.html                  # 账户设置（修改密码/邮箱/注销/解冻申请）
│   ├── admin.html                    # 管理后台
│   ├── verify.html                   # 邮箱验证页
│   ├── reset.html                    # 密码重置请求
│   ├── reset-confirm.html            # 密码重置确认
│   ├── shared.html                   # 分享文件公开访问页
│   ├── sponsor.html                  # 赞助页
│   ├── eula.html                     # 用户协议
│   │
│   ├── css/
│   │   └── style.css                 # 全部样式
│   │
│   ├── js/
│   │   ├── config.js                 # ★ 配置文件（GitHub Token 加密/解密、URL）
│   │   ├── github.js                 # ★ GitHub API 封装层
│   │   ├── netdisk.js                # ★ 核心业务逻辑（认证/文件/分享/管理员）
│   │   └── ui.js                     # UI 工具（弹窗/Toast/模态框）
│   │
│   ├── data/                         # GitHub 仓库内的数据文件
│   │   ├── users.json                # 旧用户数据（迁移前遗留，D1 接管后不再使用）
│   │   ├── files.json                # 文件元数据（仍在使用）
│   │   └── sessions.json             # 旧会话数据（迁移前遗留，D1 接管后不再使用）
│   │
│   ├── img/                          # 静态图片
│   └── storage/ / public_storage/   # 文件实际存储路径（由 GitHub API 管理）
│
├── .github/
│   └── workflows/
│       └── send-email.yml            # ⚠️ 已废弃（旧邮件发送 Action，不再使用）
│
├── DEPLOYMENT_GUIDE.md               # 部署指南
├── README.md
├── LICENSE                           # AGPL-3.0
└── push_files.ps1                    # 批量推送文件脚本
```

---

## 4. 技术栈与依赖

### 后端（Cloudflare Pages Functions）

| 技术 | 说明 |
|------|------|
| Cloudflare Pages Functions | 无服务器函数，位于 `functions/api/[[path]].js` |
| Cloudflare D1 | SQLite 无服务器数据库，绑定变量名 `DB` |
| `cloudflare:sockets` | Cloudflare Workers 原生 TCP 连接模块，用于 SMTP |
| Web Crypto API | PBKDF2 密码哈希、AES-GCM Token 解密、随机数生成 |

> **注意**：Cloudflare Workers 环境没有 Node.js 的 `Buffer`、`net`、`nodemailer`。所有功能用 Web API 实现。

### 前端

| 技术 | 说明 |
|------|------|
| 纯 HTML/CSS/JS | 无框架，无构建工具 |
| GitHub Contents API | 文件 CRUD 操作（通过 `fetch` 调用） |
| Web Crypto API | Token AES-256-GCM 解密、密码 PBKDF2 哈希 |
| localStorage | 会话 Token 和用户信息本地存储 |

### 外部服务

| 服务 | 用途 |
|------|------|
| 网易邮箱 SMTP (smtp.163.com:465) | 验证码邮件发送 |
| GitHub API (api.github.com) | 文件存储、文件元数据管理 |
| GitHub Actions | ⚠️ 仅 `send-email.yml` 保留但已废弃，不再触发 |

---

## 5. 数据存储架构

### 双重存储

项目处于从「GitHub JSON 文件存储」向「Cloudflare D1 数据库」迁移的过渡状态：

| 数据类型 | 旧存储 → 新存储 | 当前状态 |
|---------|----------------|---------|
| 用户账户 | `netdisk/data/users.json` → D1 `users` 表 | ✅ 已迁移到 D1 |
| 用户会话 | `netdisk/data/sessions.json` → D1 `sessions` 表 | ✅ 已迁移到 D1 |
| 验证码 | GitHub Actions 邮件 → Pages Function SMTP 直发 | ✅ 已迁移 |
| 文件元数据 | `netdisk/data/files.json` | ❌ 未迁移，仍在 GitHub JSON |
| 文件内容 | GitHub 仓库 `netdisk/storage/` | ❌ 未迁移（仍在 GitHub） |
| 公共分享文件 | GitHub 仓库 `netdisk/public_storage/` | ❌ 未迁移（仍在 GitHub） |

### 旧 JSON 文件残留

`netdisk/data/users.json` 和 `netdisk/data/sessions.json` 仍存在于仓库中，但后端代码不再读写它们。`files.json` 仍由前端 `netdisk.js` 通过 GitHub API 读写。

---

## 6. D1 数据库 Schema

### users 表

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                    -- crypto.randomUUID()
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- PBKDF2-SHA256 哈希（100000 次迭代）
    salt TEXT NOT NULL,                     -- 16 字节随机盐（hex 编码）
    role TEXT DEFAULT 'user',              -- user / admin / superadmin
    status TEXT DEFAULT 'active',          -- active / frozen / deleted
    verified INTEGER DEFAULT 0,            -- 0=未验证 1=已验证
    created_at TEXT,                        -- ISO 8601 时间戳
    -- 邮箱验证码
    verification_code TEXT,
    verification_code_expiry TEXT,          -- 10 分钟有效
    -- 注销账户验证码
    delete_account_code TEXT,
    delete_account_code_expiry TEXT,
    -- 状态管理
    status_reason TEXT,
    status_updated_at TEXT,
    status_updated_by TEXT,
    -- 解冻申请
    unfreeze_requested INTEGER DEFAULT 0,
    unfreeze_requested_at TEXT,
    unfreeze_reason TEXT
);
```

### sessions 表

```sql
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,                 -- 32 字节随机 hex 字符串
    user_id TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT,                        -- 7天 或 30天（记住我）
    remember_me INTEGER DEFAULT 0,
    ip TEXT,                               -- CF-Connecting-IP
    last_login_date TEXT                    -- YYYY-MM-DD
);
```

### 注意事项

- `delete_account_code` 和 `delete_account_code_expiry` 是后来通过 `ALTER TABLE` 添加的，不在初始 `CREATE TABLE` 中
- 登录时会先删除该用户的所有旧会话再创建新会话（单设备登录）
- 管理员冻结用户时会清除该用户的所有会话

---

## 7. 后端 API 全量清单

所有 API 位于 `functions/api/[[path]].js`，路径前缀 `/api/`。

### 认证端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/register` | 无 | 注册：写入 D1 + 发送验证码邮件。邮件发送失败则删除刚创建的用户 |
| POST | `/api/login` | 无 | 登录：验证密码+验证状态+账户状态，创建会话。先删除旧会话 |
| POST | `/api/logout` | Bearer Token | 退出：删除当前会话 |
| GET | `/api/me` | Bearer Token | 获取当前用户信息 |
| POST | `/api/verify` | 无 | 邮箱验证：校验验证码，设 `verified=1` |
| POST | `/api/resend-code` | 无 | 重新发送验证码 |

### 用户端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/change-email` | Bearer Token | 修改邮箱：验证密码→更新邮箱→发送新邮箱验证码。邮件发送失败则回滚 |
| POST | `/api/send-delete-code` | Bearer Token | 发送注销验证码：生成验证码存入 D1 + 发送邮件 |
| POST | `/api/delete-account` | Bearer Token | 注销账户：验证密码+验证码→删除会话→删除用户 |
| POST | `/api/request-unfreeze` | Bearer Token | 提交解冻申请 |

### 管理员端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/admin-users` | admin+ | 列出所有用户 |
| GET | `/api/admin-files` | admin+ | 列出所有文件（当前返回空列表） |
| GET | `/api/admin-files-grouped` | admin+ | 按用户分组的文件统计（当前返回空） |
| GET | `/api/admin-public-files` | admin+ | 公共文件列表（当前返回空） |
| GET | `/api/admin-unfreeze-requests` | admin+ | 解冻申请列表 |
| POST | `/api/admin-set-role` | superadmin | 设置/取消管理员角色 |
| POST | `/api/admin-set-status` | admin+ | 冻结/恢复用户 |
| POST | `/api/admin-delete-user` | admin+ | 管理员注销用户 |
| POST | `/api/admin-handle-unfreeze` | admin+ | 批准/拒绝解冻申请 |

### API 响应格式

```json
// 成功
{ "success": true, "message": "...", ... }

// 失败
{ "error": "错误信息" }  // HTTP status 非 200
```

---

## 8. 前端 JS 模块说明

### `config.js` — 配置文件

- GitHub 仓库信息（owner, repo, branch）
- GitHub Token 的 AES-256-GCM 加密存储（TOKEN_KEY / TOKEN_IV / TOKEN_CIPHER）
- 页面基础 URL (`https://frpz.cc/netdisk`)
- `getApiBase()` 返回 `window.location.origin`（同源调用 Pages Functions）
- `getToken()` 异步解密 Token 并缓存

### `github.js` — GitHub API 封装

- `getContent(path)` — 读取文件内容和 SHA
- `getJsonData(path)` — 读取并解析 JSON 文件
- `createOrUpdateFile(path, base64, message, sha)` — 创建/更新文件
- `updateJsonData(path, updater, message)` — 带重试的 JSON 文件更新（处理并发冲突，最多 3 次重试）
- `deleteFile(path, message, sha)` — 删除文件
- `dispatchEvent(eventType, payload)` — 触发 GitHub Actions（⚠️ 已废弃，不再用于邮件发送）
- `getRawUrl(path)` — 获取 raw.githubusercontent.com 直链

### `netdisk.js` — 核心业务逻辑

包含 `Netdisk` 对象，所有业务方法：

**已迁移到后端 API 的方法**（调用 `/api/*`）：
- `register()` → POST `/api/register`
- `login()` → POST `/api/login`
- `logout()` → POST `/api/logout`
- `getCurrentUser()` → GET `/api/me`
- `verifyEmail()` → POST `/api/verify`
- `resendVerificationCode()` → POST `/api/resend-code`
- `changeEmail()` → POST `/api/change-email`
- `sendDeleteAccountCode()` → POST `/api/send-delete-code`
- `deleteMyAccount()` → POST `/api/delete-account`
- `requestUnfreeze()` → POST `/api/request-unfreeze`
- `adminListUsers()` → GET `/api/admin-users`
- `adminListFiles()` → GET `/api/admin-files`
- `adminListFilesGroupedByUser()` → GET `/api/admin-files-grouped`
- `adminListPublicFiles()` → GET `/api/admin-public-files`
- `adminListUnfreezeRequests()` → GET `/api/admin-unfreeze-requests`
- `setAdminRole()` → POST `/api/admin-set-role`
- `adminFreezeUser()` / `adminActivateUser()` → POST `/api/admin-set-status`
- `adminDeleteUser()` → POST `/api/admin-delete-user`
- `adminHandleUnfreezeRequest()` → POST `/api/admin-handle-unfreeze`

**仍使用 GitHub API 的方法**（直接调用 GitHub Contents API）：
- `uploadFile(file)` — 上传文件到仓库 `netdisk/storage/`
- `listFiles()` — 从 `files.json` 读取文件列表
- `listGlobalFiles()` — 从 `files.json` 读取公共文件
- `listMyShares()` — 从 `files.json` 读取我的分享
- `downloadFile(fileId)` — 从 raw URL 下载
- `deleteFile(fileId)` — 删除仓库文件 + 更新 `files.json`
- `createPublicShare(fileId)` — 复制文件到 `public_storage/` + 写入 `files.json`
- `createShareLink(fileId, expireDays, maxDownloads)` — 生成分享 Token + 更新 `files.json`
- `revokeShare(fileId)` — 取消分享
- `getSharedFile(shareToken)` — 公开访问分享文件
- `adminTakeDownFile()` / `adminRestoreFile()` / `adminDeleteFile()` / `adminDownloadFile()` — 管理员文件操作

**仍使用 GitHub API 但已废弃的方法**（代码残留，不应再调用）：
- `sendVerificationCode()` — 通过 `GitHubAPI.dispatchEvent('send-email', ...)` 触发 Actions
- `sendVerificationEmail()` — 同上
- `resendVerification()` — 同上
- `requestPasswordReset(email)` — 直接操作 `users.json`（已废弃，未迁移到 D1）
- `resetPassword(token, newPassword)` — 同上
- `changePassword(oldPassword, newPassword)` — 直接操作 `users.json`（已废弃，未迁移到 D1）
- `checkAutoLogin()` — 直接操作 `sessions.json`（已废弃，未迁移到 D1）
- `createAdminAccount()` — 直接操作 `users.json`（已废弃，未迁移到 D1）

### `ui.js` — UI 工具

弹窗、Toast 通知、模态框等通用 UI 组件。

---

## 9. SMTP 邮件发送机制

### 实现位置

`functions/api/[[path]].js` 中的 `smtpSend(env, to, subject, textBody)` 函数。

### 工作原理

1. 使用 `import { connect } from 'cloudflare:sockets'` 建立 TCP 连接
2. **465 端口**：隐式 TLS，`connect()` 时传入 `{ tls: true }`
3. **587/25 端口**：先建立明文 TCP 连接，发送 EHLO + STARTTLS 后调用 `socket.startTls()` 升级为 TLS
4. 进行 SMTP AUTH LOGIN 认证（用户名和密码 Base64 编码）
5. 发送 MAIL FROM / RCPT TO / DATA 命令
6. 邮件内容使用 RFC 5322 格式，Subject 使用 `=?UTF-8?B?...?=` 编码
7. Body 使用 Base64 编码（支持 UTF-8）

### 关键修复历史

- **错误**：最初代码 `import { connect, startTls } from 'cloudflare:sockets'`，但 `startTls` 不是模块导出
- **修复**：改为 `import { connect } from 'cloudflare:sockets'`，465 端口用 `{ tls: true }`，587 端口用 `socket.startTls()` 实例方法

### 邮件发送失败处理

| 场景 | 处理 |
|------|------|
| 注册时邮件失败 | 删除刚创建的用户，返回 500 错误 |
| 重新发送验证码时失败 | 返回 500 错误 |
| 修改邮箱时邮件失败 | 回滚邮箱到旧值，恢复 `verified=1`，返回 500 错误 |
| 发送注销验证码失败 | 返回 500 错误（验证码已写入 D1 但无害） |

---

## 10. 认证与权限体系

### 密码哈希

- 算法：PBKDF2 + SHA-256
- 迭代次数：100,000 次
- 盐：16 字节随机（crypto.getRandomValues）
- 输出：256 位（32 字节），hex 编码存储

### 会话机制

- Token：32 字节随机 hex 字符串
- 有效期：7 天（普通）/ 30 天（记住我）
- 存储：D1 `sessions` 表 + 前端 `localStorage`
- 单设备登录：登录时删除该用户所有旧会话

### 角色体系

| 角色 | 权限 |
|------|------|
| `user` | 普通用户：文件上传/下载/分享/修改邮箱/注销账户 |
| `admin` | 管理员：以上 + 列出用户/冻结用户/注销用户/处理解冻/文件管理 |
| `superadmin` | 超级管理员：以上 + 设置/取消管理员角色 |

### 权限保护规则

- 管理员不能操作自己的账户
- 管理员不能操作同级或更高级管理员
- 超级管理员不能被任何人操作
- 超级管理员不能注销自己
- 冻结状态的用户不能注销账户

---

## 11. 页面路由与 URL 规则

Cloudflare Pages 默认支持无 `.html` 后缀的 URL。

| 页面 | URL | 文件 |
|------|-----|------|
| 首页 | `https://frpz.cc/` | `index.html` |
| 网盘主页面 | `/netdisk/index` | `netdisk/index.html` |
| 登录 | `/netdisk/login` | `netdisk/login.html` |
| 注册 | `/netdisk/register` | `netdisk/register.html` |
| 账户设置 | `/netdisk/account` | `netdisk/account.html` |
| 管理后台 | `/netdisk/admin` | `netdisk/admin.html` |
| 邮箱验证 | `/netdisk/verify` | `netdisk/verify.html` |
| 重置密码 | `/netdisk/reset` | `netdisk/reset.html` |
| 重置确认 | `/netdisk/reset-confirm` | `netdisk/reset-confirm.html` |
| 分享文件 | `/netdisk/shared` | `netdisk/shared.html` |
| 赞助 | `/sponsor` | `functions/sponsor.js`（旧地址 `/netdisk/sponsor` 会自动跳转） |
| 作业查看 | `/html` | `functions/html/[[path]].js`（列表 + 搜索 + 单个作业 `/html/<原名>.html`） |
| 用户协议 | `/netdisk/eula` | `netdisk/eula.html` |

---

## 12. 环境变量配置

### Cloudflare Pages → Settings → Environment Variables (Production)

| 变量名 | 值 | 类型 |
|--------|-----|------|
| `GITHUB_TOKEN` | `ghp_...` | Text（GitHub PAT，前端使用） |
| `SMTP_SERVER` | `smtp.163.com` | Text |
| `SMTP_PORT` | `465` | Text |
| `SMTP_USERNAME` | `a13621173445@163.com` | Text |
| `SMTP_PASSWORD` | （网易邮箱授权码） | Secret（加密存储） |
| `SMTP_FROM` | `a13621173445@163.com` | Text |

### Cloudflare Pages → Settings → Bindings

| 变量名 | 绑定类型 | 目标 |
|--------|---------|------|
| `DB` | D1 database | `netdisk-db` |

---

## 13. 当前系统状态

### ✅ 已完成并正常工作

1. **用户注册**：D1 存储 + SMTP 直发验证码
2. **邮箱验证**：验证码存储在 D1，10 分钟有效
3. **用户登录**：D1 验证 + 会话管理（单设备登录）
4. **退出登录**：删除 D1 会话
5. **获取当前用户**：Bearer Token 鉴权
6. **修改邮箱**：验证密码 → 更新邮箱 → SMTP 发送新邮箱验证码（失败回滚）
7. **发送注销验证码**：SMTP 直发
8. **注销账户**：密码 + 验证码双重验证 → 删除用户和会话
9. **管理员用户管理**：列出用户/冻结/恢复/注销/设置角色
10. **解冻申请**：用户提交 → 管理员审批
11. **文件上传/下载/分享**：GitHub API 操作（未迁移，仍在工作）

### ⚠️ 部分工作但有问题

1. **密码重置**：`requestPasswordReset()` 和 `resetPassword()` 仍直接操作 `users.json`，未迁移到 D1，**功能已失效**
2. **修改密码**：`changePassword()` 仍直接操作 `users.json`，未迁移到 D1，**功能已失效**
3. **自动登录**：`checkAutoLogin()` 仍直接操作 `sessions.json`，未迁移到 D1，**功能已失效**
4. **管理员文件管理**：API 返回空列表，文件管理功能未迁移到后端
5. **管理员下架/恢复/删除文件**：仍通过 GitHub API 操作 `files.json`

### ❌ 已废弃

1. **GitHub Actions 邮件发送** (`.github/workflows/send-email.yml`)：已废弃，不再触发
2. **`sendVerificationCode()` / `sendVerificationEmail()` 前端方法**：通过 `dispatchEvent` 触发 Actions，已被 SMTP 直发替代
3. **`createAdminAccount()` 前端方法**：直接操作 `users.json`，已被 D1 管理

---

## 14. 已知问题与待修复项

### 🔴 严重（功能失效）

1. **修改密码功能失效**
   - 位置：`netdisk.js` → `changePassword()`
   - 问题：仍通过 `GitHubAPI.updateJsonData(CONFIG.DATA.USERS, ...)` 操作 `users.json`，但用户数据已迁移到 D1
   - 修复方案：新增后端 API `/api/change-password`，在 D1 中验证旧密码并更新新密码
   - 前端：`changePassword()` 改为调用 `/api/change-password`

2. **密码重置功能失效**
   - 位置：`netdisk.js` → `requestPasswordReset()` 和 `resetPassword()`
   - 问题：仍操作 `users.json`，未迁移到 D1
   - 修复方案：
     - 新增 `/api/request-reset`：生成重置 Token 存入 D1 + SMTP 发送重置邮件
     - 新增 `/api/reset-password`：验证 Token + 更新密码
     - 前端两个函数改为调用后端 API

3. **自动登录功能失效**
   - 位置：`netdisk.js` → `checkAutoLogin()`
   - 问题：仍操作 `sessions.json`，未迁移到 D1
   - 修复方案：可以移除此功能，或新增后端 API 查询同 IP 当天会话

### 🟡 中等（代码残留/不一致）

4. **前端废弃方法残留**
   - `sendVerificationCode()`、`sendVerificationEmail()`、`resendVerification()` 通过 `dispatchEvent` 触发 Actions，不再需要
   - 应删除这些方法，或至少确保不被调用

5. **管理员文件管理 API 返回空**
   - `handleAdminFiles()`、`handleAdminFilesGrouped()`、`handleAdminPublicFiles()` 均返回空列表
   - 文件元数据仍在 `files.json`（GitHub 仓库），后端无法直接访问
   - 需要：要么将文件元数据也迁移到 D1，要么后端通过 GitHub API 读取 `files.json`

6. **`createAdminAccount()` 方法废弃**
   - 仍直接操作 `users.json`，应通过 D1 创建或通过注册+手动设为 superadmin

7. **旧 JSON 文件残留**
   - `netdisk/data/users.json` 和 `sessions.json` 不再被后端使用，但仍存在于仓库中
   - `files.json` 仍在使用

### 🟢 低优先级

8. **`push_files.ps1` 脚本**：用途不明确，可能是早期批量推送文件用

9. **`files_batch2.json`**：根目录存在，用途不明确

10. **SMTP 错误未分类**：所有 SMTP 错误都作为 500 返回，前端无法区分是配置问题还是临时故障

---

## 15. 历史迁移记录

按时间顺序（旧→新）：

| Commit | 变更 |
|--------|------|
| `162d226` | 用户管理从 GitHub JSON 迁移到 Cloudflare Pages Functions + D1 |
| `2ba5d19` | 去掉 .html 后缀，使用干净 URL |
| `b432284` | 管理员功能迁移到 Cloudflare API |
| `368bc19` | 修复注册时间字段名映射 |
| `56981dc` | GitHub Netdisk 改名为 Cloud Netdisk |
| `3d9cb28` | 邮箱验证从 Token 链接改为验证码方式 |
| `65e5829` | 优化 SQL 查询，验证码不泄露到前端 |
| `f187457` | 修复管理员操作参数校验 |
| `002e1af` | 删除禁用功能，保留冻结 |
| `eda8f05` | 修复解冻申请字段名映射 |
| `57d1fff` | 修改邮箱和注销账户改为 SMTP 直发验证码 |
| `6ceda3a` | 修复 cloudflare:sockets 导入方式（startTls 是实例方法） |

---

## 16. 部署与更新流程

### 自动部署

1. 修改代码
2. `git add` + `git commit` + `git push` 到 `main` 分支
3. Cloudflare Pages 自动触发构建部署（约 1-2 分钟）
4. 构建命令：`mkdir -p dist/netdisk && cp index.html dist/ && cp -r netdisk/css netdisk/js netdisk/img dist/netdisk/ && cp netdisk/*.html dist/netdisk/`
5. 输出目录：`dist`

### D1 数据库操作

通过 Cloudflare Dashboard → Workers & Pages → D1 → `netdisk-db` → Console 执行 SQL。

### 环境变量修改

Cloudflare Dashboard → Pages → cloud-netdisk → Settings → Environment variables。

### 关键配置

- **域名**：`frpz.cc`（Cloudflare NS 管理，CNAME 指向 `cloud-netdisk.pages.dev`）
- **D1 数据库名**：`netdisk-db`
- **Pages 项目名**：`cloud-netdisk`
- **GitHub 仓库**：`a13621173445/cloud-netdisk`
- **分支**：`main`

---

## 附：快速上手检查清单

接手开发时，请按以下顺序检查：

1. 访问 https://frpz.cc 确认站点在线
2. 测试注册流程（验证码邮件能否收到）
3. 测试登录流程
4. 检查 `functions/api/[[path]].js` 是否有语法错误
5. 检查 D1 数据库 `users` 和 `sessions` 表是否存在且字段完整
6. 检查环境变量是否配置（6 个变量 + 1 个 D1 绑定）
7. **不要使用** `sendVerificationCode()` 等前端废弃方法
8. **不要操作** `netdisk/data/users.json` 和 `sessions.json`（已废弃）
9. 密码重置和修改密码功能需要迁移到 D1 后端（当前失效）
10. 文件管理功能仍在用 GitHub API（正常工作，但管理员端 API 返回空）
