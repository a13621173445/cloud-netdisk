/**
 * Cloud Netdisk
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
 * GitHub API 封装层
 * 提供文件读写、邮件触发等核心 API 操作
 */

// UTF-8 字符串与 Base64 互转（处理中文等非 ASCII 字符）
function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(b64) {
    try {
        return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
    } catch (e) {
        // 降级处理
        return atob(b64.replace(/\n/g, ''));
    }
}

// 文件转 Base64（用于二进制文件上传）
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const GitHubAPI = {

    // ============ 基础请求 ============

    async request(method, path, body) {
        const owner = CONFIG.getOwner();
        const repo = CONFIG.getRepo();
        const url = `${CONFIG.API_BASE}/repos/${owner}/${repo}${path}`;

        const options = {
            method: method,
            headers: await CONFIG.getAuthHeaders()
        };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        // 处理速率限制
        if (response.status === 403) {
            const remaining = response.headers.get('X-RateLimit-Remaining');
            if (remaining === '0') {
                const reset = response.headers.get('X-RateLimit-Reset');
                const resetTime = new Date(parseInt(reset) * 1000);
                throw new Error(`API 速率限制，请在 ${resetTime.toLocaleTimeString()} 后重试`);
            }
        }

        return response;
    },

    // ============ 文件读取 ============

    /**
     * 获取文件内容和 SHA
     * @returns { content, sha, encoding } 或 null（文件不存在时）
     */
    async getContent(path) {
        // 添加时间戳参数绕过 CDN 缓存，确保读取到最新数据
        const cacheBuster = Date.now();
        const response = await this.request('GET', `/contents/${path}?ref=${CONFIG.BRANCH}&t=${cacheBuster}`);

        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`读取文件失败: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            content: data.content,
            sha: data.sha,
            encoding: data.encoding,
            size: data.size,
            downloadUrl: data.download_url
        };
    },

    /**
     * 获取 JSON 文件并解析
     * @returns { data, sha } 或 { data: null, sha: null }（文件不存在时）
     */
    async getJsonData(path) {
        const result = await this.getContent(path);
        if (!result) {
            return { data: null, sha: null };
        }
        try {
            const json = JSON.parse(base64ToUtf8(result.content));
            return { data: json, sha: result.sha };
        } catch (e) {
            return { data: null, sha: result.sha };
        }
    },

    // ============ 文件写入 ============

    /**
     * 创建或更新文件
     * @param {string} path - 文件路径
     * @param {string} base64Content - Base64 编码的内容
     * @param {string} message - 提交信息
     * @param {string|null} sha - 已有文件的 SHA（更新时需要）
     */
    async createOrUpdateFile(path, base64Content, message, sha) {
        const body = {
            message: message,
            content: base64Content,
            branch: CONFIG.BRANCH
        };
        if (sha) {
            body.sha = sha;
        }

        const response = await this.request('PUT', `/contents/${path}`, body);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`写入文件失败: ${err.message || response.statusText}`);
        }

        return response.json();
    },

    /**
     * 创建或更新 JSON 文件（自动编码）
     */
    async createOrUpdateJson(path, data, message, sha) {
        const content = utf8ToBase64(JSON.stringify(data, null, 2));
        return this.createOrUpdateFile(path, content, message, sha);
    },

    /**
     * 带重试的 JSON 文件更新（处理并发冲突）
     * @param {string} path - JSON 文件路径
     * @param {function} updater - 接收当前 JSON，返回更新后的 JSON
     * @param {string} message - 提交信息
     */
    async updateJsonData(path, updater, message) {
        const maxRetries = 3;
        let lastError = null;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const { data, sha } = await this.getJsonData(path);
                const currentData = data || {};
                const updatedData = updater(currentData);

                await this.createOrUpdateJson(path, updatedData, message, sha);
                return updatedData;
            } catch (error) {
                lastError = error;
                const msg = error.message || '';
                // SHA 冲突（409 或 "does not match"）= 并发修改，等待后重试
                const isConflict = msg.includes('409') || msg.includes('does not match') || msg.includes('sha') && msg.includes('match');
                if (isConflict && i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                    continue;
                }
                // 文件不存在（404），直接创建
                if (msg.includes('404')) {
                    const newData = updater({});
                    await this.createOrUpdateJson(path, newData, message, null);
                    return newData;
                }
                throw error;
            }
        }

        throw lastError || new Error('更新数据失败，请重试');
    },

    // ============ 文件删除 ============

    async deleteFile(path, message, sha) {
        const body = {
            message: message,
            sha: sha,
            branch: CONFIG.BRANCH
        };

        const response = await this.request('DELETE', `/contents/${path}`, body);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`删除文件失败: ${err.message || response.statusText}`);
        }

        return response.json();
    },

    // ============ 触发 GitHub Actions ============

    /**
     * 触发 repository_dispatch 事件
     * 用于触发邮件发送等后端操作
     */
    async dispatchEvent(eventType, payload) {
        const body = {
            event_type: eventType,
            client_payload: payload
        };

        const response = await this.request('POST', `/dispatches`, body);

        if (!response.ok && response.status !== 204) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`触发 Actions 失败: ${err.message || response.statusText}`);
        }

        return true;
    },

    // ============ 获取原始文件 URL ============

    getRawUrl(path) {
        const owner = CONFIG.getOwner();
        const repo = CONFIG.getRepo();
        return `https://raw.githubusercontent.com/${owner}/${repo}/${CONFIG.BRANCH}/${path}`;
    },

    // ============ 获取文件列表 ============

    /**
     * 列出指定目录下的文件
     */
    async listDirectory(path) {
        const response = await this.request('GET', `/contents/${path}?ref=${CONFIG.BRANCH}`);

        if (response.status === 404) {
            return [];
        }
        if (!response.ok) {
            throw new Error(`列出目录失败: ${response.statusText}`);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : [data];
    },

    // ============ 获取用户信息（验证 Token 有效性） ============

    async getUser() {
        const token = await CONFIG.getToken();
        const response = await fetch(`${CONFIG.API_BASE}/user`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json'
            }
        });

        if (!response.ok) {
            throw new Error('Token 无效或已过期');
        }

        return response.json();
    }
};

/**
 * 对象存储（rains3 S3 兼容）代理层
 * 文件二进制读写走同源 /api/storage/*，由 Pages Function 完成 SigV4 签名
 * 文件元数据（files.json）仍由 GitHubAPI 负责
 */
const StorageAPI = {

    // 携带登录会话令牌的请求头
    _authHeaders(extra) {
        const headers = Object.assign({}, extra || {});
        const token = localStorage.getItem('netdisk_session');
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    },

    // 上传文件（请求体为原始二进制，必须带 Content-Type）
    async upload(key, file) {
        const response = await fetch(`${CONFIG.getStorageBase()}/upload?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: this._authHeaders({ 'Content-Type': (file && file.type) || 'application/octet-stream' }),
            body: file
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `上传失败: ${response.status}`);
        }
        return result;
    },

    // 服务端复制对象
    async copy(from, to) {
        const response = await fetch(
            `${CONFIG.getStorageBase()}/copy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            { method: 'POST', headers: this._authHeaders({ 'Content-Type': 'application/json' }) }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `复制失败: ${response.status}`);
        }
        return result;
    },

    // 删除对象
    async remove(key) {
        const response = await fetch(`${CONFIG.getStorageBase()}/delete?key=${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: this._authHeaders()
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `删除失败: ${response.status}`);
        }
        return result;
    },

    // 登录用户下载地址（令牌由 UI.forceDownload 自动附加）
    downloadUrl(key, name) {
        return `${CONFIG.getStorageBase()}/download?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name || '')}`;
    },

    // 公开分享下载地址（凭 shareToken 校验，无需登录）
    sharedUrl(token, name) {
        return `${CONFIG.getStorageBase()}/shared?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name || '')}`;
    }
};
