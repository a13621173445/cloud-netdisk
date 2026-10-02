/**
 * Cloud Netdisk - HTML查看（/html）
 * Copyright (C) 2026 a13621173445
 * AGPL-3.0
 *
 * 路由：
 *   GET /html 或 /html/          → 作业列表页（带搜索框）
 *   GET /html/<file>.html        → 查看单个作业
 *   GET /html/<file>             → 同上（自动补 .html）
 *   GET /html/list.json          → 作业列表 JSON
 *
 * 内容来源：GitHub 仓库的 html/ 目录（Contents API）。
 * 把新的 .html 文件放进仓库 html/ 目录并 push，无需改代码就会自动出现在列表里。
 * 列表标题直接使用 html 文件的原始名称（去掉 .html 后缀）。
 * 若需要自定义标题/科目/日期，可在仓库 html/ 目录放一个 homework.json（可选）。
 */

const OWNER = 'a13621173445';
const REPO = 'cloud-netdisk';
const BRANCH = 'main';
const DIR = 'html';
const META_FILE = 'homework.json';

const LIST_TTL = 60;              // 列表页浏览器缓存（秒）
const PAGE_TTL = 120;             // 作业页面浏览器缓存（秒）
const LIST_MEM_TTL = 60 * 1000;   // 列表内存缓存（毫秒），避免频繁调用 GitHub API

// ============ 工具 ============

function esc(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function html(body, status = 200, maxAge = 0) {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    headers['Cache-Control'] = maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store';
    return new Response(body, { status, headers });
}

function ghHeaders(env, accept) {
    const headers = {
        'User-Agent': 'cloud-netdisk-pages',
        'Accept': accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (env && env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
    }
    return headers;
}

// 读取仓库目录列表
async function fetchDir(env) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${DIR}?ref=${BRANCH}`;
    const res = await fetch(url, { headers: ghHeaders(env) });
    if (!res.ok) {
        throw new Error(`无法读取仓库 ${DIR}/ 目录（GitHub 返回 ${res.status}）`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
        throw new Error('仓库目录返回格式异常');
    }
    return data;
}

// 读取仓库文件原始内容（支持任意大小、任意编码）
async function fetchRaw(env, path) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
    const res = await fetch(url, { headers: ghHeaders(env, 'application/vnd.github.raw') });
    if (!res.ok) {
        throw new Error(`读取文件 ${path} 失败（GitHub 返回 ${res.status}）`);
    }
    return await res.text();
}

// ============ 列表数据 ============

let memList = { at: 0, items: null };

async function buildList(env) {
    const entries = await fetchDir(env);
    const files = entries.filter(e => e.type === 'file' && /\.html?$/i.test(e.name));

    // 读取可选的元数据文件
    let meta = [];
    const metaEntry = entries.find(e => e.type === 'file' && e.name.toLowerCase() === META_FILE);
    if (metaEntry) {
        try {
            const parsed = JSON.parse(await fetchRaw(env, `${DIR}/${metaEntry.name}`));
            if (parsed && Array.isArray(parsed.items)) meta = parsed.items;
        } catch (e) {
            // 元数据可选：解析失败不影响列表
        }
    }

    const pages = files.filter(e => e.name.toLowerCase() !== META_FILE);
    const items = pages.map(e => {
        const m = meta.find(x => x && x.file === e.name) || {};
        return {
            file: e.name,
            url: `/html/${encodeURIComponent(e.name)}`,
            title: m.title || e.name.replace(/\.html?$/i, ''),
            subject: m.subject || '',
            date: m.date || '',
            size: e.size || 0
        };
    });

    items.sort((a, b) => {
        if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (!!a.date !== !!b.date) return a.date ? -1 : 1;
        return a.file.localeCompare(b.file, 'zh');
    });

    return items;
}

async function getList(env) {
    const now = Date.now();
    if (memList.items && now - memList.at < LIST_MEM_TTL) {
        return memList.items;
    }
    const items = await buildList(env);
    memList = { at: now, items };
    return items;
}

// ============ 页面渲染 ============

const STYLE = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    background: #f5f5f7;
    color: #1d1d1f;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 980px; margin: 0 auto; padding: 0 20px; }
.topbar { background: rgba(255,255,255,.85); backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid #e5e5ea; position: sticky; top: 0; z-index: 10; }
.topbar .wrap { display: flex; align-items: center; justify-content: space-between; height: 54px; }
.brand { font-size: 15px; font-weight: 600; color: #1d1d1f; text-decoration: none; letter-spacing: -0.2px; }
.back { font-size: 14px; color: #0071e3; text-decoration: none; }
.back:hover { text-decoration: underline; }
main { padding: 32px 20px 64px; }
h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
.sub { font-size: 14px; color: #6e6e73; margin-bottom: 22px; }
.searchbar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.searchbar input {
    flex: 1; min-width: 0; padding: 12px 16px; font-size: 15px;
    border: 1px solid #d2d2d7; border-radius: 10px; background: #fff; color: #1d1d1f;
    outline: none; transition: border-color .2s, box-shadow .2s;
    font-family: inherit;
}
.searchbar input:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,.15); }
.count { font-size: 13px; color: #6e6e73; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.card {
    display: block; background: #fff; border: 1px solid #e5e5ea; border-radius: 12px;
    padding: 18px; text-decoration: none; color: inherit;
    transition: transform .18s, box-shadow .18s, border-color .18s;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.08); border-color: #0071e3; }
.tag { display: inline-block; font-size: 12px; font-weight: 500; color: #0071e3; background: #e8f2ff; border-radius: 6px; padding: 2px 8px; margin-bottom: 10px; }
.tag-plain { color: #6e6e73; background: #f0f0f5; }
.card h3 { font-size: 16px; font-weight: 600; line-height: 1.45; margin-bottom: 10px; word-break: break-word; }
.card .meta { font-size: 12px; color: #86868b; display: flex; gap: 10px; flex-wrap: wrap; word-break: break-all; }
.empty { text-align: center; color: #86868b; font-size: 14px; padding: 48px 0; }
.errorbox { background: #fff; border: 1px solid #e5e5ea; border-radius: 12px; padding: 24px; font-size: 14px; line-height: 1.7; color: #6e6e73; }
.errorbox code { background: #f0f0f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #1d1d1f; }
@media (max-width: 480px) { h1 { font-size: 23px; } .grid { grid-template-columns: 1fr; } }
`;

function renderList(items) {
    const cards = items.map(it => {
        const key = [it.title, it.subject, it.file, it.date].join(' ').toLowerCase();
        const tag = it.subject ? `<span class="tag">${esc(it.subject)}</span>` : '';
        const meta = [];
        if (it.file !== it.title) meta.push(`<span>${esc(it.file)}</span>`);
        if (it.date) meta.push(`<span>${esc(it.date)}</span>`);
        return `<a class="card" href="${esc(it.url)}" data-key="${esc(key)}" target="_blank" rel="noopener">`
            + tag
            + `<h3>${esc(it.title)}</h3>`
            + (meta.length ? `<div class="meta">${meta.join('')}</div>` : '')
            + `</a>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HTML查看 - frpz.cc</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/">frpz.cc</a>
    <a class="back" href="/">返回首页</a>
  </div>
</header>
<main class="wrap">
  <h1>HTML查看</h1>
  <p class="sub">共 ${items.length} 份作业 · 点击卡片在新标签页打开</p>
  <div class="searchbar">
    <input id="hw-search" type="search" placeholder="搜索作业标题、科目或文件名" autocomplete="off">
    <span id="hw-count" class="count">${items.length} 份</span>
  </div>
  <div id="hw-grid" class="grid">
${cards}
  </div>
  <div id="hw-empty" class="empty" style="display:none">没有找到匹配的作业</div>
</main>
<script>
(function () {
    var input = document.getElementById('hw-search');
    var grid = document.getElementById('hw-grid');
    var empty = document.getElementById('hw-empty');
    var count = document.getElementById('hw-count');
    if (!input || !grid) return;

    var cards = Array.prototype.slice.call(grid.querySelectorAll('.card'));
    var total = cards.length;

    function apply() {
        var q = (input.value || '').trim().toLowerCase();
        var shown = 0;
        for (var i = 0; i < cards.length; i++) {
            var key = cards[i].getAttribute('data-key') || '';
            var hit = !q || key.indexOf(q) !== -1;
            cards[i].style.display = hit ? '' : 'none';
            if (hit) shown++;
        }
        if (empty) empty.style.display = shown ? 'none' : 'block';
        if (count) count.textContent = q ? (shown + ' / ' + total + ' 份') : (total + ' 份');
    }

    input.addEventListener('input', apply);

    var m = location.search.match(/[?&]q=([^&]*)/);
    if (m) {
        try { input.value = decodeURIComponent(m[1].replace(/\\+/g, ' ')); } catch (e) {}
    }
    apply();
})();
</script>
</body>
</html>`;
}

function renderNotice(title, message, status) {
    return html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - frpz.cc</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/">frpz.cc</a>
    <a class="back" href="/html">作业列表</a>
  </div>
</header>
<main class="wrap">
  <h1>${esc(title)}</h1>
  <p class="sub">HTML查看</p>
  <div class="errorbox">${message}</div>
</main>
</body>
</html>`, status);
}

// ============ 主处理函数 ============

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    let path = url.pathname;
    try {
        path = decodeURIComponent(path);
    } catch (e) {
        // 保留原路径
    }

    const PREFIX = '/html/';

    // 列表页：/html、/html/、/html/index.html
    if (path === '/html' || path === '/html/' || path === PREFIX + 'index.html') {
        try {
            const items = await getList(env);
            return html(renderList(items), 200, LIST_TTL);
        } catch (e) {
            return renderNotice('加载失败', `作业列表暂时无法加载：<code>${esc(e.message)}</code><br><br>请稍后刷新重试。`, 500);
        }
    }

    if (!path.startsWith(PREFIX)) {
        return renderNotice('页面不存在', '请从 <a href="/html" style="color:#0071e3">作业列表</a> 进入。', 404);
    }

    let name = path.slice(PREFIX.length);

    // 列表 JSON
    if (name === 'list.json') {
        try {
            return json({ success: true, items: await getList(env) });
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    // 安全检查：只允许单层文件名
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        return renderNotice('页面不存在', '请从 <a href="/html" style="color:#0071e3">作业列表</a> 进入。', 404);
    }

    // 允许省略 .html 后缀
    if (!/\.html?$/i.test(name)) name += '.html';

    try {
        const items = await getList(env);
        if (!items.some(it => it.file === name)) {
            return renderNotice('作业不存在', `没有找到 <code>${esc(name)}</code>，它可能已被删除或重命名。<br><br>返回 <a href="/html" style="color:#0071e3">作业列表</a>。`, 404);
        }
        const content = await fetchRaw(env, `${DIR}/${name}`);
        return html(content, 200, PAGE_TTL);
    } catch (e) {
        return renderNotice('加载失败', `作业内容暂时无法加载：<code>${esc(e.message)}</code><br><br>请稍后刷新重试。`, 500);
    }
}
