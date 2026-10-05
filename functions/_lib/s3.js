/**
 * 共享 S3 模块（rains3 / Ceph RGW，S3 兼容）
 * - Web Crypto 手写 AWS Signature V4，支持查询串（ListObjectsV2）与 Range 透传
 * - 注意：rains3 上「带 body 的 PUT 必须携带 Content-Type」，否则 403 AccessDenied
 * - 以 _ 开头的目录不参与 Pages 路由，仅供 import
 */

export function getCredentialSets(env) {
    const sets = [];
    if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
        sets.push({ ak: env.S3_ACCESS_KEY_ID, sk: env.S3_SECRET_ACCESS_KEY });
    }
    if (env.S3_ACCESS_KEY_ID_2 && env.S3_SECRET_ACCESS_KEY_2) {
        sets.push({ ak: env.S3_ACCESS_KEY_ID_2, sk: env.S3_SECRET_ACCESS_KEY_2 });
    }
    return sets;
}

export function getS3Config(env) {
    return {
        endpoint: (env.S3_ENDPOINT || 'https://cn-nb2.rains3.com').replace(/\/+$/, ''),
        bucket: env.S3_BUCKET || 'cloudnetdisk',
        region: env.S3_REGION || 'cn-nb2'
    };
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

// AWS SigV4 规范 URI 编码：除 A-Za-z0-9-_.~ 外全部百分号编码
function uriEncode(str, encodeSlash) {
    const bytes = new TextEncoder().encode(String(str));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const c = String.fromCharCode(b);
        if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
        else if (c === '/' && !encodeSlash) out += c;
        else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function amzDates() {
    const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// 规范化查询串：键值均编码后按整串排序，以 & 连接
function buildCanonicalQuery(params) {
    if (!params) return '';
    return Object.keys(params)
        .map(k => uriEncode(k, true) + '=' + uriEncode(params[k], true))
        .sort()
        .join('&');
}

async function signRequest({ method, encodedPath, canonicalQuery, payloadHash, cred, config, extraHeaders }) {
    const { amzDate, dateStamp } = amzDates();
    const host = new URL(config.endpoint).host;

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
        canonicalQuery,
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
 * 执行签名 S3 请求；两套凭证依次尝试
 * @param {object} p { method, key, query, body, contentType, range }
 */
export async function s3Request(env, { method, key, query, body, contentType, range }) {
    const config = getS3Config(env);
    const creds = getCredentialSets(env);
    if (creds.length === 0) {
        throw new Error('未配置 S3 访问凭证（S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY）');
    }

    const encodedPath = '/' + uriEncode(config.bucket, false) +
        (key ? '/' + uriEncode(key, false) : '');
    const canonicalQuery = buildCanonicalQuery(query);
    const url = config.endpoint + encodedPath + (canonicalQuery ? '?' + canonicalQuery : '');

    const payload = body === undefined || body === null ? null : body;
    const payloadHash = payload ? await sha256Hex(payload) : EMPTY_SHA256;

    const extraHeaders = {};
    if (payload) extraHeaders['content-type'] = contentType || 'application/octet-stream';
    if (range) extraHeaders['range'] = range;

    let lastResponse = null;
    for (let i = 0; i < creds.length; i++) {
        const headers = await signRequest({
            method, encodedPath, canonicalQuery, payloadHash, cred: creds[i], config, extraHeaders
        });
        const init = { method, headers };
        if (payload) init.body = payload;
        const response = await fetch(url, init);
        if ((response.status === 403 || response.status === 401) && i < creds.length - 1) {
            lastResponse = response;
            continue;
        }
        return response;
    }
    return lastResponse;
}

/**
 * 列出指定前缀对象（ListObjectsV2，自动翻页，最多 10 页）
 * @returns [{ key, name, size, lastModified }]
 */
export async function listObjects(env, prefix) {
    const out = [];
    let startAfter = '';
    for (let page = 0; page < 10; page++) {
        const query = { 'list-type': '2', prefix };
        if (startAfter) query['start-after'] = startAfter;
        const resp = await s3Request(env, { method: 'GET', key: '', query });
        if (!resp.ok) throw new Error('列举对象失败（' + resp.status + '）');
        const doc = new DOMParser().parseFromString(await resp.text(), 'application/xml');
        const contents = doc.getElementsByTagName('Contents');
        for (let i = 0; i < contents.length; i++) {
            const el = contents[i];
            const get = (t) => { const n = el.getElementsByTagName(t)[0]; return n ? n.textContent : ''; };
            const key = get('Key');
            out.push({ key, name: key.slice(prefix.length), size: Number(get('Size')), lastModified: get('LastModified') });
        }
        const truncated = doc.getElementsByTagName('IsTruncated')[0];
        if (!truncated || truncated.textContent !== 'true') break;
        startAfter = out[out.length - 1] ? out[out.length - 1].key : prefix;
    }
    return out;
}

// ============ /fl 挂载共用 ============

export const FL_PREFIX = 'fl/';
export const FL_MAX_SIZE = 100 * 1024 * 1024; // 100MB

// 挂载文件名清洗：单段、无路径穿越、无控制字符，长度<=200；非法返回 null
export function safeFlName(raw) {
    if (!raw) return null;
    let name;
    try { name = decodeURIComponent(String(raw)); } catch (e) { name = String(raw); }
    name = name.replace(/^\/+/, '');
    if (!name || name.includes('/') || name.includes('..') || name.length > 200) return null;
    if (/[\x00-\x1f\x7f]/.test(name)) return null;
    if (name.toLowerCase() === 'index.html') return null; // 与列表页冲突
    return name;
}

const EXT_TYPES = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
    json: 'application/json', xml: 'application/xml', csv: 'text/csv; charset=utf-8',
    js: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', aiff: 'audio/aiff', amr: 'audio/amr',
    mka: 'audio/x-matroska', mid: 'audio/midi',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
    pdf: 'application/pdf'
};

export function contentTypeByExt(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    if (!m) return 'application/octet-stream';
    return EXT_TYPES[m[1].toLowerCase()] || 'application/octet-stream';
}
