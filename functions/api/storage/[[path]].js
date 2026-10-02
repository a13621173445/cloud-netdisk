/**
 * Cloud Netdisk - 对象存储代理（rains3 / Ceph RGW，S3 兼容）
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 *
 * 说明：
 * - 浏览器只与本函数通信（同源 /api/storage/*），Access Key / Secret Key 仅存于 Pages 环境变量
 * - 本函数用 Web Crypto 手写 AWS Signature V4 完成签名
 * - 注意：rains3 上「带 body 的 PUT 必须携带 Content-Type」，否则返回 403 AccessDenied
 */

// ============ 访问凭证 ============

// 两套凭证都支持：优先实例级密钥，失败时回退到存储桶级密钥
function getCredentialSets(env) {
    const sets = [];
    if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
        sets.push({ ak: env.S3_ACCESS_KEY_ID, sk: env.S3_SECRET_ACCESS_KEY });
    }
    if (env.S3_ACCESS_KEY_ID_2 && env.S3_SECRET_ACCESS_KEY_2) {
        sets.push({ ak: env.S3_ACCESS_KEY_ID_2, sk: env.S3_SECRET_ACCESS_KEY_2 });
    }
    return sets;
}

function getS3Config(env) {
    return {
        endpoint: (env.S3_ENDPOINT || 'https://cn-nb2.rains3.com').replace(/\/+$/, ''),
        bucket: env.S3_BUCKET || 'cloudnetdisk',
        region: env.S3_REGION || 'cn-nb2'
    };
}

// ============ 工具函数 ============

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function toHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const msg = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
}

// AWS SigV4 规范的 URI 编码：除 A-Za-z0-9-_.~ 外全部百分号编码（按 UTF-8 字节）
function uriEncode(str, encodeSlash) {
    const bytes = new TextEncoder().encode(String(str));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const c = String.fromCharCode(b);
        if (/[A-Za-z0-9\-_.~]/.test(c)) {
            out += c;
        } else if (c === '/' && !encodeSlash) {
            out += c;
        } else {
            out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return out;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function amzDates() {
    const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * 生成 SigV4 授权头
 * @param {object} p - { method, encodedPath, payloadHash, cred, config, extraHeaders }
 * @returns {object} 可直接用于 fetch 的 headers
 */
async function signRequest({ method, encodedPath, payloadHash, cred, config, extraHeaders }) {
    const { amzDate, dateStamp } = amzDates();
    const host = new URL(config.endpoint).host;

    // 所有参与签名的头（键统一小写）
    const headers = Object.assign({
        host: host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate
    }, extraHeaders || {});

    const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
    const canonicalHeaders = names.map(n => `${n}:${String(headers[n]).trim()}\n`).join('');
    const signedHeaders = names.join(';');

    const canonicalRequest = [
        method,
        encodedPath,
        '',                 // 无查询串
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join('\n');

    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = await hmac(new TextEncoder().encode('AWS4' + cred.sk), dateStamp);
    const kRegion = await hmac(kDate, config.region);
    const kService = await hmac(kRegion, 's3');
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, stringToSign));

    return Object.assign({}, headers, {
        authorization: `AWS4-HMAC-SHA256 Credential=${cred.ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    });
}

/**
 * 执行一次已签名的 S3 请求；多套凭证依次尝试
 * @returns {Response}
 */
async function s3Request(env, { method, key, body, contentType }) {
    const config = getS3Config(env);
    const creds = getCredentialSets(env);
    if (creds.length === 0) {
        throw new Error('未配置 S3 访问凭证（S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY）');
    }

    const encodedPath = '/' + uriEncode(config.bucket, false) +
        (key === null || key === undefined || key === '' ? '' : '/' + uriEncode(key, false));

    const payload = body === undefined || body === null ? null : body;
    const payloadHash = payload ? await sha256Hex(payload) : EMPTY_SHA256;

    // 关键：带 body 的请求必须带 Content-Type（rains3 校验）
    const extraHeaders = {};
    if (payload) {
        extraHeaders['content-type'] = contentType || 'application/octet-stream';
    }

    let lastResponse = null;
    for (let i = 0; i < creds.length; i++) {
        const headers = await signRequest({
            method,
            encodedPath,
            payloadHash,
            cred: creds[i],
            config,
            extraHeaders
        });

        const init = { method, headers };
        if (payload) init.body = payload;

        const response = await fetch(config.endpoint + encodedPath, init);

        // 凭证无效或无权限时尝试下一套
        if ((response.status === 403 || response.status === 401) && i < creds.length - 1) {
            lastResponse = response;
            continue;
        }
        return response;
    }
    return lastResponse;
}

/**
 * 上传对象（PUT）。带 body 时强制携带 Content-Type
 */
async function putObject(env, key, bytes, contentType) {
    return s3Request(env, {
        method: 'PUT',
        key,
        body: bytes,
        contentType: contentType || 'application/octet-stream'
    });
}

async function getObject(env, key) {
    return s3Request(env, { method: 'GET', key });
}

async function deleteObject(env, key) {
    return s3Request(env, { method: 'DELETE', key });
}

// ============ 路径与权限 ============

const ALLOWED_PREFIX = 'netdisk/';

function normalizeKey(raw) {
    if (!raw) return null;
    const key = String(raw).replace(/^\/+/, '');
    if (!key.startsWith(ALLOWED_PREFIX)) return null;
    if (key.includes('..')) return null;
    if (key.length > 512) return null;
    return key;
}

// 从请求中获取当前用户（Bearer token → D1 sessions）
async function getSessionUser(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return null;

    const session = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) return null;

    const user = await env.DB.prepare(
        'SELECT id, username, role, status FROM users WHERE id = ?'
    ).bind(session.user_id).first();

    if (!user) return null;
    if (user.status === 'frozen' || user.status === 'deleted') return null;
    return user;
}

// 读取 GitHub 上的 files.json（文件元数据仍存 GitHub）
function base64Decode(b64) {
    const binary = atob(String(b64).replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

async function fetchFilesJson(env) {
    const owner = env.GITHUB_OWNER || 'a13621173445';
    const repo = env.GITHUB_REPO || 'cloud-netdisk';
    const token = env.GITHUB_TOKEN;
    if (!token) throw new Error('缺少 GITHUB_TOKEN 环境变量');

    const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/netdisk/data/files.json?ref=main`,
        {
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }
    );
    if (!resp.ok) throw new Error('读取文件元数据失败（' + resp.status + '）');
    const data = await resp.json();
    return JSON.parse(base64Decode(data.content));
}

// 校验分享令牌（公开下载用）
async function resolveShareToken(env, shareToken) {
    if (!shareToken) throw new Error('分享链接无效');
    const data = await fetchFilesJson(env);
    const file = ((data && data.files) || []).find(f => f.shareToken === shareToken && f.shared === true);
    if (!file) throw new Error('分享链接无效或已被取消');

    if (file.shareExpireAt && new Date(file.shareExpireAt) < new Date()) {
        throw new Error('分享链接已过期');
    }
    const maxDownloads = file.shareMaxDownloads !== undefined ? file.shareMaxDownloads : -1;
    if (maxDownloads !== -1 && (file.shareDownloadCount || 0) >= maxDownloads) {
        throw new Error('分享链接已达到下载次数上限');
    }
    return file;
}

// 让浏览器以附件形式下载
function contentDisposition(name, inline) {
    const safe = String(name || 'download').replace(/[\r\n"\\]/g, '_');
    const encoded = encodeURIComponent(safe);
    return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

// ============ 请求处理 ============

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.pathname.replace('/api/storage', '').replace(/^\/+/, '').split('/')[0] || '';
    const method = request.method;

    try {
        switch (action) {
            case 'health':
                return await handleHealth(env);
            case 'upload':
                return await handleUpload(request, env, url);
            case 'download':
                return await handleDownload(request, env, url);
            case 'shared':
                return await handleShared(request, env, url);
            case 'copy':
                return await handleCopy(request, env, url);
            case 'delete':
                return await handleDelete(request, env, url);
            default:
                return json({ error: 'Unknown storage action' }, 404);
        }
    } catch (e) {
        return json({ error: e.message || 'Server error' }, 500);
    }
}

async function handleHealth(env) {
    const config = getS3Config(env);
    const creds = getCredentialSets(env);
    return json({
        ok: true,
        configured: creds.length > 0,
        credentialCount: creds.length,
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region
    });
}

async function handleUpload(request, env, url) {
    const user = await getSessionUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);
    if (methodNot(request, 'POST')) return json({ error: 'Method not allowed' }, 405);

    const key = normalizeKey(url.searchParams.get('key'));
    if (!key) return json({ error: '非法的存储路径' }, 400);

    const bytes = await request.arrayBuffer();
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

    const resp = await putObject(env, key, bytes, contentType);
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        return json({ error: '上传到对象存储失败', status: resp.status, detail: detail.slice(0, 300) }, 502);
    }

    return json({ success: true, key, size: bytes.byteLength });
}

async function handleDownload(request, env, url) {
    const user = await getSessionUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const key = normalizeKey(url.searchParams.get('key'));
    if (!key) return json({ error: '非法的存储路径' }, 400);

    return await streamObject(env, key, url.searchParams.get('name'), url.searchParams.get('inline') === '1');
}

async function handleShared(request, env, url) {
    // 公开分享下载：凭 shareToken 校验，无需登录
    const shareToken = url.searchParams.get('token');
    let file;
    try {
        file = await resolveShareToken(env, shareToken);
    } catch (e) {
        return json({ error: e.message }, 403);
    }

    const key = normalizeKey(file.path);
    if (!key) return json({ error: '分享文件路径非法' }, 400);

    return await streamObject(env, key, url.searchParams.get('name') || file.name, url.searchParams.get('inline') === '1');
}

async function handleCopy(request, env, url) {
    const user = await getSessionUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);
    if (methodNot(request, 'POST')) return json({ error: 'Method not allowed' }, 405);

    const from = normalizeKey(url.searchParams.get('from'));
    const to = normalizeKey(url.searchParams.get('to'));
    if (!from || !to) return json({ error: '非法的存储路径' }, 400);

    // 读取源对象
    const src = await getObject(env, from);
    if (!src.ok) {
        const detail = await src.text().catch(() => '');
        return json({ error: '读取源文件失败', status: src.status, detail: detail.slice(0, 300) }, 502);
    }
    const bytes = await src.arrayBuffer();
    const contentType = src.headers.get('Content-Type') || 'application/octet-stream';

    // 写入新对象（必须带 Content-Type）
    const dst = await putObject(env, to, bytes, contentType);
    if (!dst.ok) {
        const detail = await dst.text().catch(() => '');
        return json({ error: '写入副本失败', status: dst.status, detail: detail.slice(0, 300) }, 502);
    }

    return json({ success: true, from, to, size: bytes.byteLength });
}

async function handleDelete(request, env, url) {
    const user = await getSessionUser(request, env);
    if (!user) return json({ error: '请先登录' }, 401);

    const key = normalizeKey(url.searchParams.get('key'));
    if (!key) return json({ error: '非法的存储路径' }, 400);

    const resp = await deleteObject(env, key);
    if (!resp.ok && resp.status !== 404) {
        const detail = await resp.text().catch(() => '');
        return json({ error: '删除对象失败', status: resp.status, detail: detail.slice(0, 300) }, 502);
    }
    return json({ success: true, key });
}

// ============ 内部辅助 ============

function methodNot(request, expected) {
    return request.method !== expected;
}

async function streamObject(env, key, name, inline) {
    const resp = await getObject(env, key);
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        return json({ error: '读取对象失败', status: resp.status, detail: detail.slice(0, 300) }, resp.status === 404 ? 404 : 502);
    }

    const headers = new Headers();
    headers.set('Content-Type', resp.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Content-Disposition', contentDisposition(name, inline));
    const len = resp.headers.get('Content-Length');
    if (len) headers.set('Content-Length', len);
    headers.set('Cache-Control', 'private, max-age=0, no-store');
    // 便于跨域调试（同源时无影响）
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(resp.body, { status: 200, headers });
}
