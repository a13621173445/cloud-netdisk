# Cloud Netdisk - Cloudflare 部署指南

## 项目简介

Cloud Netdisk 是一个基于 GitHub + Cloudflare 的网盘系统。用户数据存储在 Cloudflare D1 数据库，文件存储在 GitHub 仓库。

## 架构

```
frpz.cc (Cloudflare NS)
    └── Cloudflare Pages (cloud-netdisk)
        ├── 静态页面: /netdisk/*.html
        ├── Pages Functions: /api/* (认证 + 管理员 API)
        └── D1 数据库: netdisk-db (用户/会话)
```

## 目录结构

```
cloud-netdisk/
├── index.html                    # 首页
├── functions/
│   └── api/
│       └── [[path]].js           # Cloudflare Pages Functions（认证 + 管理员 API）
├── netdisk/
│   ├── index.html                # 网盘主页面
│   ├── login.html                # 登录页
│   ├── register.html             # 注册页
│   ├── account.html              # 账户设置
│   ├── admin.html                # 管理后台
│   ├── reset.html                # 重置密码
│   ├── reset-confirm.html        # 确认重置
│   ├── verify.html               # 邮箱验证
│   ├── shared.html               # 分享文件
│   ├── sponsor.html              # 赞助
│   ├── eula.html                 # 用户协议
│   ├── css/style.css             # 样式
│   ├── js/
│   │   ├── config.js             # 配置文件
│   │   ├── github.js             # GitHub API 封装
│   │   ├── netdisk.js            # 核心业务逻辑
│   │   └── ui.js                 # UI 工具
│   ├── data/                     # 数据文件（GitHub 存储）
│   └── storage/                  # 文件存储
└── .github/workflows/
    └── send-email.yml            # 邮件发送 GitHub Action
```

## 部署步骤

### 1. 域名 NS 迁移到 Cloudflare

1. 在 Cloudflare 添加域名 `frpz.cc`
2. 获取 Cloudflare 分配的 NS 地址（如 `houston.ns.cloudflare.com`、`nola.ns.cloudflare.com`）
3. 在域名注册商（myhostadmin.net）修改 NS 为 Cloudflare 的 NS
4. 等待 NS 生效（约 1-2 小时）

### 2. 创建 D1 数据库

1. 登录 Cloudflare Dashboard
2. 进入 **Workers & Pages** → **D1 SQLite Database**
3. 点击 **Create database**，命名为 `netdisk-db`
4. 记录数据库 UUID

### 3. 创建 D1 表结构

在 D1 控制台执行以下 SQL：

```sql
-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    verified INTEGER DEFAULT 0,
    created_at TEXT,
    status_reason TEXT,
    status_updated_at TEXT,
    status_updated_by TEXT,
    unfreeze_requested INTEGER DEFAULT 0,
    unfreeze_requested_at TEXT,
    unfreeze_reason TEXT
);

-- 会话表
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

### 4. 创建 Cloudflare Pages 项目

1. 进入 **Workers & Pages** → **Create** → **Pages**
2. 选择 **Connect to Git**，连接 GitHub 仓库 `a13621173445/cloud-netdisk`
3. 配置构建：
   - **Framework preset**: None
   - **Build command**: `mkdir -p dist/netdisk && cp index.html dist/ && cp -r netdisk/css netdisk/js netdisk/img dist/netdisk/ && cp netdisk/*.html dist/netdisk/`
   - **Build output directory**: `dist`
   - **Root directory**: `/`
4. 点击 **Save and Deploy**

### 5. 绑定 D1 数据库

1. 进入 Pages 项目 → **Settings** → **Bindings**
2. 点击 **Add** → **D1 database**
3. 变量名：`DB`
4. 选择数据库：`netdisk-db`

### 6. 绑定自定义域名

1. 进入 Pages 项目 → **Custom domains**
2. 点击 **Set up a custom domain**
3. 输入 `frpz.cc`
4. Cloudflare 会自动创建 CNAME 记录指向 `cloud-netdisk.pages.dev`

### 7. 配置 Cloudflare Pages 环境变量（邮件发送）

验证码邮件通过 Cloudflare Pages Function 直接使用 SMTP 发送，无需 GitHub Actions。请在 Pages 项目 **Settings** → **Environment variables** 中添加：

| 变量名 | 说明 |
|--------|------|
| `SMTP_SERVER` | SMTP 服务器地址（如 `smtp.163.com`） |
| `SMTP_PORT` | SMTP 端口（`465` 为隐式 TLS，`587` 为 STARTTLS） |
| `SMTP_USERNAME` | SMTP 用户名（邮箱地址） |
| `SMTP_PASSWORD` | SMTP 授权码 |
| `SMTP_FROM` | 发件人邮箱 |

> 注意：`SMTP_PORT` 为 `465` 时使用隐式 TLS（SSL），为 `587` 或 `25` 时使用 STARTTLS。网易邮箱（163）推荐使用 `465` 端口。

### 8. 创建超管账号

1. 通过注册接口创建用户：
   ```bash
   curl -X POST https://frpz.cc/api/register \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","email":"admin@example.com","password":"password123"}'
   ```

2. 在 D1 控制台执行 SQL 设置超管：
   ```sql
   UPDATE users SET verified = 1, role = 'superadmin' WHERE email = 'admin@example.com';
   ```

## API 端点

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录 |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/me` | 获取当前用户 |
| POST | `/api/verify` | 邮箱验证 |

### 管理员接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin-users` | 列出所有用户 |
| GET | `/api/admin-files` | 列出所有文件 |
| GET | `/api/admin-files-grouped` | 按用户分组的文件 |
| GET | `/api/admin-public-files` | 公共文件 |
| GET | `/api/admin-unfreeze-requests` | 解冻申请 |
| POST | `/api/admin-set-role` | 设置/取消管理员 |
| POST | `/api/admin-set-status` | 禁用/冻结/恢复用户 |
| POST | `/api/admin-delete-user` | 注销用户 |
| POST | `/api/admin-handle-unfreeze` | 处理解冻申请 |

## 页面 URL

| 页面 | URL |
|------|-----|
| 首页 | `https://frpz.cc/` |
| 网盘 | `https://frpz.cc/netdisk/index` |
| 登录 | `https://frpz.cc/netdisk/login` |
| 注册 | `https://frpz.cc/netdisk/register` |
| 账户设置 | `https://frpz.cc/netdisk/account` |
| 管理后台 | `https://frpz.cc/netdisk/admin` |
| 重置密码 | `https://frpz.cc/netdisk/reset` |
| 赞助 | `https://frpz.cc/netdisk/sponsor` |

## 配置文件说明

### `netdisk/js/config.js`

```javascript
const CONFIG = {
    GITHUB_OWNER: 'a13621173445',        // GitHub 用户名
    REPO_NAME: 'cloud-netdisk',          // 仓库名
    BRANCH: 'main',                       // 分支
    PAGES_BASE_URL: 'https://frpz.cc/netdisk',  // 页面基础 URL
    TOKEN_KEY: '...',                     // GitHub Token AES 加密 KEY
    TOKEN_IV: '...',                      // GitHub Token AES 加密 IV
    TOKEN_CIPHER: '...',                  // GitHub Token AES 加密密文
    API_BASE: 'https://api.github.com',   // GitHub API 地址
    DATA: {
        USERS: 'netdisk/data/users.json',
        FILES: 'netdisk/data/files.json',
        SESSIONS: 'netdisk/data/sessions.json'
    },
    STORAGE_DIR: 'netdisk/storage',
    PUBLIC_STORAGE_DIR: 'netdisk/public_storage'
};
```

## 常见问题

### 1. 用户管理不显示用户
- 检查 `functions/api/[[path]].js` 是否包含管理员 API 端点
- 检查 `netdisk.js` 中的 `adminListUsers()` 是否调用 `/api/admin-users`
- 强制刷新浏览器（Ctrl+Shift+R）

### 2. 注册时间显示 NaN
- 检查 `functions/api/[[path]].js` 中的 `handleAdminUsers` 是否将 `created_at` 映射为 `createdAt`

### 3. 重定向循环（ERR_TOO_MANY_REDIRECTS）
- 删除 `_redirects` 文件
- 删除 `functions/netdisk/[[path]].js`（不需要，Cloudflare Pages 默认支持无后缀 URL）

### 4. CONFIG.getApiBase is not a function
- 强制刷新浏览器清除缓存
- 确认 `config.js` 包含 `getApiBase()` 方法

## 更新部署

修改代码后推送到 GitHub，Cloudflare Pages 会自动重新部署（约 1-2 分钟）。
