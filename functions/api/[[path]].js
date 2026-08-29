/**
 * Cloud Netdisk - Cloudflare Pages Functions 通配路由
 * 处理 /api/* 的所有认证请求，数据存储在 D1 数据库
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 */

// ============ 工具函数 ============

function generateId() {
    return crypto.randomUUID();
}

function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成 6 位数字验证码
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

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
            iterations: 100000,
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

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 从请求中获取当前用户（通过 Bearer token）
async function getCurrentUser(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return null;

    const session = await env.DB.prepare(
        'SELECT * FROM sessions WHERE token = ?'
    ).bind(token).first();

    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) return null;

    const user = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(session.user_id).first();

    if (!user) return null;
    if (user.status === 'frozen' || user.status === 'deleted') return null;

    return user;
}

// 检查是否为管理员
function isAdmin(user) {
    return user && (user.role === 'admin' || user.role === 'superadmin');
}

// 检查是否为超级管理员
function isSuperAdmin(user) {
    return user && user.role === 'superadmin';
}

// ============ 主处理函数 ============

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    // 只处理 /api/* 路径
    if (!path.startsWith('/api/')) {
        return json({ error: 'Not found' }, 404);
    }

    const action = path.replace('/api/', '').split('/')[0];
    const method = request.method;

    try {
        switch (action) {
            case 'register':
                return await handleRegister(request, env);
            case 'login':
                return await handleLogin(request, env);
            case 'logout':
                return await handleLogout(request, env);
            case 'me':
                return await handleMe(request, env);
            case 'verify':
                return await handleVerify(request, env);
            case 'resend-code':
                return await handleResendCode(request, env);
            // ===== 管理员端点 =====
            case 'admin-users':
                return await handleAdminUsers(request, env);
            case 'admin-files':
                return await handleAdminFiles(request, env);
            case 'admin-files-grouped':
                return await handleAdminFilesGrouped(request, env);
            case 'admin-public-files':
                return await handleAdminPublicFiles(request, env);
            case 'admin-unfreeze-requests':
                return await handleAdminUnfreezeRequests(request, env);
            case 'admin-set-role':
                return await handleAdminSetRole(request, env);
            case 'admin-set-status':
                return await handleAdminSetStatus(request, env);
            case 'admin-delete-user':
                return await handleAdminDeleteUser(request, env);
            case 'admin-handle-unfreeze':
                return await handleAdminHandleUnfreeze(request, env);
            default:
                return json({ error: 'Unknown action' }, 404);
        }
    } catch (e) {
        return json({ error: e.message || 'Server error' }, 500);
    }
}

// ============ 注册 ============

async function handleRegister(request, env) {
    const body = await request.json();
    const { username, email, password } = body;

    if (!username || username.trim().length < 2) {
        return json({ error: '用户名至少需要 2 个字符' }, 400);
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: '请输入有效的邮箱地址' }, 400);
    }
    if (!password || password.length < 6) {
        return json({ error: '密码至少需要 6 个字符' }, 400);
    }

    const existing = await env.DB.prepare(
        'SELECT id, email FROM users WHERE email = ? OR username = ?'
    ).bind(email.trim(), username.trim()).first();

    if (existing) {
        return json({ error: existing.email === email.trim() ? '该邮箱已被注册' : '该用户名已被使用' }, 400);
    }

    const salt = await generateSalt();
    const passwordHash = await hashPassword(password, salt);
    const id = generateId();
    const createdAt = new Date().toISOString();
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await env.DB.prepare(
        'INSERT INTO users (id, username, email, password_hash, salt, role, status, verified, created_at, verification_code, verification_code_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, username.trim(), email.trim(), passwordHash, salt, 'user', 'active', 0, createdAt, verificationCode, verificationCodeExpiry).run();

    // 发送验证码邮件
    try {
        await sendVerificationEmail(env, email, verificationCode);
    } catch (e) {
        // 邮件发送失败不影响注册，但用户无法验证
        console.error('验证码邮件发送失败:', e);
    }

    return json({
        success: true,
        message: '注册成功！验证码已发送到你的邮箱。',
        user: { id, username: username.trim(), email: email.trim(), verified: false }
    });
}

// ============ 登录 ============

async function handleLogin(request, env) {
    const body = await request.json();
    const { email, password, rememberMe } = body;

    if (!email || !password) {
        return json({ error: '请输入邮箱和密码' }, 400);
    }

    const user = await env.DB.prepare(
        'SELECT id, username, email, password_hash, salt, role, status, verified FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        return json({ error: '邮箱或密码错误' }, 401);
    }

    const isValid = await verifyPassword(password, user.salt, user.password_hash);
    if (!isValid) {
        return json({ error: '邮箱或密码错误' }, 401);
    }

    if (!user.verified) {
        return json({ error: '请先验证邮箱后再登录' }, 403);
    }

    if (user.status === 'frozen') {
        return json({ error: '你的账户已被冻结，请联系管理员' }, 403);
    }
    if (user.status === 'deleted') {
        return json({ error: '该账户已注销，无法登录' }, 403);
    }

    const sessionDuration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionDuration).toISOString();

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const today = now.toISOString().split('T')[0];

    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();

    await env.DB.prepare(
        'INSERT INTO sessions (token, user_id, created_at, expires_at, remember_me, ip, last_login_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(token, user.id, now.toISOString(), expiresAt, rememberMe ? 1 : 0, ip, today).run();

    return json({
        success: true,
        token,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            verified: !!user.verified,
            role: user.role,
            status: user.status
        }
    });
}

// ============ 退出登录 ============

async function handleLogout(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '');

    if (token) {
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    }

    return json({ success: true });
}

// ============ 获取当前用户 ============

async function handleMe(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '');

    if (!token) {
        return json({ user: null });
    }

    const session = await env.DB.prepare(
        'SELECT * FROM sessions WHERE token = ?'
    ).bind(token).first();

    if (!session) {
        return json({ user: null });
    }

    if (new Date(session.expires_at) < new Date()) {
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return json({ user: null });
    }

    const user = await env.DB.prepare(
        'SELECT id, username, email, role, status, verified FROM users WHERE id = ?'
    ).bind(session.user_id).first();

    if (!user) {
        return json({ user: null });
    }

    if (user.status === 'frozen' || user.status === 'deleted') {
        return json({ user: null });
    }

    return json({
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            verified: !!user.verified,
            role: user.role,
            status: user.status
        }
    });
}

// ============ 邮箱验证（验证码） ============

async function handleVerify(request, env) {
    const body = await request.json();
    const { email, code } = body;

    if (!email) {
        return json({ error: '请输入邮箱地址' }, 400);
    }
    if (!code) {
        return json({ error: '请输入验证码' }, 400);
    }

    const user = await env.DB.prepare(
        'SELECT id, email, verified, verification_code, verification_code_expiry FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        return json({ error: '该邮箱未注册' }, 404);
    }

    if (user.verified) {
        return json({ error: '邮箱已验证，无需重复操作' }, 400);
    }

    if (!user.verification_code || user.verification_code !== code) {
        return json({ error: '验证码无效' }, 400);
    }

    if (user.verification_code_expiry && new Date(user.verification_code_expiry) < new Date()) {
        return json({ error: '验证码已过期，请重新获取' }, 400);
    }

    await env.DB.prepare(
        'UPDATE users SET verified = 1, verification_code = NULL, verification_code_expiry = NULL WHERE id = ?'
    ).bind(user.id).run();

    return json({ success: true, message: '邮箱验证成功！现在可以登录了。' });
}

// ============ 重新发送验证码 ============

async function handleResendCode(request, env) {
    const body = await request.json();
    const { email } = body;

    if (!email) {
        return json({ error: '请输入邮箱地址' }, 400);
    }

    const user = await env.DB.prepare(
        'SELECT id, email, verified FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        return json({ error: '该邮箱未注册' }, 404);
    }

    if (user.verified) {
        return json({ error: '邮箱已验证' }, 400);
    }

    const code = generateVerificationCode();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await env.DB.prepare(
        'UPDATE users SET verification_code = ?, verification_code_expiry = ? WHERE id = ?'
    ).bind(code, expiry, user.id).run();

    // 发送验证码邮件
    try {
        await sendVerificationEmail(env, email, code);
    } catch (e) {
        console.error('验证码邮件发送失败:', e);
    }

    return json({ success: true, message: '验证码已重新发送' });
}

// ============ 发送验证码邮件 ============

async function sendVerificationEmail(env, email, code) {
    const body = `验证你的邮箱

你的验证码是：${code}

验证码 10 分钟内有效，请勿泄露给他人。

此邮件由系统自动发送，请勿回复。`;

    // 通过 GitHub Actions 发送邮件
    const owner = 'a13621173445';
    const repo = 'cloud-netdisk';
    const token = env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GitHub Token 未配置');
    }
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            event_type: 'send-email',
            client_payload: {
                to: email,
                subject: '验证你的邮箱 - Cloud Netdisk',
                body: body
            }
        })
    });

    if (!response.ok && response.status !== 204) {
        throw new Error('邮件发送失败');
    }
}

// ============ 管理员：列出所有用户 ============

async function handleAdminUsers(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const { results } = await env.DB.prepare(
        'SELECT id, username, email, role, status, verified, created_at FROM users ORDER BY created_at DESC'
    ).all();

    // 将数据库字段名映射为前端使用的驼峰命名
    const users = results.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        verified: !!u.verified,
        createdAt: u.created_at
    }));

    return json({ users });
}

// ============ 管理员：列出所有文件 ============

async function handleAdminFiles(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    // 获取所有用户用于映射用户名
    const { results: users } = await env.DB.prepare(
        'SELECT id, username FROM users'
    ).all();
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u.username; });

    // 文件数据仍存储在 GitHub，这里返回空列表（文件管理后续迁移）
    return json({ files: [] });
}

// ============ 管理员：按用户分组的文件 ============

async function handleAdminFilesGrouped(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const { results: users } = await env.DB.prepare(
        'SELECT id, username FROM users ORDER BY username ASC'
    ).all();

    const groups = users.map(u => ({
        userId: u.id,
        username: u.username,
        fileCount: 0,
        files: []
    }));

    return json({ groups });
}

// ============ 管理员：列出公共文件 ============

async function handleAdminPublicFiles(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    return json({ files: [] });
}

// ============ 管理员：列出解冻申请 ============

async function handleAdminUnfreezeRequests(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const { results } = await env.DB.prepare(
        "SELECT id, username, email, role, status, unfreeze_reason, unfreeze_requested_at FROM users WHERE unfreeze_requested = 1"
    ).all();

    return json({ requests: results });
}

// ============ 管理员：设置角色（设为/取消管理员） ============

async function handleAdminSetRole(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isSuperAdmin(user)) return json({ error: '仅超级管理员可设置管理员角色' }, 403);

    const body = await request.json();
    const { userId, makeAdmin } = body;

    if (!userId) return json({ error: '缺少用户 ID' }, 400);
    if (typeof makeAdmin !== 'boolean') return json({ error: '参数错误' }, 400);
    if (user.id === userId) return json({ error: '不能修改自己的管理员角色' }, 400);

    const target = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.role === 'superadmin') return json({ error: '不能修改超级管理员的角色' }, 400);

    await env.DB.prepare(
        'UPDATE users SET role = ? WHERE id = ?'
    ).bind(makeAdmin ? 'admin' : 'user', userId).run();

    return json({ success: true, message: makeAdmin ? '已设置为管理员' : '已取消管理员' });
}

// ============ 管理员：设置用户状态（禁用/冻结/恢复） ============

async function handleAdminSetStatus(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const body = await request.json();
    const { userId, status, reason } = body;

    if (!userId || !status) return json({ error: '缺少必要参数' }, 400);
    const validStatuses = ['active', 'disabled', 'frozen'];
    if (!validStatuses.includes(status)) return json({ error: '无效的状态值' }, 400);
    if (user.id === userId) return json({ error: '不能操作自己的账户' }, 400);

    const target = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.role === 'superadmin') return json({ error: '不能操作超级管理员账户' }, 400);
    if (user.role === 'admin' && target.role !== 'user') return json({ error: '不能操作管理员账户' }, 400);

    await env.DB.prepare(
        'UPDATE users SET status = ?, status_reason = ?, status_updated_at = ?, status_updated_by = ? WHERE id = ?'
    ).bind(status, reason || '', new Date().toISOString(), user.username, userId).run();

    // 清除该用户的所有会话
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

    return json({ success: true, message: '用户状态已更新' });
}

// ============ 管理员：注销用户 ============

async function handleAdminDeleteUser(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const body = await request.json();
    const { userId } = body;

    if (!userId) return json({ error: '缺少用户 ID' }, 400);
    if (user.id === userId) return json({ error: '不能注销自己的账户' }, 400);

    const target = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.role === 'superadmin') return json({ error: '不能注销超级管理员账户' }, 400);
    if (user.role === 'admin' && target.role !== 'user') return json({ error: '不能注销管理员账户' }, 400);

    // 删除用户会话
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

    // 删除用户
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

    return json({ success: true, message: '用户已注销' });
}

// ============ 管理员：处理解冻申请 ============

async function handleAdminHandleUnfreeze(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const body = await request.json();
    const { userId, approve } = body;

    if (!userId) return json({ error: '缺少用户 ID' }, 400);
    if (typeof approve !== 'boolean') return json({ error: '参数错误' }, 400);

    const target = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.role === 'superadmin') return json({ error: '不能操作超级管理员账户' }, 400);
    if (user.role === 'admin' && target.role !== 'user') return json({ error: '不能操作管理员账户' }, 400);

    if (approve) {
        await env.DB.prepare(
            'UPDATE users SET status = ?, status_reason = ?, status_updated_at = ?, status_updated_by = ?, unfreeze_requested = 0, unfreeze_requested_at = NULL WHERE id = ?'
        ).bind('active', '', new Date().toISOString(), user.username, userId).run();
    } else {
        await env.DB.prepare(
            'UPDATE users SET unfreeze_requested = 0, unfreeze_requested_at = NULL WHERE id = ?'
        ).bind(userId).run();
    }

    return json({ success: true, message: approve ? '已批准解冻' : '已拒绝解冻申请' });
}
