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
 * UI 工具函数
 * 提供通用的 UI 交互、格式化、安全处理等功能
 */

const UI = {

    // ============ 消息提示 ============

    showMessage(text, type = 'info') {
        const container = document.getElementById('toast-container') || this.createToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icons = {
            success: '&#10003;',
            error: '&#10007;',
            info: '&#8505;',
            warning: '&#9888;'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-text">${this.escapeHtml(text)}</span>
        `;

        container.appendChild(toast);

        // 动画显示
        requestAnimationFrame(() => toast.classList.add('show'));

        // 3秒后自动消失
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    createToastContainer() {
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
        return container;
    },

    // ============ 加载提示 ============

    showLoading(text = '加载中...') {
        let overlay = document.getElementById('loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.className = 'loading-overlay';
            overlay.innerHTML = `
                <div class="loading-spinner"></div>
                <p class="loading-text">${this.escapeHtml(text)}</p>
            `;
            document.body.appendChild(overlay);
        } else {
            overlay.querySelector('.loading-text').textContent = text;
        }
        overlay.style.display = 'flex';
    },

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    },

    // ============ 格式化 ============

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';

        return date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
    },

    // ============ 安全处理 ============

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    },

    // ============ 文件图标 ============

    getFileIcon(type, name) {
        const ext = (name || '').split('.').pop().toLowerCase();
        const icons = {
            'pdf': '📄', 'doc': '📝', 'docx': '📝',
            'xls': '📊', 'xlsx': '📊',
            'ppt': '📑', 'pptx': '📑',
            'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'svg': '🖼️',
            'mp4': '🎬', 'avi': '🎬', 'mov': '🎬',
            'mp3': '🎵', 'wav': '🎵',
            'zip': '🗜️', 'rar': '🗜️', '7z': '🗜️',
            'txt': '📃', 'md': '📃',
            'js': '📜', 'json': '📜', 'html': '📜',
            'default': '📄'
        };
        return icons[ext] || icons['default'];
    },

    // ============ 权限检查 ============

    async checkAuth() {
        if (!(await CONFIG.isConfigured())) {
            window.location.href = 'login.html';
            return false;
        }

        const user = await Netdisk.getCurrentUser();
        if (!user) {
            window.location.href = 'login.html';
            return false;
        }
        return true;
    },

    checkAuthSync() {
        const user = Netdisk.getCurrentUserLocal();
        if (!user) {
            window.location.href = 'login.html';
            return null;
        }
        return user;
    },

    async checkConfig() {
        if (!(await CONFIG.isConfigured())) {
            window.location.href = 'login.html';
            return false;
        }
        return true;
    },

    // ============ URL 参数 ============

    getQueryParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    },

    // ============ 文件列表渲染 ============

    renderFileList(files, container) {
        if (!files || files.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📁</div>
                    <p>暂无文件，点击上方按钮上传</p>
                </div>
            `;
            return;
        }

        container.innerHTML = files.map(file => `
            <div class="file-card" data-id="${this.escapeHtml(file.id)}">
                <div class="file-icon">${this.getFileIcon(file.type, file.name)}</div>
                <div class="file-info">
                    <div class="file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</div>
                    <div class="file-meta">
                        ${this.formatFileSize(file.size)} · ${this.formatDate(file.uploadedAt)}
                        ${file.shared ? '<span class="badge-shared">已分享</span>' : ''}
                    </div>
                </div>
                <div class="file-actions">
                    <button class="btn-icon" onclick="App.downloadFile('${this.escapeHtml(file.id)}')" title="下载">⬇</button>
                    <button class="btn-icon" onclick="App.shareFile('${this.escapeHtml(file.id)}')" title="分享">🔗</button>
                    <button class="btn-icon btn-danger" onclick="App.deleteFile('${this.escapeHtml(file.id)}')" title="删除"><span class="btn-icon-x">✕</span></button>
                </div>
            </div>
        `).join('');
    },

    // ============ 全局分享文件列表渲染 ============

    renderGlobalFileList(files, container, currentUserId) {
        if (!files || files.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🌐</div>
                    <p>公共分享区暂无文件，点击上方按钮上传</p>
                </div>
            `;
            return;
        }

        container.innerHTML = files.map(file => {
            const isOwner = file.ownerId === currentUserId;
            return `
                <div class="file-card" data-id="${this.escapeHtml(file.id)}">
                    <div class="file-icon">${this.getFileIcon(file.type, file.name)}</div>
                    <div class="file-info">
                        <div class="file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</div>
                        <div class="file-meta">
                            ${this.formatFileSize(file.size)} · ${this.escapeHtml(file.ownerName || '未知用户')} · 分享于 ${this.formatDate(file.shareCreatedAt || file.uploadedAt)} · 访问 ${file.shareViewCount || 0} 次 · 下载 ${file.shareDownloadCount || 0} 次
                            <span class="badge-shared">公共</span>
                        </div>
                    </div>
                    <div class="file-actions">
                        <button class="btn-icon" onclick="App.downloadFile('${this.escapeHtml(file.id)}')" title="下载">⬇</button>
                        ${isOwner ? `<button class="btn-icon btn-danger" onclick="App.deleteFile('${this.escapeHtml(file.id)}')" title="删除"><span class="btn-icon-x">✕</span></button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    },

    // ============ 我的分享列表渲染 ============

    renderShareList(shares, container) {
        if (!shares || shares.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🔗</div>
                    <p>暂无分享，回到「我的文件」点击分享按钮即可创建分享</p>
                </div>
            `;
            return;
        }

        container.innerHTML = shares.map(s => {
            const shareTime = this.formatDate(s.shareCreatedAt || s.uploadedAt);
            const viewText = `访问 ${s.shareViewCount || 0} 次`;
            const downloadText = s.shareMaxDownloads === -1
                ? `下载 ${s.shareDownloadCount || 0} 次`
                : `下载 ${s.shareDownloadCount || 0}/${s.shareMaxDownloads} 次`;
            const expireText = s.shareExpireDays === -1 ? '永久有效' : `${s.shareExpireDays} 天`;
            return `
                <div class="file-card" data-id="${this.escapeHtml(s.id)}">
                    <div class="file-icon">${this.getFileIcon(s.type, s.name)}</div>
                    <div class="file-info">
                        <div class="file-name" title="${this.escapeHtml(s.name)}">${this.escapeHtml(s.name)}</div>
                        <div class="file-meta">${this.formatFileSize(s.size)} · ${this.escapeHtml(s.ownerName || '未知用户')} · 分享于 ${shareTime} · ${viewText} · ${downloadText} · ${expireText}</div>
                        <div class="share-link-box">
                            <input type="text" value="${this.escapeHtml(s.shareUrl)}" readonly onclick="this.select()">
                            <button class="btn btn-primary btn-sm" onclick="App.copyShareInput(this)">复制</button>
                        </div>
                    </div>
                    <div class="file-actions">
                        <button class="btn btn-secondary btn-sm" onclick="App.revokeShare('${this.escapeHtml(s.id)}')">取消分享</button>
                    </div>
                </div>
            `;
        }).join('');
    },

    // ============ 强制下载（不预览） ============

    /**
     * 通过 fetch + Blob 强制下载文件，避免浏览器预览（图片/PDF/文本也会直接下载）
     * @param {string} url - 文件直链
     * @param {string} filename - 下载文件名
     */
    async forceDownload(url, filename) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('下载失败: ' + response.status);
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
    },

    // ============ 复制到剪贴板 ============

    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showMessage('已复制到剪贴板', 'success');
        } catch (e) {
            // 降级方案
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
            this.showMessage('已复制到剪贴板', 'success');
        }
    },

    // ============ 页面内确认弹窗（替代浏览器 confirm） ============

    /**
     * 显示页面内确认弹窗
     * @param {string} message - 提示信息
     * @param {string} title - 弹窗标题（默认"确认操作"）
     * @param {string} confirmText - 确认按钮文字（默认"确认"）
     * @param {string} cancelText - 取消按钮文字（默认"取消"）
     * @returns {Promise<boolean>} - 用户点击确认返回 true，取消返回 false
     */
    confirm(message, title = '确认操作', confirmText = '确认', cancelText = '取消') {
        return new Promise((resolve) => {
            // 创建遮罩层
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay confirm-overlay';
            overlay.style.display = 'flex';

            overlay.innerHTML = `
                <div class="modal confirm-modal">
                    <h3>${this.escapeHtml(title)}</h3>
                    <div class="modal-body">
                        <p class="confirm-message">${this.escapeHtml(message)}</p>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary btn-sm confirm-cancel-btn">${this.escapeHtml(cancelText)}</button>
                        <button class="btn btn-primary btn-sm confirm-ok-btn">${this.escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const cleanup = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector('.confirm-ok-btn').addEventListener('click', () => cleanup(true));
            overlay.querySelector('.confirm-cancel-btn').addEventListener('click', () => cleanup(false));

            // 点击遮罩层空白处取消
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cleanup(false);
            });

            // 按 Esc 取消
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', escHandler);
                    cleanup(false);
                }
            };
            document.addEventListener('keydown', escHandler);
        });
    }
};