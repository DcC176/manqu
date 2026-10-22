/* ============================================================================
 * 满区 · 本地弹幕增噪  (content script)
 * ----------------------------------------------------------------------------
 * 工作原理
 *   1. 只读取直播间聊天区已经渲染出来的 DOM 节点（[data-danmaku] 属性）。
 *   2. 在滑动时间窗内统计文本重复度，命中阈值判定为"独轮车"。
 *   3. 在播放器上方叠加一层独立 canvas，把命中的文本重复绘制成滚动弹幕。
 *
 * 边界（重要）
 *   - 不写入页面 DOM（不污染直播间、不影响他人）。
 *   - 不调用任何 B 站接口、不建立任何网络连接、不发送任何弹幕。
 *   - 模拟内容只存在于本机浏览器渲染层，观众与主播均不可见。
 * ========================================================================== */
(() => {
  'use strict';

  // 不因 window 上已有标记就直接退出：扩展重载后旧脚本会残留，
  // 必须让新脚本接管，旧实例靠自身的上下文检测退出。
  window.__CRN_ACTIVE__ = true;

  /* ------------------------------- 配置 ---------------------------------- */

  const DEFAULTS = {
    enabled: true,
    intensity: 55,   // 模拟密度 0-100
    threshold: 4,    // 窗口内重复次数达到该值判定为独轮车
    colorize: false, // 模拟弹幕是否随机上色
    badge: true      // 右下角"本地模拟"角标
  };

  const cfg = { ...DEFAULTS };

  const WIN_MS = 30000;      // 识别滑动窗口
  const POOL_TTL = 25000;    // 独轮车在生成池中的存活时间
  const MAX_ITEMS = 600;     // 同屏模拟弹幕上限
  const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

  const LIST_SEL = [
    '.chat-history-list', '#chat-items', '.chat-items',
    '.room-history-list', '.danmaku-item-wrap', '.list-box'
  ].join(',');

  // 聊天区里的非弹幕消息（礼物 / 系统 / 进场 / SC / 榜单等）
  const BAD_CLASS = /gift-item|system-msg|welcome-msg|guard-buy|superchat|hot-rank|interact|common-info|list-notice|anchor-msg|guard-enter/;

  const PALETTE = ['#ffffff', '#ffffff', '#ffffff', '#ffd166', '#7ce0ff', '#ff9ec4', '#a0ff9e'];

  /* ------------------------------- 状态 ---------------------------------- */

  const stats = new Map();   // 归一化文本 -> { times: number[] }
  const pool = new Map();    // 归一化文本 -> { text, hot }
  const seen = new WeakSet();
  const seenIds = new Set();
  const idOrder = [];

  let listEl = null;
  let observer = null;
  let captured = 0;
  let detected = 0;
  let generated = 0;
  let acc = 0;
  let lastTick = performance.now();

  const $ = (s, r = document) => r.querySelector(s);

  function waitFor(fn, timeout = 12000, step = 300) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(poll, step);
      })();
    });
  }

  /* --------------------------- 生命周期守卫 ------------------------------ */

  // 扩展被重载或更新后，页面里已注入的旧脚本会变成"僵尸"：定时器还在跑，
  // 但 chrome.* 已断开，任何调用都会抛 "Extension context invalidated"。
  // 下面统一兜住：先探测上下文，失效则安静地把自己的 UI 和画面拆掉。
  let dead = false;
  const timers = [];

  function chromeAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    timers.forEach(clearInterval);
    timers.length = 0;
    try { if (observer) observer.disconnect(); } catch (_) {}
    Layer.running = false;
    try { Layer.canvas && Layer.canvas.remove(); } catch (_) {}
    try { ui && ui.root.host.remove(); } catch (_) {}
  }

  function save(obj) {
    if (dead) return;
    if (!chromeAlive()) return shutdown();
    try { chrome.storage.local.set(obj); } catch (_) { shutdown(); }
  }

  /* ------------------------------- 采集 ---------------------------------- */

  function thresholdFor(key) {
    // 区区模式：出现过一次就进池，整个区什么都能刷
    if (cfg.threshold <= 1) return 1;
    // 越短的文本越可能是自然互动（"666""哈哈哈"），阈值抬高，避免误判。
    if (key.length <= 3) return cfg.threshold + 4;
    if (key.length <= 8) return cfg.threshold;
    return Math.max(2, cfg.threshold - 1);
  }

  function record(text, ts) {
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key) return;

    captured++;

    let e = stats.get(key);
    if (!e) {
      e = { times: [] };
      stats.set(key, e);
    }

    const tail = e.times[e.times.length - 1];
    if (tail && ts < tail) ts = tail;   // 时钟回退 / 历史乱序时夹住
    e.times.push(ts);

    const cut = ts - WIN_MS;
    while (e.times.length && e.times[0] < cut) e.times.shift();

    if (e.times.length >= thresholdFor(key)) {
      if (!pool.has(key)) detected++;
      pool.set(key, { text: key, hot: Date.now() });
    }
  }

  // 聊天区一旦整段重建，节点引用会全部换新，WeakSet 兜不住。
  // 这里再用 B 站自己的弹幕 id 做一层去重，避免同一条被重复计入。
  function firstTime(id) {
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    idOrder.push(id);
    if (idOrder.length > 5000) seenIds.delete(idOrder.shift());
    return true;
  }

  function accept(el) {
    if (!el || el.nodeType !== 1) return;

    const raw = el.getAttribute('data-danmaku');
    if (!raw) return;

    // 有 B 站自带 id 时以 id 为准（可兼容节点复用）；没有才退化为按元素去重。
    const id = el.getAttribute('data-id_str');
    if (id) {
      if (!firstTime(id)) return;
    } else {
      if (seen.has(el)) return;
      seen.add(el);
    }

    const text = raw.trim();
    if (!text || text.length > 80) return;
    if (/^\[[^\]]{1,12}\]$/.test(text)) return;         // 纯表情占位符

    const type = el.getAttribute('data-type');
    if (type && type !== '0') return;                    // 只认普通弹幕

    if (BAD_CLASS.test(String(el.className || '').toLowerCase())) return;

    let ts = parseInt(el.getAttribute('data-ts'), 10);
    if (!ts || ts < 1e9) ts = Math.floor(Date.now() / 1000);

    record(text, ts * 1000);
  }

  function scan(root) {
    root.querySelectorAll('[data-danmaku]').forEach(accept);
  }

  function onMutations(muts) {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute && node.hasAttribute('data-danmaku')) accept(node);
        if (node.firstElementChild) scan(node);
      }
    }
  }

  function waitForList() {
    if (listEl && listEl.isConnected) return;

    const el = $(LIST_SEL);
    if (!el) return;   // 由外部定时器重试，避免自我递归叠加出多条重试链

    listEl = el;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onMutations);
    observer.observe(el, { childList: true, subtree: true });

    scan(el);
  }

  /* --------------------------- 弹幕样式采样 ------------------------------ */

  // 读页面里真实弹幕元素的计算样式，让模拟弹幕跟用户当前设置保持一致。
  // 容器为空（当前没有弹幕在飞）时保留上一次采样值，从未采到则用默认。
  const look = {
    fs: 0,
    weight: 400,
    alpha: 1,
    stroke: 0,
    family: '',
    colors: ['#ffffff']
  };

  const fontOf = (size) => `${look.weight} ${size}px ${look.family || FONT}`;

  function sampleLook() {
    if (dead) return;
    const box = document.querySelector('.danmaku-item-container');
    if (!box) return;

    // 不依赖具体类名：B 站弹幕条目可能有多层包装，只认「有文本的叶子节点」，
    // 继承下来的 fontSize 才是最终渲染值。
    const tally = new Map();
    const colors = [];
    let seen = 0;

    for (const el of box.querySelectorAll('*')) {
      if (++seen > 60) break;
      if (el.children.length) continue;
      if (!el.textContent || !el.textContent.trim()) continue;

      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      if (!(fs >= 10 && fs <= 60)) continue;

      const rgb = cs.color.match(/\d+/g);
      colors.push(rgb && rgb.length >= 3 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : '#ffffff');

      const weight = parseInt(cs.fontWeight, 10) || 400;
      const alpha = Math.min(1, Math.max(0.1, parseFloat(cs.opacity) || 1));
      const key = `${Math.round(fs)}|${weight}|${alpha.toFixed(2)}`;

      const hit = tally.get(key);
      if (hit) hit.n++;
      else tally.set(key, {
        n: 1, fs, weight, alpha,
        stroke: parseFloat(cs.webkitTextStrokeWidth) || 0,
        family: cs.fontFamily || ''
      });
    }

    let best = null;
    for (const v of tally.values()) if (!best || v.n > best.n) best = v;
    if (!best) return;

    look.fs = best.fs;
    look.weight = best.weight;
    look.alpha = best.alpha;
    look.stroke = best.stroke;
    if (best.family) look.family = best.family;

    // 保留重复项，等于按真实出现频率加权：白弹幕多，模拟出来也以白色为主。
    look.colors = colors.slice(0, 40);
  }

  /* ------------------------------- 渲染 ---------------------------------- */

  const Layer = {
    canvas: null,
    ctx: null,
    items: [],
    rowRight: [],
    w: 0,
    h: 0,
    dpr: 0,
    fontSize: 20,
    rowH: 30,
    rowScale: 1.45,
    rows: 0,
    running: false,
    lastT: 0,
    target: 60,
    acc: 0,
    dprCap: 1.5,
    total: 0,
    samples: 0,
    frameMs: 0,
    frame: 0,
    video: null,
    box: null,
    rect: null,

    init() {
      // 扩展重载后旧实例的 canvas 可能还挂着，先清掉
      const stale = document.getElementById('crn-canvas');
      if (stale) stale.remove();

      const c = document.createElement('canvas');
      c.id = 'crn-canvas';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;' +
        'z-index:2147483000;will-change:transform;';
      this.canvas = c;
      this.ctx = c.getContext('2d', { alpha: true });
      document.body.appendChild(c);
    },

    host() {
      const fs = document.fullscreenElement;
      return fs && fs.tagName !== 'VIDEO' ? fs : document.body;
    },

    pickVideo() {
      let best = null;
      let area = 0;
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) continue;
        const a = r.width * r.height;
        if (a > area) { area = a; best = v; }
      }
      return best;
    },

    sync() {
      // 每 8 帧才重新量一次位置：getBoundingClientRect 会强制布局，
      // 逐帧调用在高密度下是纯主线程浪费。
      const refresh = (this.frame++ & 7) === 0 || !this.rect || !this.video || !this.video.isConnected;

      if (refresh) {
        this.video = this.pickVideo();
        this.box = document.querySelector('.danmaku-item-container');

        const el = (this.box && this.box.isConnected) ? this.box : this.video;
        const r = el ? el.getBoundingClientRect() : null;
        this.rect = r;
        if (!r || r.width < 80 || r.height < 80) return false;

        const host = this.host();
        if (this.canvas.parentElement !== host) host.appendChild(this.canvas);

        this.canvas.style.transform = `translate3d(${r.left}px,${r.top}px,0)`;
        this.resize(r.width, r.height);
      }

      return !!this.rect && this.rect.width >= 80 && this.rect.height >= 80;
    },

    resize(w, h) {
      // 上限 1.5：高密度下 canvas 光栅化与合成是主要开销，2 倍分辨率要多付 78% 的像素，
      // 而弹幕一直在动，肉眼看不出这点清晰度差异。
      const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
      // 字号优先跟随页面真实弹幕，采样不到再按播放器高度推算
      const fs = look.fs > 0 ? look.fs : Math.max(15, Math.min(28, h * 0.038));
      // 密度超过 100 后逐步压紧行距：1.45 倍字高 → 500 时 1.0 倍
      const scale = cfg.intensity > 100
        ? Math.max(1.0, 1.45 - ((cfg.intensity - 100) / 400) * 0.45)
        : 1.45;

      if (this.w === w && this.h === h && this.dpr === dpr
          && this.fontSize === fs && this.rowScale === scale) return;

      const fsChanged = this.fontSize !== fs;

      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.fontSize = fs;
      this.rowScale = scale;
      this.rowH = fs * scale;

      const rows = Math.max(3, Math.floor(h / this.rowH));
      if (rows !== this.rows) {
        this.rows = rows;
        this.rowRight = new Array(rows).fill(-1e9);
      }

      // 只有字号变了才作废已有弹幕（文本宽度是按字号量出来的），
      // 拖动密度滑块时不清屏，否则会一路闪。
      if (fsChanged) this.items.length = 0;
      this.ctx.font = fontOf(fs);
    },

    spawn(text) {
      // 首次投放前必须先同步尺寸，否则轨道数为 0，永远投不进来。
      if (!this.ctx || !this.sync()) return false;
      if (this.items.length >= MAX_ITEMS) return false;

      const free = [];
      let pick = 0;
      let minRight = Infinity;
      for (let i = 0; i < this.rows; i++) {
        const right = this.rowRight[i];
        if (right + 34 < this.w) free.push(i);
        if (right < minRight) { minRight = right; pick = i; }
      }

      // 低密度：没有空闲轨道就放弃这一条，宁可稀疏也不叠字。
      // 高密度（>100）：放开限制，挑最快腾空的一行硬投，接受重叠。
      if (!free.length) {
        if (cfg.intensity <= 100) return false;
        free.push(pick);
      }

      const row = free[(Math.random() * free.length) | 0];
      const color = cfg.colorize
        ? PALETTE[(Math.random() * PALETTE.length) | 0]
        : look.colors[(Math.random() * look.colors.length) | 0];

      this.ctx.font = fontOf(this.fontSize);
      const w = this.ctx.measureText(text).width;

      const item = {
        text,
        color,
        w,
        x: this.w + 8,
        y: row * this.rowH + 4,
        row,
        speed: (this.w / 9) * (0.92 + Math.random() * 0.26)
      };
      this.items.push(item);

      // 立刻占用该轨道。若等下一帧再算，连续两次投放会选中同一行造成重叠。
      const right = item.x + item.w;
      if (right > this.rowRight[row]) this.rowRight[row] = right;

      this.start();
      return true;
    },

    start() {
      if (this.running) return;
      this.running = true;
      this.lastT = performance.now();
      requestAnimationFrame(this.loop);
    },

    loop: function (t) {
      if (!Layer.running || dead) return;

      const dt = Math.min((t - Layer.lastT) / 1000 || 0.016, 0.05);
      Layer.lastT = t;

      if (!cfg.enabled || !Layer.sync()) {
        Layer.items.length = 0;
        if (Layer.ctx) Layer.ctx.clearRect(0, 0, Layer.w, Layer.h);
        Layer.running = false;
        return;
      }

      // 每 60 帧看一次平均帧时间，低于 50fps 就退到 30fps：
      // 稳定的 30 比在 40–60 之间波动看起来顺。单向降级，不自动升回。
      // 前 90 帧不计，避开开局加载与尺寸变化造成的假象。
      Layer.total++;
      Layer.samples++;
      Layer.frameMs += dt;
      if (Layer.samples >= 60) {
        const avg = Layer.frameMs / Layer.samples;
        if (Layer.total > 90) {
          if (Layer.target === 60 && avg > 0.020) {
            // 一级：先降帧率，观感损失最小
            Layer.target = 30;
            Layer.acc = 0;
          } else if (Layer.target === 30 && avg > 0.040 && Layer.dprCap > 1) {
            // 二级：30fps 都撑不住，再降渲染分辨率（像素量少 56%）
            Layer.dprCap = 1;
            Layer.rect = null;
          }
        }
        Layer.samples = 0;
        Layer.frameMs = 0;
        if (Layer.canvas) Layer.canvas.dataset.quality = Layer.target + '@' + Layer.dprCap;
      }

      // 降帧时靠累积时间控制绘制节奏，位移仍按真实经过时间推进，速度不变。
      let step = dt;
      if (Layer.target < 60) {
        Layer.acc += dt;
        if (Layer.acc < 1 / Layer.target) {
          requestAnimationFrame(Layer.loop);
          return;
        }
        step = Math.min(Layer.acc, 0.1);
        Layer.acc = 0;
      }

      const items = Layer.items;
      const rr = Layer.rowRight;
      rr.fill(-1e9);

      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        it.x -= it.speed * step;
        if (it.x + it.w < -10) {
          // swap-pop 取代 splice：大数组下避免整段搬移
          const last = items.pop();
          if (i < items.length) items[i] = last;
          continue;
        }
        const right = it.x + it.w;
        if (right > rr[it.row]) rr[it.row] = right;
      }

      const ctx = Layer.ctx;
      ctx.clearRect(0, 0, Layer.w, Layer.h);
      ctx.font = fontOf(Layer.fontSize);
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.globalAlpha = look.alpha;

      // B站 DOM 弹幕用 -webkit-text-stroke 纯黑细边。canvas 这边描边过粗会让笔画粘连，
      // 过透明又会让边缘发虚，两者在快速移动时都会被误看成重影，取中间值。
      const lw = look.stroke > 0 ? look.stroke * 1.6 : Math.max(1.5, Layer.fontSize * 0.07);
      for (const it of items) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(it.text, it.x, it.y);
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.x, it.y);
      }
      ctx.globalAlpha = 1;

      if (cfg.badge) {
        // 画在视频上，明暗背景都要能看清：白字 + 深色描边
        const by = Layer.h - Math.max(14, Layer.fontSize * 0.75);
        ctx.font = `${Math.max(10, Layer.fontSize * 0.52)}px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.30)';
        ctx.strokeText('本地模拟', 12, by);
        ctx.fillStyle = 'rgba(255,255,255,0.66)';
        ctx.fillText('本地模拟', 12, by);
      }

      if (items.length) {
        requestAnimationFrame(Layer.loop);
      } else {
        Layer.running = false;
      }
    }
  };

  /* ------------------------------- 生成 ---------------------------------- */

  function tick(now) {
    if (dead) return;
    requestAnimationFrame(tick);

    const dt = Math.min((now - lastTick) / 1000, 0.25);
    lastTick = now;

    if (!cfg.enabled) { acc = 0; return; }

    const nowMs = Date.now();
    for (const [k, v] of pool) {
      if (nowMs - v.hot > POOL_TTL) pool.delete(k);
    }
    if (!pool.size) { acc = 0; return; }

    acc += (cfg.intensity / 100) * 4.2 * dt;

    const arr = Array.from(pool.values());
    let guard = 0;
    while (acc >= 1 && guard++ < 6) {
      acc -= 1;
      if (Layer.spawn(arr[(Math.random() * arr.length) | 0].text)) generated++;
    }
    if (acc > 3) acc = 3;
  }

  /* -------------------------------- UI ----------------------------------- */

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 16px; bottom: 96px; z-index: 2147483001;
      width: 46px; height: 46px; pointer-events: none;
      font: 12px/1.5 "Microsoft YaHei", -apple-system, system-ui, sans-serif;
      color: #1f2328; -webkit-font-smoothing: antialiased;
    }
    .panel {
      position: absolute; right: 0; bottom: 0; pointer-events: auto;
      width: 208px; background: #fff; border: 1px solid #d1d9e0;
      border-radius: 10px; overflow: hidden;
      box-shadow: 0 8px 24px rgba(31,35,40,.13), 0 1px 3px rgba(31,35,40,.06);
    }
    .hd {
      display: flex; align-items: center; gap: 7px; padding: 9px 11px;
      background: #f6f8fa; border-bottom: 1px solid #d1d9e0;
      cursor: grab; user-select: none; touch-action: none;
      transition: background .15s;
    }
    .hd.dragging { cursor: grabbing; background: #e9edf2; }
    .hd.dragging * { pointer-events: none; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #bfc5cc;
      flex: none; transition: background .15s;
    }
    .dot.on { background: #1f883d; }
    .ttl { font-weight: 600; font-size: 12px; letter-spacing: .2px; flex: 1; }
    .fold {
      all: unset; box-sizing: border-box; cursor: pointer; width: 20px; height: 20px;
      line-height: 18px; text-align: center; border-radius: 5px;
      color: #59636e; font-size: 13px;
    }
    .fold:hover { background: #eaeef2; color: #1f2328; }
    .bd { padding: 11px; display: grid; gap: 12px; }
    .grp { display: grid; gap: 6px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .lab { color: #59636e; font-size: 11.5px; }
    .val { color: #1f2328; font-weight: 600; font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .val.special { color: #fd8c73; }

    .sw {
      all: unset; box-sizing: border-box; height: 24px; padding: 0 10px 0 9px;
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid #d1d9e0; border-radius: 6px; background: #fff;
      font: 600 11px/1 inherit; color: #59636e; cursor: pointer;
      transition: background .15s, border-color .15s, color .15s;
    }
    .sw:hover { background: #f6f8fa; }
    .sw:focus-visible { outline: 2px solid #0969da; outline-offset: 1px; }
    .sw i {
      width: 7px; height: 7px; border-radius: 50%; flex: none;
      border: 1.5px solid #bfc5cc; background: transparent;
      transition: background .15s, border-color .15s;
    }
    .sw.on { border-color: #8fd9a4; background: #f0faf2; color: #1a7f37; }
    .sw.on i { background: #1f883d; border-color: #1f883d; }
    .sw.on:hover { background: #e6f6ea; }

    input[type=range] {
      all: unset; box-sizing: border-box; width: 100%; height: 4px; border-radius: 2px;
      background: #e5e7eb; cursor: pointer;
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
      background: #fff; border: 1px solid #d1d9e0;
      box-shadow: 0 1px 2px rgba(31,35,40,.18); transition: border-color .15s;
    }
    input[type=range]:hover::-webkit-slider-thumb { border-color: #fd8c73; }
    input[type=range]:focus-visible { outline: 2px solid #0969da; outline-offset: 3px; }

    .stat { color: #59636e; font-size: 11px; font-variant-numeric: tabular-nums; }
    .stat b { color: #fd8c73; font-weight: 600; }
    .tip { color: #8b949e; font-size: 10.5px; line-height: 1.45; }

    .mini {
      all: unset; box-sizing: border-box; position: absolute; right: 0; bottom: 0;
      width: 46px; height: 46px; border-radius: 50%;
      background: #fff; border: 1px solid #d1d9e0; display: flex;
      align-items: center; justify-content: center; cursor: grab;
      box-shadow: 0 4px 14px rgba(31,35,40,.18); overflow: hidden;
      touch-action: none; pointer-events: auto;
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .mini.dragging {
      cursor: grabbing;
      transform: scale(1.1);
      box-shadow: 0 10px 26px rgba(31,35,40,.26);
    }
    /* 按住时暂停摆动，让缩放反馈更干净 */
    .mini.dragging img { animation-play-state: paused; }
    .mini img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      transform-origin: 50% 88%;
      animation: crn-wiggle 2.8s ease-in-out infinite;
    }
    .mini:not(.on) img { filter: grayscale(1) brightness(1.08); }
    @keyframes crn-wiggle {
      0%, 100% { transform: rotate(-2.5deg) translateY(0) scale(1); }
      25%      { transform: rotate(1.8deg) translateY(-1px) scale(1.05); }
      50%      { transform: rotate(2.6deg) translateY(0) scale(0.97); }
      75%      { transform: rotate(-1.2deg) translateY(1px) scale(1.03); }
    }
    .wrap.collapsed .panel { display: none; }
  `;

  const HTML = `
    <style>${CSS}</style>
    <div class="wrap">
      <div class="panel">
        <div class="hd">
          <span class="dot" id="dot"></span>
          <span class="ttl">满区</span>
          <button class="fold" id="fold" title="收起">—</button>
        </div>
        <div class="bd">
          <div class="row">
            <span class="lab">启用</span>
            <button class="sw" id="sw" type="button" aria-pressed="true"><i></i><span id="swt">已开启</span></button>
          </div>
          <div class="grp">
            <div class="row"><span class="lab">密度</span><span class="val" id="iv">55</span></div>
            <input type="range" id="ir" min="0" max="1000" step="5" value="55" aria-label="密度">
          </div>
          <div class="grp">
            <div class="row"><span class="lab">判定阈值</span><span class="val" id="tv">4</span></div>
            <input type="range" id="tr" min="1" max="5" step="1" value="4" aria-label="判定阈值">
          </div>
          <div class="stat" id="st">捕获 0 · 独轮车 0 · 模拟 0</div>
          <div class="tip">仅本机渲染，不会发送任何弹幕。<br>设置即时生效。</div>
        </div>
      </div>
      <button class="mini" id="mini" title="展开"><img id="miniImg" alt=""></button>
    </div>
  `;

  let ui = null;

  // 标题栏和悬浮球都可拖动；位置写入 storage，下次进直播间沿用。
  // onTap 只在实际位移小于阈值时触发——拖动结束浏览器还会补发 click，
  // 若把展开挂在 onclick 上，拖完就会误展开。
  function makeDraggable(wrap, handle, onTap) {
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false, moved = false;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.fold')) return;
      const r = wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top;
      on = true;
      moved = false;
      wrap.style.left = ox + 'px';
      wrap.style.top = oy + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      handle.classList.add('dragging');
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) moved = true;
      const r = wrap.getBoundingClientRect();
      const nx = Math.min(Math.max(4, ox + e.clientX - sx), window.innerWidth - r.width - 4);
      const ny = Math.min(Math.max(4, oy + e.clientY - sy), window.innerHeight - r.height - 4);
      wrap.style.left = nx + 'px';
      wrap.style.top = ny + 'px';
    });

    const end = (e) => {
      if (!on) return;
      on = false;
      handle.classList.remove('dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

      if (!moved) {
        if (onTap) onTap();
        return;
      }
      const r = wrap.getBoundingClientRect();
      save({ _pos: { x: Math.round(r.left), y: Math.round(r.top) } });
      layoutPanel();   // 换了位置后重新决定卡片朝哪边展开
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // 浮窗常驻不动，卡片挂在浮窗外侧展开（参考「图标+侧边卡片」的形态）。
  // 只决定卡片放在哪一侧，锚点坐标始终不变。
  function layoutPanel() {
    if (!ui || ui.wrap.classList.contains('collapsed')) return;

    const p = ui.root.querySelector('.panel');
    const w = ui.wrap.getBoundingClientRect();

    const GAP = 8;
    const MINI = 46;
    const side = MINI + GAP;

    // 默认贴在浮窗左侧，底边与浮窗底边齐平
    p.style.right = side + 'px';
    p.style.left = 'auto';
    p.style.bottom = '0';
    p.style.top = 'auto';

    const pw = p.offsetWidth;
    const ph = p.offsetHeight;

    if (w.left < pw + GAP) {        // 左侧放不下整张卡片，翻到浮窗右侧
      p.style.right = 'auto';
      p.style.left = side + 'px';
    }
    if (w.bottom < ph + GAP) {      // 上方放不下，改为向下展开
      p.style.bottom = 'auto';
      p.style.top = '0';
    }
  }

  // 只约束 46px 的锚点，卡片由 layoutPanel 负责不出界
  function clampIntoView() {
    const r = ui.wrap.getBoundingClientRect();
    const x = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - r.width - 4));
    const y = Math.min(Math.max(4, r.top), Math.max(4, window.innerHeight - r.height - 4));
    ui.wrap.style.left = x + 'px';
    ui.wrap.style.top = y + 'px';
    ui.wrap.style.right = 'auto';
    ui.wrap.style.bottom = 'auto';
  }

  function buildUI() {
    // 同上：旧实例残留的面板先移除，避免同屏两个
    const stale = document.getElementById('crn-ui-host');
    if (stale) stale.remove();

    const host = document.createElement('div');
    host.id = 'crn-ui-host';
    host.style.cssText = 'all:initial;position:static;';
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = HTML;
    ui = {
      root,
      wrap: root.querySelector('.wrap'),
      fold: root.getElementById('fold'),
      dot: root.getElementById('dot'),
      sw: root.getElementById('sw'),
      swt: root.getElementById('swt'),
      mini: root.getElementById('mini'),
      iv: root.getElementById('iv'),
      ir: root.getElementById('ir'),
      tv: root.getElementById('tv'),
      tr: root.getElementById('tr'),
      st: root.getElementById('st')
    };

    const miniImg = root.getElementById('miniImg');
    try { miniImg.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}

    ui.fold.onclick = () => {
      ui.wrap.classList.toggle('collapsed');
      save({ _collapsed: ui.wrap.classList.contains('collapsed') });
    };

    // 展开走 pointerup 判定，不挂 onclick，拖动结束时的补发 click 就不会误触
    makeDraggable(ui.wrap, root.querySelector('.hd'));
    makeDraggable(ui.wrap, ui.mini, () => {
      ui.wrap.classList.toggle('collapsed');
      save({ _collapsed: ui.wrap.classList.contains('collapsed') });
      layoutPanel();
    });

    ui.mini.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ui.wrap.classList.toggle('collapsed');
        save({ _collapsed: ui.wrap.classList.contains('collapsed') });
        layoutPanel();
      }
    });

    ui.sw.onclick = () => {
      cfg.enabled = !cfg.enabled;
      save({ enabled: cfg.enabled });
      paint();
    };
    ui.ir.oninput = () => {
      cfg.intensity = +ui.ir.value;
      save({ intensity: cfg.intensity });
      paint();
    };
    ui.tr.oninput = () => {
      cfg.threshold = +ui.tr.value;
      save({ threshold: cfg.threshold });
      paint();
    };
  }

  // 滑块已填充部分用强调色，未填充部分保持灰，避免整条轨道同色看不出进度
  function fillTrack(el) {
    const min = +el.min || 0;
    const p = ((+el.value - min) / ((+el.max || 100) - min)) * 100;
    el.style.background = `linear-gradient(90deg,#fd8c73 0 ${p}%,#e5e7eb ${p}% 100%)`;
  }

  function paint() {
    if (dead) return;
    // 每秒一次的巡检：用户重载扩展后不会点按钮，靠这里发现上下文已断
    if (!chromeAlive()) return shutdown();
    if (!ui) return;
    ui.dot.classList.toggle('on', cfg.enabled);
    ui.mini.classList.toggle('on', cfg.enabled);
    ui.sw.classList.toggle('on', cfg.enabled);
    ui.sw.setAttribute('aria-pressed', String(cfg.enabled));
    ui.swt.textContent = cfg.enabled ? '已开启' : '已关闭';
    ui.iv.textContent = cfg.intensity;
    ui.ir.value = cfg.intensity;
    fillTrack(ui.ir);
    const cart = cfg.threshold <= 1;
    ui.tv.textContent = cart ? '区区模式' : cfg.threshold;
    ui.tv.classList.toggle('special', cart);
    ui.tr.value = cfg.threshold;
    fillTrack(ui.tr);
    ui.st.innerHTML = `捕获 ${captured} · 独轮车 <b>${detected}</b> · 模拟 ${generated}`;
  }

  /* ------------------------------ 生命周期 -------------------------------- */

  function gcStats() {
    const keep = Date.now() - WIN_MS * 2;
    for (const [k, e] of stats) {
      const tail = e.times[e.times.length - 1];
      if (!tail || tail < keep) stats.delete(k);
    }
  }

  async function boot() {
    try {
      await bootInner();
    } catch (e) {
      console.error('[满区] 初始化失败：', e);
    }
  }

  async function bootInner() {
    if (!chromeAlive()) return shutdown();
    Object.assign(cfg, await chrome.storage.local.get(DEFAULTS));

    // 直播间是 SPA，DOMContentLoaded 时播放器和聊天区往往尚未挂载，
    // 因此这里必须轮询等待，不能一次判定后永久退出。
    // 判定依据只认聊天区——它是弹幕的唯一来源，没有它插件无从工作。
    const ready = await waitFor(() => $(LIST_SEL));
    if (!ready) return;

    // blanc 布局下真正的直播内容在同源 iframe 内，顶层只是外壳壳子，
    // 若壳层也挂了 video，会在同一屏出现两个面板。这里让壳层退出。
    if (window.top === window && document.querySelector('iframe[src*="/blanc/"]')) return;

    Layer.init();
    buildUI();
    paint();

    try {
      chrome.storage.local.get({ _collapsed: false, _pos: null }, (v) => {
        if (dead || !v) return;
        if (v._collapsed) ui.wrap.classList.add('collapsed');
        if (v._pos) {
          ui.wrap.style.left = v._pos.x + 'px';
          ui.wrap.style.top = v._pos.y + 'px';
          ui.wrap.style.right = 'auto';
          ui.wrap.style.bottom = 'auto';
          clampIntoView();
        }
        layoutPanel();
      });
    } catch (_) { /* 上下文已失效，交给定时器收尾 */ }

    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (dead || area !== 'local') return;
        let touched = false;
        for (const k in ch) {
          if (k in cfg) { cfg[k] = ch[k].newValue; touched = true; }
        }
        if (touched) paint();
      });
    } catch (_) { /* 同上 */ }

    sampleLook();
    waitForList();
    requestAnimationFrame(tick);

    timers.push(setInterval(sampleLook, 3000));   // 用户随时可能改弹幕设置
    timers.push(setInterval(paint, 1000));
    timers.push(setInterval(gcStats, 15000));
    timers.push(setInterval(waitForList, 2000));  // 聊天区被重建时自动重新挂载
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
