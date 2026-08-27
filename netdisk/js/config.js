/**
 * GitHub Netdisk 配置文件
 *
 * 部署步骤：
 * 1. 修改下方 GITHUB_OWNER 为你的 GitHub 用户名
 * 2. 修改 REPO_NAME 为你的仓库名
 * 3. 修改 PAGES_BASE_URL 为你的 GitHub Pages 地址
 * 4. 访问 setup.html 配置 GitHub Token
 * 5. 在 GitHub 仓库 Settings > Secrets 中配置 SMTP 邮件密钥
 */

const CONFIG = {
    // ============ 基础配置（部署时修改） ============
    GITHUB_OWNER: 'a13621173445',
    REPO_NAME: 'github-netdisk',
    BRANCH: 'main',

    // GitHub Pages 地址（用于生成验证链接、分享链接等）
    // 格式: https://USERNAME.github.io/REPO_NAME
    PAGES_BASE_URL: 'https://frpz.cc/netdisk',

    // ============ 内部配置（一般不需要修改） ============
    API_BASE: 'https://api.github.com',
    API_VERSION: '2022-11-28',

    // 数据文件路径（相对于仓库根目录，网盘文件在 netdisk/ 子目录）
    DATA: {
        USERS: 'netdisk/data/users.json',
        FILES: 'netdisk/data/files.json',
        SESSIONS: 'netdisk/data/sessions.json'
    },

    // 文件存储目录（相对于仓库根目录）
    STORAGE_DIR: 'netdisk/storage',

    // ============ Token 管理 ============
    // Token 存储在 localStorage 中，通过 setup.html 页面输入
    // 需要权限：repo (或 fine-grained: Contents Read/Write + Actions Write)

    getToken() {
        return localStorage.getItem('netdisk_token') || '';
    },

    setToken(token) {
        localStorage.setItem('netdisk_token', token);
    },

    clearToken() {
        localStorage.removeItem('netdisk_token');
    },

    // ============ 动态配置（支持通过 setup 页面修改） ============
    getOwner() {
        return localStorage.getItem('netdisk_owner') || this.GITHUB_OWNER;
    },

    getRepo() {
        return localStorage.getItem('netdisk_repo') || this.REPO_NAME;
    },

    getPagesUrl() {
        const custom = localStorage.getItem('netdisk_pages_url');
        if (custom) return custom;
        // 动态推导当前页面基础 URL
        const path = window.location.pathname;
        const basePath = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
        return window.location.origin + basePath;
    },

    setDynamicConfig(owner, repo, pagesUrl) {
        localStorage.setItem('netdisk_owner', owner);
        localStorage.setItem('netdisk_repo', repo);
        if (pagesUrl) localStorage.setItem('netdisk_pages_url', pagesUrl);
    },

    // 检查是否已配置完成
    isConfigured() {
        const owner = this.getOwner();
        const repo = this.getRepo();
        const token = this.getToken();
        return owner && owner !== 'YOUR_GITHUB_USERNAME' && repo && repo !== '' && token !== '';
    },

    // 获取 API 请求头
    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.getToken()}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': this.API_VERSION,
            'Content-Type': 'application/json'
        };
    }
};