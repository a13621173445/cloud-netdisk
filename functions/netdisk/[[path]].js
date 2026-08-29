/**
 * GitHub Netdisk - Cloudflare Pages Functions 干净 URL 处理
 * 将 /netdisk/xxx 内部重写为 /netdisk/xxx.html（URL 保持不变）
 */

const PAGE_MAP = {
    'login': 'login.html',
    'register': 'register.html',
    'account': 'account.html',
    'admin': 'admin.html',
    'index': 'index.html',
    'shared': 'shared.html',
    'sponsor': 'sponsor.html',
    'verify': 'verify.html',
    'reset': 'reset.html',
    'reset-confirm': 'reset-confirm.html',
    'eula': 'eula.html'
};

export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    // 只处理 /netdisk/xxx 且不带 .html 后缀的路径
    if (path.startsWith('/netdisk/')) {
        const page = path.replace('/netdisk/', '').split('/')[0];
        if (PAGE_MAP[page]) {
            // 内部重写：返回对应 HTML 文件内容
            const htmlPath = `/netdisk/${PAGE_MAP[page]}`;
            const response = await env.ASSETS.fetch(new Request(
                new URL(htmlPath, url.origin),
                request
            ));
            return response;
        }
    }

    // 其他请求交给默认处理
    return next();
}
