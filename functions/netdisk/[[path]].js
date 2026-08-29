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
    const { request, next } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    // 只处理 /netdisk/xxx 且不带 .html 后缀的路径
    if (path.startsWith('/netdisk/')) {
        const page = path.replace('/netdisk/', '').split('/')[0];
        if (PAGE_MAP[page]) {
            // 构造新的请求 URL，指向对应的 .html 文件
            const htmlPath = `/netdisk/${PAGE_MAP[page]}`;
            const newUrl = new URL(htmlPath, url.origin);
            const newRequest = new Request(newUrl.toString(), request);
            return await next(newRequest);
        }
    }

    // 其他请求交给默认处理
    return next();
}
