/**
 * GitHub Netdisk - Cloudflare Pages Functions 通配路由
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

    // 检查邮箱/用户名是否已存在
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

    await env.DB.prepare(
        'INSERT INTO users (id, username, email, password_hash, salt, role, status, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, username.trim(), email.trim(), passwordHash, salt, 'user', 'active', 0, createdAt).run();

    return json({
        success: true,
        message: '注册成功！',
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
        'SELECT * FROM users WHERE email = ?'
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

    // 创建会话
    const sessionDuration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionDuration).toISOString();

    // 获取客户端 IP
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const today = now.toISOString().split('T')[0];

    // 删除该用户旧会话
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

// ============ 邮箱验证 ============

async function handleVerify(request, env) {
    const body = await request.json();
    const { email } = body;

    if (!email) {
        return json({ error: '请输入邮箱地址' }, 400);
    }

    const user = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        return json({ error: '该邮箱未注册' }, 404);
    }

    await env.DB.prepare(
        'UPDATE users SET verified = 1 WHERE id = ?'
    ).bind(user.id).run();

    return json({ success: true, message: '邮箱验证成功！' });
}
