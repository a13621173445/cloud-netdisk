/**
 * GitHub Netdisk
 * Copyright (C) 2026 a13621173445
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * GitHub Netdisk 配置文件
 * 
 * 部署步骤：
 * 1. 修改下方 GITHUB_OWNER 为你的 GitHub 用户名
 * 2. 修改 REPO_NAME 为你的仓库名
 * 3. 修改 PAGES_BASE_URL 为你的 GitHub Pages 地址
 * 4. 修改 TOKEN_KEY / TOKEN_IV / TOKEN_CIPHER 为你的 GitHub Token 的 AES 加密值
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

    // ============ GitHub Token（AES 加密存储） ============
    // Token 使用 AES-256-GCM 加密后存储，运行时解密
    // 生成方式：用工具将你的 GitHub Token 用 AES-256 加密，得到 KEY/IV/CIPHER
    // 需要权限：repo (或 fine-grained: Contents Read/Write + Actions Write)
    TOKEN_KEY: '0rUB9QYYYJR7cZPqDU6GUcdoXQ3a5ly5OHieXbGqARY=',
    TOKEN_IV: 'y+3jz6FJ9pX5orXW',
    TOKEN_CIPHER: 'DfO7CLM2jPxdR1A8foaPr7fXlqy0vkcX29cGHy0ueImW5/I+Xbc0aMvjdr6+NOLXsJk0+I+ZZGA=',

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
    PUBLIC_STORAGE_DIR: 'netdisk/public_storage',

    // ============ Token 管理 ============
    // Token 使用 AES-256 加密存储在 TOKEN_KEY/TOKEN_IV/TOKEN_CIPHER 中
    // 运行时通过 Web Crypto API 解密

    // Base64 转 Uint8Array
    _base64ToBytes(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    },

    // 解密 Token（AES-256-GCM）
    async _decryptToken() {
        try {
            const keyBytes = this._base64ToBytes(this.TOKEN_KEY);
            const ivBytes = this._base64ToBytes(this.TOKEN_IV);
            const cipherBytes = this._base64ToBytes(this.TOKEN_CIPHER);

            const key = await crypto.subtle.importKey(
                'raw',
                keyBytes,
                { name: 'AES-GCM' },
                false,
                ['decrypt']
            );

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: ivBytes },
                key,
                cipherBytes
            );

            return new TextDecoder().decode(decrypted);
        } catch (e) {
            console.error('Token 解密失败:', e);
            return '';
        }
    },

    // 获取 Token（异步解密）
    async getToken() {
        if (this._cachedToken) return this._cachedToken;
        this._cachedToken = await this._decryptToken();
        return this._cachedToken;
    },

    // ============ 动态配置 ============
    getOwner() {
        return this.GITHUB_OWNER;
    },

    getRepo() {
        return this.REPO_NAME;
    },

    getPagesUrl() {
        // 优先使用配置的 PAGES_BASE_URL（部署时设置的正确地址）
        if (this.PAGES_BASE_URL && this.PAGES_BASE_URL !== 'https://USERNAME.github.io/REPO_NAME') {
            return this.PAGES_BASE_URL;
        }
        // 最后动态推导当前页面基础 URL
        const path = window.location.pathname;
        const basePath = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
        return window.location.origin + basePath;
    },

    // 获取 Cloudflare Pages Functions API 基础地址（同源 /api）
    getApiBase() {
        return window.location.origin;
    },

    // 检查是否已配置完成（异步）
    async isConfigured() {
        const owner = this.getOwner();
        const repo = this.getRepo();
        const token = await this.getToken();
        return owner && owner !== 'YOUR_GITHUB_USERNAME' && repo && repo !== '' && token !== '';
    },

    // 获取 API 请求头（异步）
    async getAuthHeaders() {
        const token = await this.getToken();
        return {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': this.API_VERSION,
            'Content-Type': 'application/json'
        };
    }
};
