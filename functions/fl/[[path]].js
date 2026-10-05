/**
 * 文件挂载公开路由（/fl/XXX.xx）
 * - GET/HEAD /fl/<文件名> → 从 rains3 桶 fl/ 前缀读取并流式返回
 * - 透传 Range，支持 mp4/mp3/flac 等音视频拖动进度条
 * - html/txt 直接 inline 渲染；其余按类型播放或下载
 * - 列表页 /fl/ 由静态文件 fl/index.html 提供（Pages 静态资源优先于 Functions）
 */

import { s3Request, safeFlName, FL_PREFIX } from '../_lib/s3.js';

function errorPage(message, status = 404) {
    return new Response(
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>无法访问</title></head>` +
        `<body style="font-family:-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;` +
        `justify-content:center;height:100vh;margin:0;background:#f5f5f7"><div style="text-align:center;color:#1d1d1f">` +
        `<h2 style="margin:0 0 8px">文件不存在</h2><p style="margin:0;color:#6e6e73">${message}</p></div></body></html>`,
        { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

// 依据扩展名给出响应类型（存的不准，以名称为准，保证浏览器能播放）
function typeFor(name) {
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    const map = {
        html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
        txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
        json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
        mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
        mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ogv: 'video/ogg', ts: 'video/mp2t',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
        opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', aiff: 'audio/aiff', amr: 'audio/amr',
        mka: 'audio/x-matroska',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
        pdf: 'application/pdf'
    };
    return map[ext] || 'application/octet-stream';
}

function disposition(name) {
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    // 文本/网页/图片/内嵌友好类型直接 inline
    const inlineTypes = ['html', 'htm', 'txt', 'md', 'json', 'xml', 'pdf', 'mp4', 'webm', 'mov',
        'mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mkv', 'mka', 'png', 'jpg',
        'jpeg', 'gif', 'webp', 'svg'];
    const safe = String(name).replace(/[\r\n"\\]/g, '_');
    const mode = inlineTypes.includes(ext) ? 'inline' : 'attachment';
    return `${mode}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const rawName = url.pathname.slice('/fl/'.length);
    const name = safeFlName(rawName);
    if (!name) {
        return errorPage('文件名不合法。', 400);
    }

    const range = request.headers.get('Range');
    let resp;
    try {
        resp = await s3Request(env, { method: 'GET', key: FL_PREFIX + name, range });
    } catch (e) {
        return errorPage('存储服务暂不可用：' + e.message, 502);
    }

    if (resp.status === 404) {
        return errorPage('没有找到 <b>' + name.replace(/</g, '&lt;') + '</b>，它可能尚未挂载或已被移除。');
    }
    if (!resp.ok && resp.status !== 206) {
        return errorPage('读取文件失败（' + resp.status + '）。', 502);
    }

    const headers = new Headers();
    headers.set('Content-Type', typeFor(name));
    headers.set('Content-Disposition', disposition(name));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=300');
    if (resp.headers.get('Content-Length')) headers.set('Content-Length', resp.headers.get('Content-Length'));
    if (resp.headers.get('Content-Range')) headers.set('Content-Range', resp.headers.get('Content-Range'));

    return new Response(request.method === 'HEAD' ? null : resp.body, {
        status: resp.status,
        headers
    });
}

export async function onRequestHead(context) {
    return onRequestGet(context);
}

export function onRequest() {
    return new Response('Method Not Allowed', { status: 405 });
}
