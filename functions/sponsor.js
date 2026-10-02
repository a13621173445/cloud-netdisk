/**
 * Cloud Netdisk - 赞助页（/sponsor）
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 *
 * 路由：
 *   GET /sponsor   → 赞助页
 *
 * 说明：全站所有「赞助」入口统一指向 https://frpz.cc/sponsor。
 *       页面内的「返回首页」指向 https://frpz.cc。
 *       旧地址 /netdisk/sponsor 会自动跳转到这里。
 */

const HOME_URL = 'https://frpz.cc';
const QR_URL = '/netdisk/img/sponsor.png';
const TTL = 300; // 浏览器缓存（秒）

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>赞助 - frpz.cc</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    background: #f5f5f7;
    color: #1d1d1f;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    -webkit-font-smoothing: antialiased;
}
.sponsor-card {
    max-width: 480px;
    width: 100%;
    background: #ffffff;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    padding: 40px;
    text-align: center;
}
.sponsor-card h1 { font-size: 24px; font-weight: 700; margin-bottom: 24px; color: #1d1d1f; }
.sponsor-card p { color: #86868b; font-size: 14px; margin-bottom: 24px; }
.sponsor-image {
    width: 100%;
    max-width: 400px;
    margin: 0 auto 24px;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 12px rgba(0,0,0,0.06);
}
.sponsor-image img { width: 100%; height: auto; display: block; }
.back-btn {
    display: inline-block;
    padding: 12px 32px;
    border: 1px solid #d2d2d7;
    border-radius: 10px;
    background: #ffffff;
    color: #1d1d1f;
    font-size: 15px;
    text-decoration: none;
    transition: all 0.2s;
}
.back-btn:hover { background: #f0f0f5; border-color: #0071e3; color: #0071e3; }
</style>
</head>
<body>
    <div class="sponsor-card">
        <h1>赞助</h1>
        <div class="sponsor-image">
            <img src="${QR_URL}" alt="赞助二维码">
        </div>
        <a href="${HOME_URL}" class="back-btn">返回首页</a>
    </div>
</body>
</html>`;

export async function onRequest(context) {
    const url = new URL(context.request.url);
    // 仅处理 /sponsor 与 /sponsor/，其余交给静态资源 / 回退逻辑
    if (url.pathname !== '/sponsor' && url.pathname !== '/sponsor/') {
        return context.next();
    }
    return new Response(PAGE, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': `public, max-age=${TTL}`
        }
    });
}
