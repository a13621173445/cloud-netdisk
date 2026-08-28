# GitHub Netdisk - 基于 GitHub 的网盘系统

一个完全运行在 GitHub 上的轻量级网盘系统，使用 GitHub 仓库作为文件存储，GitHub Actions 发送邮件，GitHub Pages 托管前端。

## 功能特性

- **用户注册/登录** - 邮箱+密码注册，PBKDF2 哈希存储（100,000 次迭代 + 随机盐）
- **邮箱验证** - 注册后发送验证邮件，点击链接激活账号
- **密码管理** - 支持修改密码、忘记密码重置（邮件链接重置）
- **文件存储** - 文件直接存储在 GitHub 仓库中
- **文件上传** - 支持拖拽上传，最大 50MB
- **文件下载** - 强制下载（不预览），通过 raw URL + Blob 实现
- **私人分享** - 生成分享链接，可设有效期/下载次数上限，任何人可通过链接下载
- **公共分享区** - 公共文件单独存储，所有登录用户可见、可下载
- **我的分享** - 集中管理自己创建的分享，可复制链接、取消分享
- **追踪统计** - 显示分享时间、访问次数、下载次数
- **管理后台** - 用户管理、文件管理（按用户分组）、公共管理、解冻申请

## 技术架构

```
┌─────────────────────────────────────────────┐
│              浏览器（用户端）                  │
│  纯 HTML/JS/CSS → GitHub Pages 托管          │
├─────────────┬───────────────────────────────┤
│  GitHub API │  Repository Dispatch API       │
│  (文件读写)  │  (触发邮件发送 Action)          │
├─────────────┼───────────────────────────────┤
│             ▼                                │
│  GitHub 仓库（存储层）                         │
│  ├── netdisk/data/users.json     用户数据    │
│  ├── netdisk/data/files.json     文件元数据   │
│  ├── netdisk/data/sessions.json  会话数据    │
│  ├── netdisk/storage/            私人文件    │
│  └── netdisk/public_storage/     公共文件    │
├─────────────────────────────────────────────┤
│  GitHub Actions（后端）                       │
│  └── send-email.yml     邮件发送工作流        │
└─────────────────────────────────────────────┘
```

## 部署步骤

### 1. 创建仓库

将本项目代码推送到你的 GitHub 仓库（可以 Fork 或直接上传）。

### 2. 启用 GitHub Pages

进入仓库 **Settings → Pages**，选择 `Deploy from a branch`，分支选 `main`，目录选 `/ (root)`，保存。

### 3. 配置邮件 Secrets

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，依次添加以下密钥：

| Secret 名称 | 说明 | 示例值 |
|---|---|---|
| `SMTP_SERVER` | SMTP 服务器地址 | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP 端口 | `465` |
| `SMTP_USERNAME` | SMTP 用户名（邮箱） | `you@gmail.com` |
| `SMTP_PASSWORD` | SMTP 密码/授权码 | `your-app-password` |
| `SMTP_FROM` | 发件人邮箱 | `you@gmail.com` |

> **Gmail 用户注意**：需要使用「应用专用密码」而非账号密码。在 Google 账户设置中开启两步验证后生成应用专用密码。

### 4. 生成 GitHub Token

1. 访问 [GitHub Token 生成页](https://github.com/settings/tokens)
2. 点击 **Generate new token (classic)**
3. 勾选 `repo` 权限（完整仓库访问）
4. 生成并复制 Token

### 5. 初始化配置（修改 js 文件）

本项目通过直接修改 `netdisk/js/config.js` 文件完成初始化配置。

打开 `netdisk/js/config.js`，修改以下字段：

```js
const CONFIG = {
    GITHUB_OWNER: '你的GitHub用户名',            // 改为你的 GitHub 用户名
    REPO_NAME: 'github-netdisk',                 // 改为你的仓库名
    PAGES_BASE_URL: 'https://你的域名/netdisk',   // 改为你的 Pages 地址
    TOKEN_KEY: '...',   // 你的 Token 的 AES 密钥（Base64）
    TOKEN_IV: '...',    // 你的 Token 的 AES 初始化向量（Base64）
    TOKEN_CIPHER: '...' // 你的 Token 的 AES 密文（Base64）
};
```

其中 Token 使用 AES-256-GCM 加密后分别填入 `TOKEN_KEY` / `TOKEN_IV` / `TOKEN_CIPHER`，避免明文 Token 泄露。可在浏览器控制台运行以下代码生成加密值：

```js
// 在浏览器控制台执行，生成 Token 的 AES 加密值
async function encryptToken(token) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(token));
    const b64 = (b) => btoa(String.fromCharCode(...b));
    return {
        TOKEN_KEY: b64(new Uint8Array(key)),
        TOKEN_IV: b64(new Uint8Array(iv)),
        TOKEN_CIPHER: b64(new Uint8Array(cipher))
    };
}
encryptToken('你的GitHubToken').then(console.log);
```

修改完成后，将代码推送到 GitHub 仓库即可生效。

### 6. 开始使用

- 注册账号 → 收到验证码邮件 → 输入验证码完成验证 → 登录 → 上传/分享文件

## 项目结构

```
github-netdisk/
├── index.html              # 入口页（跳转到 netdisk/）
├── LICENSE                 # AGPL-3.0 许可证
├── README.md               # 说明文档
├── .nojekyll               # 禁用 GitHub Pages Jekyll 处理
├── .github/workflows/
│   └── send-email.yml      # 邮件发送 GitHub Action
└── netdisk/
    ├── index.html          # 主页（文件管理仪表盘）
    ├── login.html          # 登录页
    ├── register.html       # 注册页
    ├── verify.html         # 邮箱验证页
    ├── reset.html          # 密码重置请求页
    ├── reset-confirm.html  # 设置新密码页
    ├── shared.html         # 分享文件下载页（公开）
    ├── account.html        # 账户设置页
    ├── admin.html          # 管理后台
    ├── eula.html           # 用户协议
    ├── sponsor.html        # 赞助页
    ├── css/
    │   └── style.css       # 全局样式
    ├── js/
    │   ├── config.js       # 配置文件
    │   ├── github.js       # GitHub API 封装
    │   ├── netdisk.js      # 核心业务逻辑
    │   └── ui.js           # UI 工具函数
    ├── img/                # 图片资源
    ├── data/               # 数据文件（运行时自动管理）
    └── storage/            # 文件存储目录（运行时自动管理）
```

## 安全说明

> **此项目为个人/演示用途设计，存在以下安全限制，请知悉：**

1. **密码哈希存储**：密码使用 PBKDF2 (SHA-256, 100,000 次迭代) + 随机盐哈希后存储在 `data/users.json` 中。哈希不可逆，无法从存储数据还原原始密码。
2. **Token 暴露**：GitHub Token 以 AES-256-GCM 加密后存储在 `js/config.js` 中（`TOKEN_KEY`/`TOKEN_IV`/`TOKEN_CIPHER`），但解密密钥也在前端代码中，仍可被逆向还原，并非真正安全。建议使用 Fine-grained PAT 并仅授予目标仓库的 `Contents: Read and Write` 权限，或使用私有仓库托管。
3. **API 速率限制**：GitHub API 有速率限制（认证用户 5000 次/小时），高并发场景可能触发限制。
4. **无加密传输**：文件以 Base64 编码存储在仓库中，无额外加密。

如需生产环境使用，建议：
- 引入后端服务代理 API 调用，避免 Token 暴露
- 文件加密后存储
- 限制注册用户数量

## API 速率限制

| 操作类型 | 预计 API 调用次数 |
|---|---|
| 注册 | 2-3 次（读+写+dispatch） |
| 登录 | 2 次（读 users + 读 sessions） |
| 上传文件 | 2 次（写文件+写元数据） |
| 列出文件 | 1 次 |
| 下载文件 | 1 次 |
| 分享文件 | 1 次 |

## 常见问题

**Q: 文件大小限制是多少？**
A: 最大 50MB。GitHub Contents API 支持到 100MB，为稳定性限制为 50MB。

**Q: 仓库空间有限制吗？**
A: GitHub 建议仓库不超过 1GB，硬限制 5GB。大量大文件建议使用 Git LFS 或其他存储方案。

**Q: 邮件发送延迟怎么办？**
A: GitHub Actions 有冷启动时间，邮件通常在 10-30 秒内送达。如长时间未收到，检查 Actions 运行日志。

**Q: 可以多个用户同时使用吗？**
A: 可以，但并发写入同一数据文件时可能有冲突。系统已内置 3 次重试机制。

## 技术栈

- **前端**：纯 HTML/CSS/JavaScript（无框架依赖）
- **存储**：GitHub Repository Contents API
- **邮件**：GitHub Actions + dawidd6/action-send-mail
- **托管**：GitHub Pages

## 许可证（License）

本项目采用 [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 许可。

这意味着你可以自由地使用、修改和分发本项目，但必须遵守以下条件：

- **必须开源**：如果你修改并分发本项目（或基于它构建的作品），必须以相同的 AGPL-3.0 许可证开源你的修改。
- **网络服务同样开源**：如果你将修改后的版本作为网络服务（如网盘、SaaS）运行，也必须向使用该服务的用户提供源代码。
- **保留版权声明**：保留原有的版权和许可声明。
- **无担保**：本项目按「现状」提供，不提供任何明示或暗示的担保。

完整许可证文本见项目根目录的 [`LICENSE`](./LICENSE) 文件。

> 注意：AGPL-3.0 允许商业使用和收费，但要求衍生作品和网络服务必须开源。