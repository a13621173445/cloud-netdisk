/**
 * GitHub Netdisk 核心业务逻辑
 * 包含：注册/登录/会话/邮箱验证/密码重置/文件管理/文件分享
 */

// ============ 工具函数 ============

function generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ============ 密码哈希（PBKDF2 + SHA-256） ============

const PBKDF2_ITERATIONS = 100000;

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return bytesToHex(array);
}

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: hexToBytes(salt),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        256
    );

    return bytesToHex(new Uint8Array(derivedBits));
}

async function verifyPassword(password, salt, storedHash) {
    const hash = await hashPassword(password, salt);
    return hash === storedHash;
}

const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7天
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// ============ Netdisk 核心 ============

const Netdisk = {

    // ============ 用户注册 ============

    async register(username, email, password) {
        // 参数校验
        if (!username || username.trim().length < 2) {
            throw new Error('用户名至少需要 2 个字符');
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new Error('请输入有效的邮箱地址');
        }
        if (!password || password.length < 6) {
            throw new Error('密码至少需要 6 个字符');
        }

        // 检查邮箱/用户名是否已存在
        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (data && data.users) || [];

        if (users.some(u => u.email === email)) {
            throw new Error('该邮箱已被注册');
        }
        if (users.some(u => u.username === username)) {
            throw new Error('该用户名已被使用');
        }

        // 哈希密码后存储（PBKDF2 + 随机盐）
        const salt = await generateSalt();
        const passwordHash = await hashPassword(password, salt);
        const verificationToken = generateToken();
        const newUser = {
            id: generateId(),
            username: username.trim(),
            email: email.trim(),
            passwordHash: passwordHash,
            salt: salt,
            role: 'user',           // 角色: user / admin
            status: 'active',       // 状态: active / disabled / frozen / deleted
            verified: false,
            verificationToken: verificationToken,
            resetToken: null,
            resetTokenExpiry: null,
            createdAt: new Date().toISOString()
        };

        // 写入用户数据
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                data.users.push(newUser);
                return data;
            },
            `新用户注册: ${username}`
        );

        // 发送验证邮件
        try {
            await this.sendVerificationEmail(email, verificationToken);
        } catch (e) {
            // 邮件发送失败不影响注册
            console.warn('验证邮件发送失败:', e);
        }

        return {
            success: true,
            message: '注册成功！请查收验证邮件完成验证。',
            user: { id: newUser.id, username: newUser.username, email: newUser.email, verified: false }
        };
    },

    // ============ 发送验证邮件 ============

    async sendVerificationEmail(email, token) {
        const verifyUrl = `${CONFIG.getPagesUrl()}/verify.html?token=${token}`;
        const body = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #4F46E5;">验证你的邮箱地址</h2>
                <p>感谢注册 GitHub Netdisk！请点击下方按钮验证你的邮箱：</p>
                <a href="${verifyUrl}" style="display: inline-block; background: #4F46E5; color: #fff; padding: 12px 32px; text-decoration: none; border-radius: 6px; margin: 16px 0;">验证邮箱</a>
                <p style="color: #666; font-size: 14px;">或复制此链接到浏览器：<br>${verifyUrl}</p>
                <hr style="border: none; border-top: 1px solid #eee;">
                <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿回复。</p>
            </div>
        `;

        await GitHubAPI.dispatchEvent('send-email', {
            to: email,
            subject: '验证你的邮箱地址 - GitHub Netdisk',
            body: body
        });
    },

    // ============ 邮箱验证 ============

    async verifyEmail(token) {
        if (!token) throw new Error('验证令牌无效');

        let verifiedUser = null;

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const user = data.users.find(u => u.verificationToken === token);
                if (!user) throw new Error('验证令牌无效或已使用');
                if (user.verified) throw new Error('邮箱已验证，无需重复操作');
                user.verified = true;
                user.verificationToken = null;
                verifiedUser = user;
                return data;
            },
            '邮箱验证完成'
        );

        return { success: true, message: '邮箱验证成功！现在可以登录了。' };
    },

    // ============ 用户登录 ============

    async login(email, password) {
        if (!email || !password) throw new Error('请输入邮箱和密码');

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (data && data.users) || [];

        const user = users.find(u => u.email === email);
        if (!user) throw new Error('邮箱或密码错误');
        const isValid = await verifyPassword(password, user.salt, user.passwordHash);
        if (!isValid) throw new Error('邮箱或密码错误');
        if (!user.verified) throw new Error('请先验证邮箱后再登录');

        // 检查账户状态
        const status = user.status || 'active';
        if (status === 'disabled') throw new Error('该账户已被禁用，请联系管理员');
        if (status === 'frozen') throw new Error('该账户已被冻结，请联系管理员');
        if (status === 'deleted') throw new Error('该账户已注销，无法登录');

        // 创建会话
        const sessionToken = generateToken();
        const session = {
            token: sessionToken,
            userId: user.id,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + SESSION_DURATION).toISOString()
        };

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.SESSIONS,
            (data) => {
                if (!data.sessions) data.sessions = [];
                // 清理旧会话
                data.sessions = data.sessions.filter(s => s.userId !== user.id || new Date(s.expiresAt) > new Date());
                data.sessions.push(session);
                return data;
            },
            `用户登录: ${user.username}`
        );

        // 本地存储会话
        localStorage.setItem('netdisk_session', sessionToken);
        localStorage.setItem('netdisk_user', JSON.stringify({
            id: user.id,
            username: user.username,
            email: user.email,
            verified: user.verified,
            role: user.role || 'user',
            status: status
        }));

        return {
            success: true,
            token: sessionToken,
            user: { id: user.id, username: user.username, email: user.email, verified: user.verified, role: user.role || 'user', status: status }
        };
    },

    // ============ 退出登录 ============

    async logout() {
        const token = localStorage.getItem('netdisk_session');
        if (token) {
            try {
                await GitHubAPI.updateJsonData(
                    CONFIG.DATA.SESSIONS,
                    (data) => {
                        if (!data.sessions) data.sessions = [];
                        data.sessions = data.sessions.filter(s => s.token !== token);
                        return data;
                    },
                    '用户退出登录'
                );
            } catch (e) {
                // 即使服务端清理失败也清除本地状态
            }
        }
        localStorage.removeItem('netdisk_session');
        localStorage.removeItem('netdisk_user');
    },

    // ============ 获取当前用户 ============

    getCurrentUserLocal() {
        const userJson = localStorage.getItem('netdisk_user');
        if (!userJson) return null;
        try {
            return JSON.parse(userJson);
        } catch (e) {
            return null;
        }
    },

    async getCurrentUser() {
        const token = localStorage.getItem('netdisk_session');
        if (!token) return null;

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.SESSIONS);
        const sessions = (data && data.sessions) || [];
        const session = sessions.find(s => s.token === token);

        if (!session) {
            this.logout();
            return null;
        }

        if (new Date(session.expiresAt) < new Date()) {
            this.logout();
            return null;
        }

        // 获取用户信息
        const usersData = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (usersData.data && usersData.data.users) || [];
        const user = users.find(u => u.id === session.userId);

        if (!user) {
            this.logout();
            return null;
        }

        // 检查账户状态，非 active 状态强制登出
        const status = user.status || 'active';
        if (status !== 'active') {
            this.logout();
            return null;
        }

        return {
            id: user.id,
            username: user.username,
            email: user.email,
            verified: user.verified,
            role: user.role || 'user',
            status: status
        };
    },

    // ============ 密码重置请求 ============

    async requestPasswordReset(email) {
        if (!email) throw new Error('请输入邮箱地址');

        const resetToken = generateToken();
        const resetExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30分钟有效

        let userEmail = null;

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const user = data.users.find(u => u.email === email);
                if (!user) throw new Error('该邮箱未注册');
                user.resetToken = resetToken;
                user.resetTokenExpiry = resetExpiry;
                userEmail = user.email;
                return data;
            },
            '密码重置请求'
        );

        // 发送重置邮件
        const resetUrl = `${CONFIG.getPagesUrl()}/reset-confirm.html?token=${resetToken}`;
        const body = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #4F46E5;">重置你的密码</h2>
                <p>我们收到了你的密码重置请求。请点击下方按钮设置新密码：</p>
                <a href="${resetUrl}" style="display: inline-block; background: #4F46E5; color: #fff; padding: 12px 32px; text-decoration: none; border-radius: 6px; margin: 16px 0;">重置密码</a>
                <p style="color: #666; font-size: 14px;">或复制此链接到浏览器：<br>${resetUrl}</p>
                <p style="color: #999; font-size: 12px;">此链接 30 分钟内有效。如非本人操作请忽略此邮件。</p>
            </div>
        `;

        await GitHubAPI.dispatchEvent('send-email', {
            to: email,
            subject: '重置密码 - GitHub Netdisk',
            body: body
        });

        return { success: true, message: '密码重置邮件已发送，请查收邮箱。' };
    },

    // ============ 确认密码重置 ============

    async resetPassword(token, newPassword) {
        if (!token) throw new Error('重置令牌无效');
        if (!newPassword || newPassword.length < 6) throw new Error('密码至少需要 6 个字符');

        const salt = await generateSalt();
        const passwordHash = await hashPassword(newPassword, salt);

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const user = data.users.find(u => u.resetToken === token);
                if (!user) throw new Error('重置令牌无效或已使用');
                if (new Date(user.resetTokenExpiry) < new Date()) throw new Error('重置链接已过期，请重新申请');

                user.passwordHash = passwordHash;
                user.salt = salt;
                user.resetToken = null;
                user.resetTokenExpiry = null;
                return data;
            },
            '密码重置完成'
        );

        return { success: true, message: '密码重置成功！请使用新密码登录。' };
    },

    // ============ 修改密码（已登录） ============

    async changePassword(oldPassword, newPassword) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        if (!oldPassword || !newPassword) throw new Error('请输入旧密码和新密码');
        if (newPassword.length < 6) throw new Error('新密码至少需要 6 个字符');

        // 先读取用户数据验证旧密码
        const { data: usersData } = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (usersData && usersData.users) || [];
        const user = users.find(u => u.id === currentUser.id);
        if (!user) throw new Error('用户不存在');
        const isValid = await verifyPassword(oldPassword, user.salt, user.passwordHash);
        if (!isValid) throw new Error('旧密码错误');

        // 哈希新密码
        const newSalt = await generateSalt();
        const newPasswordHash = await hashPassword(newPassword, newSalt);

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const u = data.users.find(u => u.id === currentUser.id);
                if (!u) throw new Error('用户不存在');
                u.passwordHash = newPasswordHash;
                u.salt = newSalt;
                return data;
            },
            '修改密码'
        );

        return { success: true, message: '密码修改成功！' };
    },

    // ============ 文件上传 ============

    async uploadFile(file) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        if (file.size > MAX_FILE_SIZE) {
            throw new Error(`文件大小超过限制（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`);
        }

        const fileId = generateId();
        const safeName = sanitizeFilename(file.name);
        const filePath = `${CONFIG.STORAGE_DIR}/${fileId}_${safeName}`;

        // 转为 Base64 并上传
        const base64Content = await fileToBase64(file);
        await GitHubAPI.createOrUpdateFile(filePath, base64Content, `上传文件: ${file.name}`, null);

        // 记录文件元数据
        const fileMeta = {
            id: fileId,
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
            path: filePath,
            ownerId: currentUser.id,
            shared: false,
            shareToken: null,
            uploadedAt: new Date().toISOString()
        };

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                data.files.push(fileMeta);
                return data;
            },
            `文件元数据: ${file.name}`
        );

        return { success: true, file: fileMeta };
    },

    // ============ 获取文件列表 ============

    async listFiles() {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        return files.filter(f => f.ownerId === currentUser.id);
    },

    // ============ 下载文件 ============

    async downloadFile(fileId) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        const file = files.find(f => f.id === fileId && f.ownerId === currentUser.id);

        if (!file) throw new Error('文件不存在或无权访问');

        // 使用 raw URL 下载
        const rawUrl = GitHubAPI.getRawUrl(file.path);
        return { url: rawUrl, name: file.name, type: file.type };
    },

    // ============ 删除文件 ============

    async deleteFile(fileId) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        let deletedFile = null;

        // 先获取文件信息
        const { data, sha } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        deletedFile = files.find(f => f.id === fileId && f.ownerId === currentUser.id);

        if (!deletedFile) throw new Error('文件不存在或无权操作');

        // 删除存储的文件
        const fileInfo = await GitHubAPI.getContent(deletedFile.path);
        if (fileInfo) {
            await GitHubAPI.deleteFile(deletedFile.path, `删除文件: ${deletedFile.name}`, fileInfo.sha);
        }

        // 删除文件元数据
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                data.files = data.files.filter(f => f.id !== fileId);
                return data;
            },
            `删除文件元数据: ${deletedFile.name}`
        );

        return { success: true, message: '文件已删除' };
    },

    // ============ 创建分享链接 ============

    async createShareLink(fileId) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        const shareToken = generateToken();
        let updatedFile = null;

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                const file = data.files.find(f => f.id === fileId && f.ownerId === currentUser.id);
                if (!file) throw new Error('文件不存在或无权操作');
                file.shared = true;
                file.shareToken = shareToken;
                updatedFile = file;
                return data;
            },
            `创建分享链接: ${fileId}`
        );

        const shareUrl = `${CONFIG.getPagesUrl()}/shared.html?token=${shareToken}`;
        return { success: true, shareUrl: shareUrl, shareToken: shareToken };
    },

    // ============ 取消分享 ============

    async revokeShare(fileId) {
        const currentUser = this.getCurrentUserLocal();
        if (!currentUser) throw new Error('请先登录');

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                const file = data.files.find(f => f.id === fileId && f.ownerId === currentUser.id);
                if (!file) throw new Error('文件不存在或无权操作');
                file.shared = false;
                file.shareToken = null;
                return data;
            },
            `取消分享: ${fileId}`
        );

        return { success: true, message: '分享已取消' };
    },

    // ============ 获取分享文件信息（公开访问） ============

    async getSharedFile(shareToken) {
        if (!shareToken) throw new Error('分享链接无效');

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        const file = files.find(f => f.shareToken === shareToken && f.shared === true);

        if (!file) throw new Error('分享链接无效或已被取消');

        const rawUrl = GitHubAPI.getRawUrl(file.path);
        return {
            name: file.name,
            size: file.size,
            type: file.type,
            url: rawUrl,
            uploadedAt: file.uploadedAt
        };
    },

    // ============ 重新发送验证邮件 ============

    async resendVerification(email) {
        if (!email) throw new Error('请输入邮箱地址');

        const newToken = generateToken();

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const user = data.users.find(u => u.email === email);
                if (!user) throw new Error('该邮箱未注册');
                if (user.verified) throw new Error('邮箱已验证');
                user.verificationToken = newToken;
                return data;
            },
            '重新发送验证邮件'
        );

        await this.sendVerificationEmail(email, newToken);

        return { success: true, message: '验证邮件已重新发送' };
    },

    // ============ 管理员功能 ============

    // 检查当前用户是否为管理员
    isAdmin() {
        const user = this.getCurrentUserLocal();
        return user && user.role === 'admin';
    },

    // 管理员权限守卫
    requireAdmin() {
        if (!this.isAdmin()) {
            throw new Error('无管理员权限');
        }
    },

    // 创建管理员账户（仅当系统中还没有管理员时可用）
    async createAdminAccount(username, email, password) {
        if (!username || username.trim().length < 2) throw new Error('用户名至少需要 2 个字符');
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的邮箱地址');
        if (!password || password.length < 6) throw new Error('密码至少需要 6 个字符');

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (data && data.users) || [];

        // 检查是否已有管理员
        if (users.some(u => u.role === 'admin')) {
            throw new Error('系统中已存在管理员账户');
        }
        if (users.some(u => u.email === email)) {
            throw new Error('该邮箱已被注册');
        }

        const salt = await generateSalt();
        const passwordHash = await hashPassword(password, salt);
        const adminUser = {
            id: generateId(),
            username: username.trim(),
            email: email.trim(),
            passwordHash: passwordHash,
            salt: salt,
            role: 'admin',
            status: 'active',
            verified: true,          // 管理员自动验证
            verificationToken: null,
            resetToken: null,
            resetTokenExpiry: null,
            createdAt: new Date().toISOString()
        };

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                data.users.push(adminUser);
                return data;
            },
            `创建管理员账户: ${username}`
        );

        return { success: true, message: '管理员账户创建成功', user: { id: adminUser.id, username: adminUser.username, email: adminUser.email, role: 'admin' } };
    },

    // 查看所有用户（管理员）
    async adminListUsers() {
        this.requireAdmin();
        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (data && data.users) || [];
        return users.map(u => ({
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role || 'user',
            status: u.status || 'active',
            verified: u.verified,
            createdAt: u.createdAt
        }));
    },

    // 查看所有文件（管理员）
    async adminListFiles() {
        this.requireAdmin();
        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        // 获取用户名映射
        const usersData = await GitHubAPI.getJsonData(CONFIG.DATA.USERS);
        const users = (usersData.data && usersData.data.users) || [];
        const userMap = {};
        users.forEach(u => userMap[u.id] = u.username);

        return files.map(f => ({
            id: f.id,
            name: f.name,
            size: f.size,
            type: f.type,
            ownerId: f.ownerId,
            ownerName: userMap[f.ownerId] || '未知用户',
            shared: f.shared,
            status: f.status || 'normal',   // normal / taken_down
            uploadedAt: f.uploadedAt
        }));
    },

    // 下架文件（管理员） - 取消分享并标记为下架
    async adminTakeDownFile(fileId) {
        this.requireAdmin();
        let updatedFile = null;

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                const file = data.files.find(f => f.id === fileId);
                if (!file) throw new Error('文件不存在');
                file.shared = false;
                file.shareToken = null;
                file.status = 'taken_down';
                updatedFile = file;
                return data;
            },
            `管理员下架文件: ${fileId}`
        );

        return { success: true, message: '文件已下架', file: updatedFile };
    },

    // 恢复文件（管理员） - 取消下架状态
    async adminRestoreFile(fileId) {
        this.requireAdmin();
        let updatedFile = null;

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                const file = data.files.find(f => f.id === fileId);
                if (!file) throw new Error('文件不存在');
                file.status = 'normal';
                updatedFile = file;
                return data;
            },
            `管理员恢复文件: ${fileId}`
        );

        return { success: true, message: '文件已恢复', file: updatedFile };
    },

    // 删除文件（管理员） - 删除任意用户的文件
    async adminDeleteFile(fileId) {
        this.requireAdmin();
        let deletedFile = null;

        const { data } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (data && data.files) || [];
        deletedFile = files.find(f => f.id === fileId);
        if (!deletedFile) throw new Error('文件不存在');

        // 删除存储的文件
        const fileInfo = await GitHubAPI.getContent(deletedFile.path);
        if (fileInfo) {
            await GitHubAPI.deleteFile(deletedFile.path, `管理员删除文件: ${deletedFile.name}`, fileInfo.sha);
        }

        // 删除文件元数据
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                data.files = data.files.filter(f => f.id !== fileId);
                return data;
            },
            `管理员删除文件元数据: ${deletedFile.name}`
        );

        return { success: true, message: '文件已删除' };
    },

    // 禁用用户（管理员） - 禁止登录
    async adminDisableUser(userId) {
        this.requireAdmin();
        await this._setUserStatus(userId, 'disabled', '禁用');
        return { success: true, message: '用户已禁用' };
    },

    // 冻结用户（管理员） - 禁止登录，保留数据
    async adminFreezeUser(userId) {
        this.requireAdmin();
        await this._setUserStatus(userId, 'frozen', '冻结');
        return { success: true, message: '用户已冻结' };
    },

    // 注销用户（管理员） - 删除账户及所有文件
    async adminDeleteUser(userId) {
        this.requireAdmin();
        const currentUser = this.getCurrentUserLocal();
        if (currentUser.id === userId) throw new Error('不能注销自己的账户');

        // 删除该用户的所有文件
        const { data: filesData } = await GitHubAPI.getJsonData(CONFIG.DATA.FILES);
        const files = (filesData && filesData.files) || [];
        const userFiles = files.filter(f => f.ownerId === userId);

        for (const file of userFiles) {
            try {
                const fileInfo = await GitHubAPI.getContent(file.path);
                if (fileInfo) {
                    await GitHubAPI.deleteFile(file.path, `注销用户删除文件: ${file.name}`, fileInfo.sha);
                }
            } catch (e) {
                // 忽略单个文件删除失败
            }
        }

        // 删除用户文件元数据
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.FILES,
            (data) => {
                if (!data.files) data.files = [];
                data.files = data.files.filter(f => f.ownerId !== userId);
                return data;
            },
            `注销用户删除文件元数据`
        );

        // 删除用户会话
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.SESSIONS,
            (data) => {
                if (!data.sessions) data.sessions = [];
                data.sessions = data.sessions.filter(s => s.userId !== userId);
                return data;
            },
            `注销用户删除会话`
        );

        // 删除用户账户
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                data.users = data.users.filter(u => u.id !== userId);
                return data;
            },
            `注销用户账户`
        );

        return { success: true, message: '用户已注销，账户及所有文件已删除' };
    },

    // 内部工具：设置用户状态
    async _setUserStatus(userId, status, label) {
        const currentUser = this.getCurrentUserLocal();
        if (currentUser.id === userId) throw new Error(`不能${label}自己的账户`);

        await GitHubAPI.updateJsonData(
            CONFIG.DATA.USERS,
            (data) => {
                if (!data.users) data.users = [];
                const user = data.users.find(u => u.id === userId);
                if (!user) throw new Error('用户不存在');
                if (user.role === 'admin') throw new Error(`不能${label}管理员账户`);
                user.status = status;
                return data;
            },
            `管理员${label}用户: ${userId}`
        );

        // 清除该用户的所有会话
        await GitHubAPI.updateJsonData(
            CONFIG.DATA.SESSIONS,
            (data) => {
                if (!data.sessions) data.sessions = [];
                data.sessions = data.sessions.filter(s => s.userId !== userId);
                return data;
            },
            `管理员${label}用户清除会话`
        );
    }
};
