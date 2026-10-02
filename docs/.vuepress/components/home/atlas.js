// 知识星图：数据组装、布局、SVG 生成（纯函数，SSR 与客户端结果一致）以及交互挂载
import {GROUPS as RAW_GROUPS, GOALS, REL} from '../../site.js';

/* ---------------------------------------------------------------
   Model: site.js + build-time stats
   --------------------------------------------------------------- */
export function buildModel(stats) {
    const mods = (stats && stats.modules) || {};
    const groups = RAW_GROUPS.map((g, i) => {
        const modules = g.modules.map((m, j) => ({
            ...m,
            link: `/${m.dir}/0_overview`,
            a: mods[m.dir] ? mods[m.dir].articles : 0,
            q: mods[m.dir] ? mods[m.dir].questions : 0,
            gi: i,
            mi: j,
        }));
        return {
            ...g,
            modules,
            i,
            no: String(i + 1).padStart(2, '0'),
            arts: modules.reduce((s, m) => s + m.a, 0),
            qs: modules.reduce((s, m) => s + m.q, 0),
        };
    });
    const byName = {};
    groups.forEach((g) => g.modules.forEach((m) => { byName[m.name] = m; }));
    const rel = REL.filter((r) => byName[r[0]] && byName[r[1]]);
    const goals = GOALS.map((g) => ({...g, mods: g.stops.map((n) => byName[n]).filter(Boolean)}));
    const totals = {
        groups: groups.length,
        modules: groups.reduce((s, g) => s + g.modules.length, 0),
        articles: groups.reduce((s, g) => s + g.arts, 0),
        questions: groups.reduce((s, g) => s + g.qs, 0),
        answerPages: (stats && stats.answerPages) || 0,
        svgs: (stats && stats.svgs) || 0,
    };
    return {groups, byName, rel, goals, totals};
}

/* 分组配色：沿品牌渐变 #ff6b9d → #a855f7 → #38bdf8 按学习顺序等距取色，分组数量变化时自动适配 */
const BRAND = [[255, 107, 157], [168, 85, 247], [56, 189, 248]];
function brandAt(t) {
    const seg = t <= .5 ? 0 : 1, u = t <= .5 ? t * 2 : (t - .5) * 2;
    const [a, b] = [BRAND[seg], BRAND[seg + 1]];
    return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * u).toString(16).padStart(2, '0')).join('');
}
export function paletteStyle(n) {
    const style = {};
    for (let i = 1; i <= n; i++) {
        style[`--s${i}`] = brandAt(n === 1 ? 0 : (i - 1) / (n - 1));
        style[`--c${i}`] = `color-mix(in oklab,var(--s${i}) var(--mixp),var(--mix))`;
        style[`--t${i}`] = `color-mix(in oklab,var(--s${i}) var(--tmixp),var(--mix))`;
    }
    return style;
}

/* ---------------------------------------------------------------
   Layouts. Ring groups sit on a spiral (clockwise, radius grows);
   star coords are local [a along path, b outward, label side].
   A group whose module count no longer matches its hand-tuned spec
   falls back to autoSpec(), so adding a module never breaks the chart.
   --------------------------------------------------------------- */
export const WIDE = {
    v: 'wide', vb: '50 10 700 700', cx: 400, cy: 360, rx0: 196, rxs: 6, ry0: 196, rys: 6, k: 1, zone: 70, zone0: 86,
    spec: [
        {s: [[0, -58, 't'], [58, -8, 'r'], [10, 54, 'b'], [-56, 20, 'b']], name: {dx: 0, dy: 6}},
        {s: [[-42, 4, 'out'], [0, -10, 'out'], [42, 6, 'out']], name: {dx: 54, dy: 14}},
        {s: [[-42, 0, 'out'], [0, -10, 'out'], [42, 4, 'out']], name: {inn: 52}},
        {s: [[-48, 2, 'out'], [0, -8, 'in'], [48, -2, 'out']], name: {out: 48}},
        {s: [[-42, 0, 'out'], [0, -10, 'out'], [42, 4, 'out']], name: {dx: -21, dy: 49}},
        {s: [[-44, 2, 'out'], [0, -10, 'out'], [44, 4, 'out']], name: {inn: 64}},
        {s: [[-42, 0, 'out'], [0, -10, 'out'], [42, 4, 'out']], name: {dx: -20, dy: -54}},
        {s: [[-48, 2, 'out'], [0, -8, 'in'], [48, -2, 'out']], name: {out: 54}},
        {s: [[-28, 0, 'out'], [28, -4, 'out']], name: {dx: -57, dy: -58}},
    ],
};
// 手机：紧凑星盘（与桌面同一套螺旋坐标，整体缩小，模块名轻触方向后显示）
export const DISC = {
    v: 'disc', vb: '0 0 360 360', cx: 180, cy: 180, R: 170,
    rx0: 114, rxs: 3, ry0: 114, rys: 3, k: .56, sr: .72, nk: .62, zone: 38, zone0: 48, badge: 7,
    // 名字位置单独微调（像素，不再乘 nk）：02 放到内侧，04 放到星点下方，避免压线、贴框
    spec: WIDE.spec.map((sp, gi) => ({...sp, name: ({1: {inn: 46, raw: 1}, 3: {inn: 36, raw: 1}})[gi] ?? sp.name})),
};

function autoSpec(n, gi, L) {
    if (gi === 0) {
        const s = [];
        for (let i = 0; i < n; i++) {
            const t = -Math.PI / 2 + i * 2 * Math.PI / n;
            s.push([Math.round(58 * Math.cos(t)), Math.round(58 * Math.sin(t)), Math.sin(t) < -.5 ? 't' : (Math.cos(t) > .5 ? 'r' : 'b')]);
        }
        return {s, name: {dx: 0, dy: 6}};
    }
    const step = n > 3 ? 34 : 42, side = 'out';
    const s = [];
    for (let i = 0; i < n; i++) s.push([Math.round((i - (n - 1) / 2) * step), i % 2 ? -10 : 2, side]);
    return {s, name: {out: 50}};
}
function specOf(L, gi, n) {
    const sp = L.spec[gi];
    return sp && sp.s.length === n ? sp : autoSpec(n, gi, L);
}

export function starR(a) { return 2.6 + Math.sqrt(a) * .95; }
export function ringR(m) { return m.q > 0 ? starR(m.a) + 2.4 + Math.sqrt(m.q) * .42 : (m.stub ? starR(m.a) + 3.4 : 0); }
function f1(n) { return Math.round(n * 10) / 10; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

export function place(model, L) {
    const sr = L.sr ?? 1;
    const n0 = Math.max(model.groups.length - 1, 1), stepDeg = 360 / Math.max(n0, 8);
    return model.groups.map((g, gi) => {
        const sp = specOf(L, gi, g.modules.length);
        let C, t = null, n = null;
        if (gi === 0) C = {x: L.cx, y: L.cy};
        else {
            const th = (180 + stepDeg * (gi - 1)) * Math.PI / 180;
            const rx = L.rx0 + L.rxs * (gi - 1), ry = L.ry0 + L.rys * (gi - 1);
            C = {x: L.cx + rx * Math.cos(th), y: L.cy + ry * Math.sin(th)};
            t = {x: -Math.sin(th), y: Math.cos(th)};
            n = {x: Math.cos(th), y: Math.sin(th)};
        }
        const stars = g.modules.map((m, mi) => {
            const s = sp.s[mi];
            let x, y;
            if (!t) { x = C.x + s[0] * L.k; y = C.y + s[1] * L.k; }
            else { x = C.x + (s[0] * t.x + s[1] * n.x) * L.k; y = C.y + (s[0] * t.y + s[1] * n.y) * L.k; }
            let d;
            switch (s[2]) {
                case 'out': d = n; break;
                case 'in': d = {x: -n.x, y: -n.y}; break;
                case 'l': d = {x: -1, y: 0}; break;
                case 'r': d = {x: 1, y: 0}; break;
                case 't': d = {x: 0, y: -1}; break;
                default: d = {x: 0, y: 1};
            }
            return {x, y, d, m, r: starR(m.a) * sr, rr: ringR(m) * sr};
        });
        const nk = sp.name.raw ? 1 : (L.nk ?? 1);
        let nm;
        if (sp.name.inn != null) nm = {x: C.x - n.x * sp.name.inn * nk, y: C.y - n.y * sp.name.inn * nk};
        else if (sp.name.out != null) nm = {x: C.x + n.x * sp.name.out * nk, y: C.y + n.y * sp.name.out * nk};
        else nm = {x: C.x + sp.name.dx * nk, y: C.y + sp.name.dy * nk};
        return {C, stars, name: nm, n};
    });
}

export function trim(a, b, ra, rb) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    return {x1: a.x + ux * ra, y1: a.y + uy * ra, x2: b.x - ux * rb, y2: b.y - uy * rb, len, ux, uy};
}
export function gap(s) { return (s.rr || s.r) + 3; }

function rng(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/* ---------------------------------------------------------------
   SVG atlas (string, rendered with v-html)
   --------------------------------------------------------------- */
export function buildAtlas(model, L, withBase) {
    const P = place(model, L), wide = L.v === 'wide', o = [], id = 'atlas-' + L.v;
    const G = model.groups;
    o.push(`<svg class="atlas atlas--${L.v}" data-v="${L.v}" viewBox="${L.vb}" role="group" aria-label="知识星图：${model.totals.modules} 个模块按 ${G.length} 个方向聚类，沿推荐学习路径由中心向外盘旋">`);
    o.push('<defs>' +
        `<radialGradient id="${id}na"><stop offset="0" class="nb0 nb-a"/><stop offset="1" class="nb1 nb-a"/></radialGradient>` +
        `<radialGradient id="${id}nb"><stop offset="0" class="nb0 nb-b"/><stop offset="1" class="nb1 nb-b"/></radialGradient>` +
        `<radialGradient id="${id}nc"><stop offset="0" class="nb0 nb-c"/><stop offset="1" class="nb1 nb-c"/></radialGradient>` +
        '</defs>');

    /* background plate: disc, grid, bezel, then field stars */
    o.push('<g class="a-bg" aria-hidden="true">');
    const cx0 = wide ? 400 : L.cx, cy0 = wide ? 360 : L.cy, R0 = wide ? 318 : (L.R || 0), sc = R0 / 318;
    o.push(`<circle class="a-disc" cx="${cx0}" cy="${cy0}" r="${R0}"/>`);
    o.push(`<ellipse cx="${f1(cx0 - 150 * sc)}" cy="${f1(cy0 + 160 * sc)}" rx="${f1(260 * sc)}" ry="${f1(200 * sc)}" fill="url(#${id}na)"/>`);
    o.push(`<ellipse cx="${cx0}" cy="${cy0}" rx="${f1(230 * sc)}" ry="${f1(210 * sc)}" fill="url(#${id}nb)"/>`);
    o.push(`<ellipse cx="${f1(cx0 + 180 * sc)}" cy="${f1(cy0 - 150 * sc)}" rx="${f1(270 * sc)}" ry="${f1(210 * sc)}" fill="url(#${id}nc)"/>`);
    o.push(`<circle class="a-grid d" cx="${cx0}" cy="${cy0}" r="${f1(128 * sc)}"/>`);
    for (let sa = 0; sa < 360; sa += 30) {
        const rad = sa * Math.PI / 180;
        o.push(`<line class="a-spoke" x1="${f1(cx0 + 132 * sc * Math.cos(rad))}" y1="${f1(cy0 + 132 * sc * Math.sin(rad))}" x2="${f1(cx0 + 306 * sc * Math.cos(rad))}" y2="${f1(cy0 + 306 * sc * Math.sin(rad))}"/>`);
    }
    const R1 = R0 + (wide ? 8 : 4);
    o.push(`<circle class="a-bezel" cx="${cx0}" cy="${cy0}" r="${R0}"/><circle class="a-bezel" cx="${cx0}" cy="${cy0}" r="${R1}"/>`);
    const step = wide ? 3 : 5;
    for (let ta = 0; ta < 360; ta += step) {
        const tr = ta * Math.PI / 180, major = ta % 45 === 0, mid = ta % 15 === 0;
        const r2 = major ? R1 : (mid ? R0 + (R1 - R0) * .7 : R0 + (R1 - R0) * .38);
        o.push(`<line class="a-tick${major ? ' m' : ''}" x1="${f1(cx0 + R0 * Math.cos(tr))}" y1="${f1(cy0 + R0 * Math.sin(tr))}" x2="${f1(cx0 + r2 * Math.cos(tr))}" y2="${f1(cy0 + r2 * Math.sin(tr))}"/>`);
    }
    if (wide) {
        for (let bi = 1; bi < P.length; bi++) {
            const c = P[bi].C, dx = c.x - 400, dy = c.y - 360, len = Math.hypot(dx, dy) || 1;
            o.push(`<text class="a-blbl" x="${f1(400 + 336 * dx / len)}" y="${f1(360 + 336 * dy / len + 3.4)}" text-anchor="middle">${G[bi].no}</text>`);
        }
    }
    const R = rng(wide ? 20250930 : 7331), stars = [];
    P.forEach((p) => p.stars.forEach((s) => stars.push(s)));
    o.push('<g class="a-field">');
    const count = wide ? 190 : 90, minGap = wide ? 20 : 14;
    let made = 0, guard = 0;
    while (made < count && guard++ < 3000) {
        const u = R(), v = R();
        let fx, fy;
        const ang = u * Math.PI * 2, rr = Math.sqrt(v) * (R0 - 6);
        fx = cx0 + rr * Math.cos(ang); fy = cy0 + rr * Math.sin(ang);
        if (stars.some((st) => Math.hypot(st.x - fx, st.y - fy) < minGap)) continue;
        const size = .35 + Math.pow(R(), 3) * 1.15, op = (.25 + R() * .75).toFixed(2), tw = R() < .1;
        o.push(`<circle cx="${f1(fx)}" cy="${f1(fy)}" r="${size.toFixed(2)}"` +
            (tw ? ` class="tw" style="animation-delay:${(R() * -6).toFixed(2)}s"` : ` style="opacity:calc(var(--field-o) * ${op})"`) + '/>');
        made++;
    }
    o.push('</g></g>');

    /* relations */
    o.push('<g class="a-rel" aria-hidden="true">');
    model.rel.forEach((r) => {
        const A = model.byName[r[0]], B = model.byName[r[1]];
        const a = P[A.gi].stars[A.mi], b = P[B.gi].stars[B.mi];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cx = mx + (L.cx - mx) * r[2], cy = my + (L.cy - my) * r[2];
        o.push(`<path class="rel" data-ga="${A.gi}" data-gb="${B.gi}" d="M${f1(a.x)} ${f1(a.y)}Q${f1(cx)} ${f1(cy)} ${f1(b.x)} ${f1(b.y)}"/>`);
    });
    o.push('</g>');

    /* route between groups */
    o.push('<g class="a-route" aria-hidden="true">');
    for (let gi = 1; gi < P.length; gi++) {
        const from = P[gi - 1].stars[P[gi - 1].stars.length - 1], to = P[gi].stars[0];
        const st = `style="--c:var(--c${gi + 1})"`;
        const T = trim(from, to, gap(from), gap(to) + 1);
        o.push(`<line class="rs" data-to="${gi}" ${st} x1="${f1(T.x1)}" y1="${f1(T.y1)}" x2="${f1(T.x2)}" y2="${f1(T.y2)}"/>`);
        const px = T.x1 + (T.x2 - T.x1) * .56, py = T.y1 + (T.y2 - T.y1) * .56, deg = Math.atan2(T.uy, T.ux) * 180 / Math.PI;
        o.push(`<path class="rc" data-to="${gi}" ${st} transform="translate(${f1(px)} ${f1(py)}) rotate(${f1(deg)})" d="M-2.6 -3L1.6 0L-2.6 3"/>`);
    }
    o.push('</g>');
    o.push('<g class="a-goal" aria-hidden="true"></g>');

    /* constellations */
    P.forEach((p, gi) => {
        const g = G[gi];
        o.push(`<g class="cg" data-g="${gi}" style="--c:var(--c${gi + 1});--t:var(--t${gi + 1});--i:${gi}">`);
        o.push(`<circle class="zone" cx="${f1(p.C.x)}" cy="${f1(p.C.y)}" r="${gi === 0 ? L.zone0 : L.zone}"/>`);
        o.push('<g class="cl" aria-hidden="true">');
        for (let k = 1; k < p.stars.length; k++) {
            const T2 = trim(p.stars[k - 1], p.stars[k], gap(p.stars[k - 1]), gap(p.stars[k]));
            o.push(`<line class="ln" pathLength="1" x1="${f1(T2.x1)}" y1="${f1(T2.y1)}" x2="${f1(T2.x2)}" y2="${f1(T2.y2)}"/>`);
        }
        o.push('</g>');
        p.stars.forEach((s) => {
            const m = s.m, d = s.d, off = (s.rr || s.r) + 6;
            const lx = s.x + d.x * off, ly = s.y + d.y * off;
            const anchor = d.x > .38 ? 'start' : (d.x < -.38 ? 'end' : 'middle');
            const dy = d.y > .38 ? 11 : (d.y < -.38 ? -3 : 4.5);
            const meta = m.a + ' 篇' + (m.q ? ' · ' + m.q + ' 题' : '') + (m.stub ? ' · ' + m.stub : '');
            o.push(`<a class="st${m.stub ? ' stub' : ''}" href="${withBase(m.link)}" data-link="${m.link}" data-g="${gi}" data-m="${m.mi}" aria-label="${esc(m.name)}，${meta}">` +
                `<title>${esc(m.name)} · ${meta}</title>` +
                `<circle class="st-hit" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${wide ? 16 : 14}"/>` +
                `<circle class="st-halo" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.r + 5)}"/>` +
                (s.rr ? `<circle class="st-ring" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.rr)}"/>` : '') +
                `<circle class="st-dot" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(m.stub ? s.r - .6 : s.r)}"/>` +
                `<circle class="st-focus" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1((s.rr || s.r) + 4.5)}"/>` +
                `<text class="lbl" x="${f1(lx)}" y="${f1(ly + dy)}" text-anchor="${anchor}">${esc(m.name)}</text>` +
                '</a>');
        });
        o.push(`<a class="gname" href="#g-${g.no}" data-g="${gi}" aria-label="${g.no} ${g.name}：跳到星表">` +
            `<text class="gi" x="${f1(p.name.x)}" y="${f1(p.name.y - 18)}" text-anchor="middle">${g.no}</text>` +
            `<text class="gn" x="${f1(p.name.x + 1.6)}" y="${f1(p.name.y)}" text-anchor="middle">${g.name}</text></a>`);
        o.push('</g>');
    });
    o.push('<g class="a-goalb" aria-hidden="true"></g>');
    o.push('</svg>');
    return o.join('');
}

/* catalogue glyph: the group's constellation, reduced */
export function buildGlyph(model, gi) {
    const g = model.groups[gi], sp = specOf(WIDE, gi, g.modules.length), W = 176, H = 64;
    const pts = sp.s.map((s) => (gi === 0 ? {x: s[0], y: s[1]} : {x: s[0], y: -s[1]}));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const sc = Math.min((W - 44) / Math.max(maxx - minx, 1), (H - 14) / Math.max(maxy - miny, 1), 1.5);
    const ox = W / 2 - (minx + maxx) / 2 * sc, oy = H / 2 - (miny + maxy) / 2 * sc;
    const q = pts.map((p, i) => {
        const m = g.modules[i];
        return {x: ox + p.x * sc, y: oy + p.y * sc, r: starR(m.a) * .78, rr: ringR(m) * .78, m};
    });
    let o = `<svg class="glyph" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    if (gi > 0) o += `<line class="gl-stub" x1="0" y1="${f1(q[0].y)}" x2="${f1(q[0].x - (q[0].rr || q[0].r) - 4)}" y2="${f1(q[0].y)}"/>`;
    if (gi < model.groups.length - 1 && gi > 0) {
        const l = q[q.length - 1];
        o += `<line class="gl-stub" x1="${f1(l.x + (l.rr || l.r) + 4)}" y1="${f1(l.y)}" x2="${W}" y2="${f1(l.y)}"/>`;
    }
    for (let i = 1; i < q.length; i++) {
        const T = trim(q[i - 1], q[i], (q[i - 1].rr || q[i - 1].r) + 2.5, (q[i].rr || q[i].r) + 2.5);
        o += `<line class="gl-ln" x1="${f1(T.x1)}" y1="${f1(T.y1)}" x2="${f1(T.x2)}" y2="${f1(T.y2)}"/>`;
    }
    q.forEach((s) => {
        if (s.rr) o += `<circle class="gl-ring" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.rr)}"${s.m.stub ? ' stroke-dasharray="1.4 2.4"' : ''}/>`;
        o += `<circle class="gl-st${s.m.stub ? ' stub' : ''}" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.r)}"/>`;
    });
    return o + '</svg>';
}

export function defaultCaption(model) {
    return `<p><span class="cap-k">图 1</span>${model.totals.modules} 个模块按 ${model.groups.length} 个方向聚类，沿推荐学习路径自中心向外盘旋：星点大小对应文章数，外环对应题单题数，空心星表示仍在编写；点线为跨模块关联（节选）。</p>` +
        '<p>悬停、聚焦或轻触任一方向即可点亮它的模块与所在路段；也可以在上方按目标选一条路线。</p>';
}

/* ---------------------------------------------------------------
   Interaction (client only). Returns a cleanup function.
   --------------------------------------------------------------- */
export function mountAtlas(root, model, {withBase, navigate}) {
    const G = model.groups, BYNAME = model.byName, GOALS_M = model.goals;
    const off = [];
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); off.push(() => el.removeEventListener(ev, fn, opt)); };
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));
    const layouts = Object.fromEntries([WIDE, DISC].map((L) => [L.v, {L, P: place(model, L)}]));

    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    let lastPointer = 'mouse';
    on(document, 'pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);

    const svgs = $$('.atlas');
    const pickers = $$('.chip, .sh');
    const shareEl = $('.share');
    const capEl = $('.caption');
    let pinned = null, current = {g: null, m: null}, goal = null;

    const link = (m) => `<a href="${withBase(m.link)}" data-link="${m.link}">${m.name}</a>`;
    function relsOf(gi) {
        const out = [];
        model.rel.forEach((r) => {
            const A = BYNAME[r[0]], B = BYNAME[r[1]];
            if (A.gi === gi && B.gi !== gi) out.push([A, B]);
            else if (B.gi === gi && A.gi !== gi) out.push([B, A]);
        });
        return out;
    }
    function renderCaption(gi, mi) {
        if (gi == null) { capEl.innerHTML = defaultCaption(model); capEl.style.removeProperty('--t'); capEl.style.removeProperty('--c'); return; }
        const g = G[gi];
        capEl.style.setProperty('--t', `var(--t${gi + 1})`);
        capEl.style.setProperty('--c', `var(--c${gi + 1})`);
        let h = `<p><span class="cap-k">${g.no} / ${String(G.length).padStart(2, '0')}</span><span class="cap-g">${g.name}</span> — ${g.tagline}</p>`;
        h += `<p>${g.modules.length} 个模块 · ${g.arts} 篇${g.qs ? ' · ' + g.qs + ' 题' : ''} · 阅读顺序 ${g.modules.map(link).join(' → ')}</p>`;
        if (mi != null) {
            const m = g.modules[mi];
            h += `<p class="cap-m"><b>${m.name}</b>${m.stub ? '（' + m.stub + '）' : ''}：${esc(m.desc)}</p>`;
        } else {
            const rs = relsOf(gi);
            h += '<p>' + (rs.length ? '跨模块关联：' + rs.map((p) => p[0].name + ' ↔ ' + p[1].name).join(' · ') : `路线第 ${gi + 1} 站，共 ${G.length} 站`) + '</p>';
        }
        capEl.innerHTML = h;
    }

    function setActive(gi = null, mi = null) {
        if (goal !== null) return;
        const changed = gi !== current.g;
        if (!changed && mi === current.m) return;
        current = {g: gi, m: mi};
        svgs.forEach((svg) => {
            svg.classList.toggle('has-active', gi != null);
            svg.querySelectorAll('.cg').forEach((el) => {
                const k = +el.getAttribute('data-g');
                el.classList.toggle('is-on', k === gi);
                el.classList.toggle('is-past', gi != null && k < gi);
            });
            svg.querySelectorAll('.rs,.rc').forEach((el) => el.classList.toggle('is-lit', gi != null && +el.getAttribute('data-to') <= gi));
            svg.querySelectorAll('.rel').forEach((el) => {
                const lit = gi != null && (+el.getAttribute('data-ga') === gi || +el.getAttribute('data-gb') === gi);
                el.classList.toggle('is-on', lit);
                if (lit) el.style.setProperty('--rc', `var(--c${gi + 1})`);
            });
            svg.querySelectorAll('.st').forEach((el) => el.classList.remove('is-rel', 'is-cur'));
            if (gi != null) {
                relsOf(gi).forEach((p) => {
                    const t = svg.querySelector(`.st[data-g="${p[1].gi}"][data-m="${p[1].mi}"]`);
                    if (t) t.classList.add('is-rel');
                });
                if (mi != null) {
                    const c = svg.querySelector(`.st[data-g="${gi}"][data-m="${mi}"]`);
                    if (c) c.classList.add('is-cur');
                }
                if (changed && !reduce) {
                    svg.querySelectorAll(`.cg[data-g="${gi}"] .ln`).forEach((ln) => {
                        ln.classList.remove('draw'); void ln.getBoundingClientRect(); ln.classList.add('draw');
                    });
                }
            }
        });
        pickers.forEach((c) => c.classList.toggle('is-on', +c.getAttribute('data-g') === gi));
        shareEl.classList.toggle('has-on', gi != null);
        renderCaption(gi, mi);
    }
    const restore = () => setActive(pinned, null);
    const syncPressed = () => pickers.forEach((c) => c.setAttribute('aria-pressed', String(+c.getAttribute('data-g') === pinned)));

    svgs.forEach((svg) => {
        if (!reduce) {
            svg.classList.add('intro');
            const t = setTimeout(() => svg.classList.remove('intro'), 2600);
            off.push(() => clearTimeout(t));
        }
        svg.querySelectorAll('.cg').forEach((el) => {
            const gi = +el.getAttribute('data-g');
            on(el, 'mouseenter', () => setActive(gi, null));
            on(el, 'mouseleave', restore);
        });
        svg.querySelectorAll('.st').forEach((el) => {
            const gi = +el.getAttribute('data-g'), mi = +el.getAttribute('data-m');
            on(el, 'mouseenter', () => setActive(gi, mi));
            on(el, 'mouseleave', () => { if (current.g === gi) setActive(gi, null); });
            on(el, 'focus', () => setActive(gi, mi));
            on(el, 'blur', restore);
            on(el, 'click', (e) => {
                // 触屏：第一次轻触选中方向，再次轻触才跳转
                if (lastPointer === 'touch' && goal === null && pinned !== gi) {
                    e.preventDefault(); pinned = gi; syncPressed(); current = {g: null, m: null}; setActive(gi, mi);
                }
            });
        });
        svg.querySelectorAll('.gname').forEach((el) => {
            const gi = +el.getAttribute('data-g');
            on(el, 'focus', () => setActive(gi, null));
            on(el, 'blur', restore);
            on(el, 'click', (e) => {
                if (lastPointer === 'touch' && goal === null && pinned !== gi) {
                    e.preventDefault(); pinned = gi; syncPressed(); current = {g: null, m: null}; setActive(gi, null);
                }
            });
        });
    });

    pickers.forEach((c) => {
        const gi = +c.getAttribute('data-g');
        on(c, 'mouseenter', () => setActive(gi, null));
        on(c, 'mouseleave', restore);
        on(c, 'focus', () => setActive(gi, null));
        on(c, 'blur', restore);
        on(c, 'click', () => {
            if (goal !== null) setGoal(null);
            pinned = pinned === gi ? null : gi; syncPressed(); setActive(gi, null);
        });
    });

    /* goal routes */
    const gtabs = $$('.seg button');
    gtabs.forEach((b, i) => {
        on(b, 'click', () => { const k = +b.getAttribute('data-k'); setGoal(k < 0 ? null : k); });
        on(b, 'keydown', (e) => {
            let n = null;
            if (e.key === 'ArrowRight') n = (i + 1) % gtabs.length;
            if (e.key === 'ArrowLeft') n = (i - 1 + gtabs.length) % gtabs.length;
            if (n !== null) { e.preventDefault(); gtabs[n].focus(); gtabs[n].click(); }
        });
    });
    function drawGoal(svg, k) {
        const {L, P} = layouts[svg.getAttribute('data-v')];
        const lay = svg.querySelector('.a-goal'), layb = svg.querySelector('.a-goalb');
        svg.querySelectorAll('.st.is-goal').forEach((el) => el.classList.remove('is-goal'));
        svg.classList.toggle('has-goal', k !== null);
        if (k === null) { lay.innerHTML = ''; layb.innerHTML = ''; return; }
        const pts = GOALS_M[k].mods.map((m) => ({m, s: P[m.gi].stars[m.mi]}));
        const anim = reduce ? '' : ' draw';
        let h = '', hb = '';
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1].s, b = pts[i].s, T = trim(a, b, gap(a) + 1, gap(b) + 2);
            const mx = (T.x1 + T.x2) / 2, my = (T.y1 + T.y2) / 2;
            const bend = L.bend ?? .14, cx = mx + (L.cx - mx) * bend, cy = my + (L.cy - my) * bend;
            const d = `M${f1(T.x1)} ${f1(T.y1)}Q${f1(cx)} ${f1(cy)} ${f1(T.x2)} ${f1(T.y2)}`;
            h += `<path class="gp-h" d="${d}"/>`;
            h += `<path class="gp${anim}" pathLength="1" style="--c:var(--c${pts[i].m.gi + 1});--k:${i - 1}" d="${d}"/>`;
        }
        pts.forEach((p, i) => {
            const br = L.badge ?? 9, s = p.s, o2 = (s.rr || s.r) + br + 3, bx = s.x - s.d.x * o2, by = s.y - s.d.y * o2;
            hb += `<g class="gb${anim}" style="--c:var(--c${p.m.gi + 1});--k:${i}"><circle cx="${f1(bx)}" cy="${f1(by)}" r="${br}"/>` +
                `<text x="${f1(bx)}" y="${f1(by + br * .43)}" style="font-size:${f1(br * 1.2)}px">${i + 1}</text></g>`;
            const el = svg.querySelector(`.st[data-g="${p.m.gi}"][data-m="${p.m.mi}"]`);
            if (el) el.classList.add('is-goal');
        });
        lay.innerHTML = h; layb.innerHTML = hb;
    }
    function renderGoalCaption(k) {
        const g = GOALS_M[k], mods = g.mods;
        const a = mods.reduce((s, m) => s + m.a, 0), q = mods.reduce((s, m) => s + m.q, 0);
        capEl.style.removeProperty('--t'); capEl.style.removeProperty('--c');
        let h = `<p><span class="cap-k">路线 ${k + 1} / ${GOALS_M.length}</span><b>${g.name}</b> — ${g.desc}</p>`;
        h += '<p>' + (g.pre ? `先读 <a href="${withBase('/interview/0_overview')}" data-link="/interview/0_overview">开发总结</a>（${model.totals.answerPages} 个答案页），再按顺序：` : '') +
            mods.map((m, i) => `<span class="cap-n">${i + 1}</span>${link(m)}`).join(' → ') + '</p>';
        h += `<p>${mods.length} 站 · ${a} 篇${q ? ' · ' + q + ' 题' : ''} <span class="cap-note">· 编辑推荐路线，可按需增减</span></p>`;
        capEl.innerHTML = h;
    }
    function setGoal(k) {
        goal = null;
        pinned = null; syncPressed(); setActive(null, null);
        goal = k;
        gtabs.forEach((b) => {
            const sel = +b.getAttribute('data-k') === (k === null ? -1 : k);
            b.setAttribute('aria-selected', String(sel)); b.tabIndex = sel ? 0 : -1;
        });
        svgs.forEach((svg) => drawGoal(svg, k));
        if (k === null) renderCaption(null); else renderGoalCaption(k);
    }
    on(document, 'keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (goal !== null) { setGoal(null); return; }
        if (pinned !== null) { pinned = null; syncPressed(); restore(); }
    });
    if (!reduce && shareEl) {
        shareEl.classList.add('intro');
        const t = setTimeout(() => shareEl.classList.remove('intro'), 2200);
        off.push(() => clearTimeout(t));
    }

    /* route bar scroll-spy + reveal */
    const routeLinks = $$('.route a');
    function markRoute(idx) {
        routeLinks.forEach((a, i) => {
            a.classList.toggle('is-cur', i === idx);
            a.classList.toggle('is-past', idx != null && i < idx);
            if (i === idx) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
        });
        const cur = routeLinks[idx];
        const ol = cur && cur.parentNode && cur.parentNode.parentNode;
        if (ol && ol.scrollWidth > ol.clientWidth) {
            const li = cur.parentNode;
            ol.scrollTo({left: li.offsetLeft - (ol.clientWidth - li.offsetWidth) / 2, behavior: reduce ? 'auto' : 'smooth'});
        }
    }
    if ('IntersectionObserver' in window) {
        const spy = new IntersectionObserver((entries) => {
            entries.forEach((en) => { if (en.isIntersecting) markRoute(+en.target.getAttribute('data-g')); });
        }, {rootMargin: '-40% 0px -55% 0px'});
        $$('.gblock').forEach((b) => spy.observe(b));
        const rv = new IntersectionObserver((entries) => {
            entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); rv.unobserve(en.target); } });
        }, {rootMargin: '0px 0px -8% 0px'});
        root.classList.add('js-reveal');
        $$('.reveal').forEach((el) => rv.observe(el));
        off.push(() => { spy.disconnect(); rv.disconnect(); });
    }

    /* internal links in v-html content go through the router */
    on(root, 'click', (e) => {
        const a = e.target.closest('a[data-link]');
        if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(a.getAttribute('data-link'));
    });

    renderCaption(null);
    return () => off.forEach((fn) => fn());
}
