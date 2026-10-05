/**
 * 文件挂载管理 API（需登录，同源 /api/fl/*）
 * - GET    /api/fl/list               → 已挂载文件列表
 * - POST   /api/fl/upload?name=X      → 上传（body 为文件原始字节，存到桶 fl/ 前缀）
 * - DELETE /api/fl/delete?name=X      → 删除挂载
 * 密钥仅在服务端，签名由 _lib/s3.js 完成
 */

import { s3Request, listObjects, safeFlName, contentTypeByExt, FL_PREFIX, FL_MAX_SIZE } from '../../_lib/s3.js';

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

// Bearer token → D1 sessions → users
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

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.pathname.replace('/api/fl', '').replace(/^\/+/, '').split('/')[0] || '';

    const user = await getSessionUser(request, env);
    if (!user) {
        return json({ error: '请先登录' }, 401);
    }

    try {
        if (action === 'list' && request.method === 'GET') {
            const items = await listObjects(env, FL_PREFIX);
            return json({
                ok: true,
                items: items.map(it => ({
                    name: it.name,
                    size: it.size,
                    lastModified: it.lastModified,
                    url: '/fl/' + encodeURIComponent(it.name)
                }))
            });
        }

        if (action === 'upload' && request.method === 'POST') {
            const name = safeFlName(url.searchParams.get('name'));
            if (!name) return json({ error: '文件名不合法（不能包含路径、控制字符，且不能叫 index.html）' }, 400);

            const bytes = await request.arrayBuffer();
            if (bytes.byteLength === 0) return json({ error: '空文件' }, 400);
            if (bytes.byteLength > FL_MAX_SIZE) {
                return json({ error: '文件超过 ' + Math.floor(FL_MAX_SIZE / 1024 / 1024) + 'MB 限制' }, 413);
            }

            const resp = await s3Request(env, {
                method: 'PUT',
                key: FL_PREFIX + name,
                body: new Uint8Array(bytes),
                contentType: contentTypeByExt(name)
            });
            if (!resp.ok) {
                const detail = (await resp.text()).slice(0, 200);
                return json({ error: '写入存储失败（' + resp.status + '）' + detail }, 502);
            }
            return json({ ok: true, name, url: '/fl/' + encodeURIComponent(name) });
        }

        if (action === 'delete' && request.method === 'DELETE') {
            const name = safeFlName(url.searchParams.get('name'));
            if (!name) return json({ error: '文件名不合法' }, 400);

            const resp = await s3Request(env, { method: 'DELETE', key: FL_PREFIX + name });
            if (!resp.ok && resp.status !== 404) {
                return json({ error: '删除失败（' + resp.status + '）' }, 502);
            }
            return json({ ok: true });
        }

        return json({ error: '接口不存在' }, 404);
    } catch (e) {
        return json({ error: e.message }, 500);
    }
}
