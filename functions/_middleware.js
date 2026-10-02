/**
 * Cloud Netdisk - 全局中间件（functions/_middleware.js）
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 *
 * 作用：让「纯 HTTP」访问也能正常打开，而不是卡在 Cloudflare 边缘的 301 上。
 *
 * 背景
 *   微信聊天里发裸域名（例如 frpz.cc/html）时，微信会自动补成 http:// 前缀。
 *   Cloudflare 的 Always Use HTTPS 对 http 请求返回 301 跳转到 https。
 *   微信内置浏览器（X5 内核）处理不了 http→https 的跨协议 301，
 *   直接报 net:ERR_HTTP_RESPONSE_CODE_FAILURE，页面打不开。
 *
 * 做法
 *   关闭 Cloudflare 的 Always Use HTTPS 后，http 请求会进入 Pages Functions。
 *   本中间件对所有 http 请求不输出任何站点真实内容，只返回一个 200 的跳转页
 *   （meta refresh + JS location.replace + 手动链接兜底），由浏览器自己跳到 https。
 *   200 是合法状态码，微信内核可正常渲染，之后完成到 https 的跳转。
 *
 * 安全说明
 *   1. http 请求一律不返回站点真实内容，页面与 API 都不处理，不会泄露密码/Token。
 *   2. http 下的 /api/* 同样只返回跳转页，不会执行业务逻辑。
 *   3. localStorage / 会话按「协议 + 域名」隔离，https 站点的数据不会被 http 读到。
 *   4. 唯一残留风险：明文 http 的跳转页理论上可被中间人篡改跳转目标，
 *      因此建议同时开启 HSTS（Cloudflare SSL/TLS → Edge Certificates → HSTS）。
 *
 * 生效条件（重要）
 *   Cloudflare 后台必须关闭：SSL/TLS → Edge Certificates → Always Use HTTPS。
 *   若该开关仍为开启，http 请求在边缘就被 301 拦下，本中间件不会触发，
 *   站点行为与现在完全一致，无任何副作用。
 */

function buildRedirectPage(target) {
    // target 已由下面统一构造，这里再做一次转义，防止路径里带引号/尖括号
    const safe = String(target).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const jsSafe = JSON.stringify(String(target)).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>正在跳转到安全连接…</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f172a;color:#e2e8f0;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .box{text-align:center;padding:32px 26px;max-width:340px}
  .dot{width:34px;height:34px;margin:0 auto 18px;border:3px solid rgba(148,163,184,.28);
       border-top-color:#38bdf8;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:17px;font-weight:600;margin:0 0 8px}
  p{font-size:13px;line-height:1.7;color:#94a3b8;margin:0}
  a{color:#38bdf8;text-decoration:none;word-break:break-all;font-size:13px}
</style>
</head>
<body>
  <div class="box">
    <div class="dot"></div>
    <h1>正在切换到安全连接</h1>
    <p>当前是未加密的 HTTP 访问，马上为你转到 HTTPS。<br>如果没有自动跳转，请点击下面的链接：</p>
    <p><a href="${safe}">${safe}</a></p>
  </div>
  <script>location.replace(${jsSafe});</script>
</body>
</html>`;
}

function isPlainHttp(request, url) {
    // Cloudflare 会带上 CF-Visitor 头，标明「访客 ↔ Cloudflare」这一段用的协议，最可靠
    const cfVisitor = request.headers.get('cf-visitor') || '';
    if (/"scheme"\s*:\s*"http"/i.test(cfVisitor)) return true;

    // 兜底：部分场景下 request.url 的协议就是 http
    if (url.protocol === 'http:') return true;

    return false;
}

export async function onRequest(context) {
    // 注意：context.next() 在一次请求中只能调用一次，
    // 所以这里把「判断」和「放行」分开，绝不在 next() 外面套 try/catch 再重调。
    let url = null;
    let plainHttp = false;

    try {
        url = new URL(context.request.url);
        plainHttp = isPlainHttp(context.request, url);
    } catch (err) {
        // 解析异常时按 https 处理，直接放行，绝不阻断站点
        plainHttp = false;
    }

    if (!plainHttp) {
        return context.next();
    }

    // 只把协议换成 https，路径 / 查询参数原样保留
    const target = 'https://' + url.host + url.pathname + url.search;

    return new Response(buildRedirectPage(target), {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, must-revalidate',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}
