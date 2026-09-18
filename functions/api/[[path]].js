/**
 * Cloud Netdisk - Cloudflare Pages Functions 通配路由
 * 处理 /api/* 的所有认证请求，数据存储在 D1 数据库
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 */

// Cloudflare Workers 的 TCP 连接能力（用于 SMTP 发送邮件）
import { connect } from 'cloudflare:sockets';

// UTF-8 安全的 base64 编码（替代 Node.js 的 Buffer）
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

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
            case 'request-unfreeze':
                return await handleRequestUnfreeze(request, env);
            case 'change-email':
                return await handleChangeEmail(request, env);
            case 'change-password':
                return await handleChangePassword(request, env);
            case 'request-reset':
                return await handleRequestReset(request, env);
            case 'reset-password':
                return await handleResetPassword(request, env);
            case 'auto-login':
                return await handleAutoLogin(request, env);
            case 'send-delete-code':
                return await handleSendDeleteCode(request, env);
            case 'delete-account':
                return await handleDeleteAccount(request, env);
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
    if (!email || !/[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
        // 邮件发送失败：删除刚注册的用户，并返回真实错误，避免用户误以为注册成功
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
        console.error('验证码邮件发送失败:', e);
        return json({ error: `验证码邮件发送失败：${e.message}，请稍后重试` }, 500);
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
        return json({ error: `验证码邮件发送失败：${e.message}，请稍后重试` }, 500);
    }

    return json({ success: true, message: '验证码已重新发送' });
}

// ============ 申请解冻 ============

async function handleRequestUnfreeze(request, env) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const body = await request.json();
    const { reason } = body;

    if (reason && reason.length > 500) return json({ error: '申请原因不能超过 500 字' }, 400);

    const status = user.status || 'active';
    if (status === 'active') return json({ error: '账户状态正常，无需申请解冻' }, 400);
    if (status === 'deleted') return json({ error: '账户已注销，无法申请解冻' }, 400);

    await env.DB.prepare(
        'UPDATE users SET unfreeze_requested = 1, unfreeze_requested_at = ?, unfreeze_reason = ? WHERE id = ?'
    ).bind(new Date().toISOString(), reason || '', user.id).run();

    return json({ success: true, message: '解冻申请已提交，请等待管理员处理' });
}

// ============ 修改邮箱（已登录） ============

async function handleChangeEmail(request, env) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const body = await request.json();
    const { newEmail, password } = body;

    if (!newEmail || !/[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return json({ error: '请输入有效的邮箱地址' }, 400);
    }
    if (!password) return json({ error: '请输入当前密码以确认操作' }, 400);

    // 验证密码
    const fullUser = await env.DB.prepare(
        'SELECT id, username, email, password_hash, salt, role, status FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (!fullUser) return json({ error: '用户不存在' }, 404);

    const isValid = await verifyPassword(password, fullUser.salt, fullUser.password_hash);
    if (!isValid) return json({ error: '密码错误' }, 400);

    // 检查新邮箱是否已被其他用户使用
    const existing = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ? AND id != ?'
    ).bind(newEmail.trim(), user.id).first();
    if (existing) return json({ error: '该邮箱已被其他用户使用' }, 400);

    // 生成新邮箱的验证码
    const code = generateVerificationCode();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 更新邮箱并重置验证状态
    await env.DB.prepare(
        'UPDATE users SET email = ?, verified = 0, verification_code = ?, verification_code_expiry = ? WHERE id = ?'
    ).bind(newEmail.trim(), code, expiry, user.id).run();

    // 发送新邮箱验证码
    try {
        await sendVerificationEmail(env, newEmail.trim(), code);
    } catch (e) {
        // 邮件发送失败：回滚邮箱修改
        await env.DB.prepare(
            'UPDATE users SET email = ?, verified = 1, verification_code = NULL, verification_code_expiry = NULL WHERE id = ?'
        ).bind(fullUser.email, user.id).run();
        console.error('验证码邮件发送失败:', e);
        return json({ error: `验证码邮件发送失败：${e.message}，请稍后重试` }, 500);
    }

    return json({ success: true, message: '邮箱修改成功！请查收验证邮件完成新邮箱验证。' });
}

// ============ 发送注销验证码 ============

async function handleSendDeleteCode(request, env) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const fullUser = await env.DB.prepare(
        'SELECT id, username, email, role, status FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (!fullUser) return json({ error: '用户不存在' }, 404);

    // 超级管理员不能注销自己
    if (fullUser.role === 'superadmin') return json({ error: '超级管理员不能注销自己的账户' }, 400);

    const code = generateVerificationCode();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await env.DB.prepare(
        'UPDATE users SET delete_account_code = ?, delete_account_code_expiry = ? WHERE id = ?'
    ).bind(code, expiry, user.id).run();

    // 发送注销验证码
    try {
        await sendVerificationEmail(env, fullUser.email, code);
    } catch (e) {
        console.error('注销验证码邮件发送失败:', e);
        return json({ error: `注销验证码邮件发送失败：${e.message}，请稍后重试` }, 500);
    }

    return json({ success: true, message: '注销验证码已发送到你的邮箱' });
}

// ============ 注销自己的账户 ============

async function handleDeleteAccount(request, env) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const body = await request.json();
    const { password, code } = body;

    if (!password) return json({ error: '请输入当前密码' }, 400);
    if (!code) return json({ error: '请输入邮箱验证码' }, 400);

    const fullUser = await env.DB.prepare(
        'SELECT id, username, email, password_hash, salt, role, status, delete_account_code, delete_account_code_expiry FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (!fullUser) return json({ error: '用户不存在' }, 404);

    // 超级管理员不能注销自己
    if (fullUser.role === 'superadmin') return json({ error: '超级管理员不能注销自己的账户' }, 400);
    // 冻结状态不能注销
    if (fullUser.status === 'frozen') return json({ error: '账户已被冻结，无法注销，请先联系管理员解冻' }, 400);

    // 第一重确认：验证密码
    const isValid = await verifyPassword(password, fullUser.salt, fullUser.password_hash);
    if (!isValid) return json({ error: '密码错误' }, 400);

    // 第二重确认：验证注销验证码
    if (!fullUser.delete_account_code || fullUser.delete_account_code !== code) {
        return json({ error: '验证码错误' }, 400);
    }
    if (fullUser.delete_account_code_expiry && new Date(fullUser.delete_account_code_expiry) < new Date()) {
        return json({ error: '验证码已过期，请重新获取' }, 400);
    }

    // 删除用户会话
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();

    // 删除用户
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

    return json({ success: true, message: '账户已注销，所有数据已删除' });
}

// ============ 修改密码（已登录） ============

async function handleChangePassword(request, env) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const body = await request.json();
    const { oldPassword, newPassword } = body;

    if (!oldPassword || !newPassword) {
        return json({ error: '请输入旧密码和新密码' }, 400);
    }
    if (newPassword.length < 6) {
        return json({ error: '新密码至少需要 6 个字符' }, 400);
    }

    const dbUser = await env.DB.prepare(
        'SELECT id, password_hash, salt FROM users WHERE id = ?'
    ).bind(user.id).first();

    if (!dbUser) {
        return json({ error: '用户不存在' }, 404);
    }

    const isValid = await verifyPassword(oldPassword, dbUser.salt, dbUser.password_hash);
    if (!isValid) {
        return json({ error: '旧密码错误' }, 400);
    }

    const newSalt = await generateSalt();
    const newPasswordHash = await hashPassword(newPassword, newSalt);

    await env.DB.prepare(
        'UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'
    ).bind(newPasswordHash, newSalt, user.id).run();

    // 修改密码后清除该用户的所有旧会话，强制重新登录
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();

    return json({ success: true, message: '密码修改成功，请重新登录。' });
}

// ============ 密码重置请求 ============

// 确保 users 表包含 reset_token / reset_token_expiry 列（线上 D1 需运行时迁移）
async function ensureUsersSchema(env) {
    const { results } = await env.DB.prepare('PRAGMA table_info(users)').all();
    const cols = results.map(r => r.name);

    if (!cols.includes('reset_token')) {
        await env.DB.prepare('ALTER TABLE users ADD COLUMN reset_token TEXT').run();
    }
    if (!cols.includes('reset_token_expiry')) {
        await env.DB.prepare('ALTER TABLE users ADD COLUMN reset_token_expiry TEXT').run();
    }
}

async function handleRequestReset(request, env) {
    const body = await request.json();
    const { email } = body;

    if (!email || !/[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: '请输入有效的邮箱地址' }, 400);
    }

    await ensureUsersSchema(env);

    const user = await env.DB.prepare(
        'SELECT id, email, verified FROM users WHERE email = ?'
    ).bind(email.trim()).first();

    if (!user) {
        return json({ error: '该邮箱未注册' }, 404);
    }
    if (!user.verified) {
        return json({ error: '邮箱未验证，请先完成邮箱验证后再重置密码' }, 400);
    }

    const resetToken = generateToken();
    const resetExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 分钟有效

    await env.DB.prepare(
        'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?'
    ).bind(resetToken, resetExpiry, user.id).run();

    // 用请求来源生成重置链接（https://frpz.cc 或 pages.dev）
    const origin = new URL(request.url).origin;
    const resetUrl = `${origin}/netdisk/reset-confirm?token=${resetToken}`;

    const resetBodyContent = `重置你的密码\n\n我们收到了你的密码重置请求。请在 30 分钟内打开以下链接设置新密码：\n\n${resetUrl}\n\n如果这不是你本人的操作，请忽略此邮件。\n\n此邮件由系统自动发送，请勿回复。`;

    try {
        await smtpSend(env, email.trim(), '重置密码 - Cloud Netdisk', resetBodyContent);
    } catch (e) {
        // 邮件发送失败：清除重置令牌，避免留下无效的过期令牌
        await env.DB.prepare('UPDATE users SET reset_token = NULL, reset_token_expiry = NULL WHERE id = ?').bind(user.id).run();
        console.error('密码重置邮件发送失败:', e);
        return json({ error: `密码重置邮件发送失败：${e.message}，请稍后重试` }, 500);
    }

    return json({ success: true, message: '密码重置邮件已发送，请查收邮箱。' });
}

// ============ 确认密码重置 ============

async function handleResetPassword(request, env) {
    const body = await request.json();
    const { token, newPassword } = body;

    if (!token) {
        return json({ error: '重置令牌无效' }, 400);
    }
    if (!newPassword || newPassword.length < 6) {
        return json({ error: '密码至少需要 6 个字符' }, 400);
    }

    await ensureUsersSchema(env);

    const user = await env.DB.prepare(
        'SELECT id, reset_token, reset_token_expiry FROM users WHERE reset_token = ?'
    ).bind(token).first();

    if (!user) {
        return json({ error: '重置令牌无效或已使用' }, 400);
    }
    if (!user.reset_token_expiry || new Date(user.reset_token_expiry) < new Date()) {
        return json({ error: '重置链接已过期，请重新申请' }, 400);
    }

    const salt = await generateSalt();
    const passwordHash = await hashPassword(newPassword, salt);

    await env.DB.prepare(
        'UPDATE users SET password_hash = ?, salt = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?'
    ).bind(passwordHash, salt, user.id).run();

    // 重置成功后清除该用户的所有会话，强制使用新密码登录
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();

    return json({ success: true, message: '密码重置成功！请使用新密码登录。' });
}

// ============ 自动登录（同一天同一 IP） ============

async function handleAutoLogin(request, env) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!ip) {
        return json({ success: false });
    }

    const today = new Date().toISOString().split('T')[0];

    const { results: sessions } = await env.DB.prepare(
        'SELECT token, user_id, expires_at FROM sessions WHERE ip = ? AND last_login_date = ? ORDER BY created_at DESC'
    ).bind(ip, today).all();

    for (const session of sessions) {
        if (new Date(session.expires_at) < new Date()) continue;

        const user = await env.DB.prepare(
            'SELECT id, username, email, role, status, verified FROM users WHERE id = ?'
        ).bind(session.user_id).first();

        if (!user || user.status !== 'active') continue;

        return json({
            success: true,
            token: session.token,
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

    return json({ success: false });
}

// ============ 发送验证码邮件（原生 SMTP，无需 GitHub Actions） ============

// SMTP 客户端：通过 Cloudflare Workers 的 connect() 建立 TCP 连接
// 支持 STARTTLS 和隐式 TLS（SSL）两种方式
async function smtpSend(env, to, subject, textBody) {
    const server = env.SMTP_SERVER;
    const port = parseInt(env.SMTP_PORT || '465', 10);
    const username = env.SMTP_USERNAME;
    const password = env.SMTP_PASSWORD;
    const from = env.SMTP_FROM;

    if (!server || !username || !password || !from) {
        throw new Error('SMTP 配置不完整，请检查 SMTP_SERVER/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/SMTP_FROM 环境变量');
    }

    // 隐式 TLS（SSL）端口：465；STARTTLS 端口：587 或 25
    const useImplicitTls = port === 465;

    // 建立 TCP 连接（隐式 TLS 直接在 connect 时启用 tls）
    let socket = connect({ hostname: server, port, ...(useImplicitTls ? { tls: true } : {}) });

    // 响应读取状态
    let buffer = '';
    let pendingResolve = null;
    let pendingReject = null;

    const waitForResponse = () => new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
    });

    // 启动读取循环（每次 TLS 升级后需重新调用）
    const startReaderLoop = (sock) => {
        const reader = sock.readable.getReader();
        const decoder = new TextDecoder();
        (async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    // SMTP 响应以 \r\n 结尾
                    while (buffer.includes('\r\n')) {
                        const idx = buffer.indexOf('\r\n');
                        const line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        if (pendingResolve) {
                            const resolve = pendingResolve;
                            pendingResolve = null;
                            resolve(line);
                        }
                    }
                }
            } catch (e) {
                if (pendingReject) {
                    pendingReject(e);
                    pendingReject = null;
                }
            }
        })();
    };

    startReaderLoop(socket);

    let writer = socket.writable.getWriter();
    const encoder = new TextEncoder();

    const sendCommand = async (cmd) => {
        await writer.write(encoder.encode(cmd + '\r\n'));
        return await waitForResponse();
    };

    const check = (line, expectedPrefix, errMsg) => {
        if (!line.startsWith(expectedPrefix)) {
            throw new Error(`${errMsg}（服务器响应：${line}）`);
        }
    };

    try {
        // 读取服务器欢迎信息
        const greeting = await waitForResponse();
        check(greeting, '220', 'SMTP 服务器连接失败');

        // 如果使用 STARTTLS（非 465 端口），先升级为 TLS
        if (!useImplicitTls) {
            const ehlo1 = await sendCommand('EHLO cloud-netdisk');
            check(ehlo1, '250', 'EHLO 失败');
            const starttls = await sendCommand('STARTTLS');
            check(starttls, '220', 'STARTTLS 失败');

            // 升级连接为 TLS（socket.startTls() 是 Socket 实例方法），重新绑定 reader 和 writer
            socket = await socket.startTls();
            buffer = '';
            startReaderLoop(socket);
            writer = socket.writable.getWriter();

            const ehlo2 = await sendCommand('EHLO cloud-netdisk');
            check(ehlo2, '250', 'EHLO 失败');
        } else {
            const ehlo = await sendCommand('EHLO cloud-netdisk');
            check(ehlo, '250', 'EHLO 失败');
        }

        // 认证
        const auth = await sendCommand('AUTH LOGIN');
        check(auth, '334', 'SMTP 认证失败');
        const userResp = await sendCommand(utf8ToBase64(username));
        check(userResp, '334', 'SMTP 用户名认证失败');
        const passResp = await sendCommand(utf8ToBase64(password));
        check(passResp, '235', 'SMTP 密码认证失败（请检查授权码）');

        // 发件人
        const mailFrom = await sendCommand('MAIL FROM:<' + from + '>');
        check(mailFrom, '250', 'MAIL FROM 失败');

        // 收件人
        const rcptTo = await sendCommand('RCPT TO:<' + to + '>');
        check(rcptTo, '250', '收件人地址被拒绝');

        // 数据
        const data = await sendCommand('DATA');
        check(data, '354', 'DATA 命令失败');

        // 邮件内容（RFC 5322 格式）
        const message = [
            'From: Cloud Netdisk <' + from + '>',
            'To: <' + to + '>',
            'Subject: =?UTF-8?B?' + utf8ToBase64(subject) + '?=',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            utf8ToBase64(textBody)
        ].join('\r\n');

        await writer.write(encoder.encode(message + '\r\n.\r\n'));
        const doneResp = await waitForResponse();
        check(doneResp, '250', '邮件内容发送失败');

        // 退出
        await sendCommand('QUIT');
    } finally {
        try { writer.releaseLock(); } catch (e) {}
        try { socket.close(); } catch (e) {}
    }
}

async function sendVerificationEmail(env, email, code) {
    const body = `验证你的邮箱\n\n你的验证码是：${code}\n\n验证码 10 分钟内有效，请勿泄露给他人。\n\n此邮件由系统自动发送，请勿回复。`;

    await smtpSend(env, email, '验证你的邮箱 - Cloud Netdisk', body);
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

// Base64 解码（Cloudflare Workers 提供 atob，但为 UTF-8 安全使用 TextDecoder）
function base64Decode(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

// 从 GitHub 仓库读取 JSON 数据文件（files.json 尚未迁移到 D1）
async function fetchGithubJson(env, path) {
    const owner = env.GITHUB_OWNER || 'a13621173445';
    const repo = env.GITHUB_REPO || 'cloud-netdisk';
    const token = env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('缺少 GITHUB_TOKEN 环境变量');
    }

    const resp = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path + '?ref=main', {
        headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!resp.ok) {
        throw new Error('读取 GitHub 文件失败（' + resp.status + '）');
    }

    const data = await resp.json();
    return JSON.parse(base64Decode(data.content));
}

async function handleAdminFiles(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    // 获取所有用户用于映射用户名
    const { results: users } = await env.DB.prepare(
        'SELECT id, username FROM users'
    ).all();
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u.username; });

    // 文件元数据仍存储在 GitHub files.json，通过 GitHub API 读取
    try {
        const data = await fetchGithubJson(env, 'netdisk/data/files.json');
        const files = (data && data.files) || [];

        return json({
            files: files.map(f => ({
                ...f,
                ownerName: userMap[f.ownerId] || '未知用户'
            }))
        });
    } catch (e) {
        console.error('管理员读取文件列表失败:', e);
        return json({ files: [], error: e.message });
    }
}

// ============ 管理员：按用户分组的文件 ============

async function handleAdminFilesGrouped(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    try {
        const data = await fetchGithubJson(env, 'netdisk/data/files.json');
        const files = (data && data.files) || [];

        const { results: users } = await env.DB.prepare(
            'SELECT id, username FROM users ORDER BY username ASC'
        ).all();

        const ownedIds = new Set(users.map(u => u.id));
        const groups = users.map(u => {
            const userFiles = files.filter(f => f.ownerId === u.id && !f.isGlobal);
            return {
                userId: u.id,
                username: u.username,
                fileCount: userFiles.length,
                files: userFiles.map(f => ({ ...f, ownerName: u.username }))
            };
        });

        // 文件所有者不在 D1 用户表中（旧数据遗留），归入"未知用户"分组
        const orphanFiles = files.filter(f => !ownedIds.has(f.ownerId) && !f.isGlobal);
        if (orphanFiles.length > 0) {
            groups.push({
                userId: '',
                username: '未知用户',
                fileCount: orphanFiles.length,
                files: orphanFiles.map(f => ({ ...f, ownerName: '未知用户' }))
            });
        }

        return json({ groups });
    } catch (e) {
        console.error('管理员读取文件分组失败:', e);
        return json({ groups: [], error: e.message });
    }
}

// ============ 管理员：列出公共文件 ============

async function handleAdminPublicFiles(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    try {
        const data = await fetchGithubJson(env, 'netdisk/data/files.json');
        const files = (data && data.files) || [];
        const publicFiles = files.filter(f => f.isGlobal === true);

        const { results: users } = await env.DB.prepare(
            'SELECT id, username FROM users'
        ).all();
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u.username; });

        return json({
            files: publicFiles.map(f => ({
                ...f,
                ownerName: userMap[f.ownerId] || '未知用户'
            }))
        });
    } catch (e) {
        console.error('管理员读取公共文件失败:', e);
        return json({ files: [], error: e.message });
    }
}

// ============ 管理员：列出解冻申请 ============

async function handleAdminUnfreezeRequests(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const { results } = await env.DB.prepare(
        "SELECT id, username, email, role, status, status_reason, unfreeze_reason, unfreeze_requested_at FROM users WHERE unfreeze_requested = 1"
    ).all();

    // 将数据库字段名映射为前端使用的驼峰命名
    const requests = results.map(r => ({
        id: r.id,
        username: r.username,
        email: r.email,
        role: r.role,
        status: r.status,
        statusReason: r.status_reason || '',
        unfreezeReason: r.unfreeze_reason || '',
        unfreezeRequestedAt: r.unfreeze_requested_at
    }));

    return json({ requests });
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

// ============ 管理员：设置用户状态（冻结/恢复） ============

async function handleAdminSetStatus(request, env) {
    const user = await getCurrentUser(request, env);
    if (!isAdmin(user)) return json({ error: '无管理员权限' }, 403);

    const body = await request.json();
    const { userId, status, reason } = body;

    if (!userId || !status) return json({ error: '缺少必要参数' }, 400);
    const validStatuses = ['active', 'frozen'];
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