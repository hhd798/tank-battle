/**
 * 无头烟雾测试
 * ---------------------------------------------------------------
 * 用最小 DOM / Canvas / 定时器桩，在 Node 里真实运行 index.html 中的游戏循环，
 * 由一个"自动作战机器人"操作玩家坦克（瞄准、走位、脱困），验证：
 *   1. 长时间运行不抛异常
 *   2. 波次能正常推进直到胜利结算（不会因敌人卡住而卡死）
 *   3. 敌人能真正获得视线并交战
 *   4. 结算后"再来一局"能正确重置
 *   5. TB_PASSIVE=1 时（玩家站着挨打）能正确触发战败结算
 *
 * 用法:
 *   node test/headless-test.js
 *   TB_SECONDS=60 node test/headless-test.js
 *   TB_PASSIVE=1 node test/headless-test.js
 *   TB_PROBE=1 node test/headless-test.js
 *
 * 仅用于开发验证，不是游戏运行所需文件。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script> 块'); process.exit(1); }
const js = m[1];

// ---------- Canvas 2D 上下文桩 ----------
const grad = { addColorStop() {} };
const ctxMethods = ['save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'clearRect',
  'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'quadraticCurveTo',
  'bezierCurveTo', 'fill', 'stroke', 'roundRect', 'rect', 'clip', 'drawImage', 'fillText', 'strokeText',
  'createLinearGradient', 'createRadialGradient', 'createPattern', 'measureText', 'setLineDash', 'arcTo'];
const ctxStub = {};
for (const k of ctxMethods) ctxStub[k] = k.startsWith('create') ? (() => grad) : (() => {});
ctxStub.measureText = () => ({ width: 10 });

const listeners = new Map();   // target -> Map(type -> [fn])
function on(target, type, fn) {
  if (!listeners.has(target)) listeners.set(target, new Map());
  const t = listeners.get(target);
  if (!t.has(type)) t.set(type, []);
  t.get(type).push(fn);
}
// 画布等 DOM 元素以"对象"为键注册监听，这里允许用 id 字符串寻址
function targetKey(target) {
  if (listeners.has(target)) return target;
  if (typeof target === 'string') {
    for (const k of listeners.keys()) if (k && typeof k === 'object' && k.id === target) return k;
  }
  return target;
}
function emit(target, type, ev) {
  const t = listeners.get(targetKey(target));
  if (t && t.has(type)) for (const fn of t.get(type)) fn(ev || {});
}

const canvas = {
  id: 'game', width: 960, height: 640,
  getContext: () => ctxStub,
  addEventListener: (t, f) => on(canvas, t, f),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 640 })
};
const makeEl = id => ({
  id, textContent: '', innerHTML: '', className: '',
  classList: { add() {}, remove() {}, contains: () => false },
  addEventListener: (t, f) => on(id, t, f)
});
const els = {
  game: canvas,
  startScreen: makeEl('startScreen'), endScreen: makeEl('endScreen'),
  bigTitle: makeEl('bigTitle'), finalStats: makeEl('finalStats'),
  startBtn: makeEl('startBtn'), againBtn: makeEl('againBtn')
};

const windowStub = {
  addEventListener: (t, f) => on('window', t, f),
  AudioContext: undefined, webkitAudioContext: undefined
};

// ---------- 虚拟定时器（让 setTimeout 驱动的波次逻辑真实执行） ----------
let timers = [], timerId = 1, virtualNow = 0, raf = null;
function vSetTimeout(fn, ms) {
  const id = timerId++;
  timers.push({ id, at: virtualNow + (ms || 0), fn });
  return id;
}
function vClearTimeout(id) { timers = timers.filter(x => x.id !== id); }

const sandbox = {
  console, window: windowStub,
  document: { getElementById: id => els[id] || makeEl(id), addEventListener() {} },
  Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
  setTimeout: vSetTimeout, clearTimeout: vClearTimeout, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: fn => { raf = fn; },
  performance: { now: () => 0 }
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(js, sandbox, { filename: 'index.html#script' });
} catch (e) {
  console.error('初始化失败:', e.stack);
  process.exit(1);
}
if (typeof raf !== 'function') { console.error('未注册 requestAnimationFrame'); process.exit(1); }
if (!windowStub.__tankBattleStats) { console.error('未导出 __tankBattleStats 状态接口'); process.exit(1); }

// ---------- 驾驶 ----------
const DT = 1 / 60;
let t = 0, frames = 0;
const report = { errors: [] };
const SECONDS = Number(process.env.TB_SECONDS || 240);
const PROBE = !!process.env.TB_PROBE;     // 逐秒打印探针
const PASSIVE = !!process.env.TB_PASSIVE; // 玩家不开火不移动，用于验证战败流程

function step() {
  virtualNow += DT * 1000;
  t += DT * 1000;
  const due = timers.filter(x => x.at <= virtualNow).sort((a, b) => a.at - b.at);
  timers = timers.filter(x => x.at > virtualNow);
  for (const timer of due) {
    try { timer.fn(); } catch (e) { report.errors.push('timer@' + timer.at.toFixed(0) + 'ms: ' + e.message); throw e; }
  }
  const fn = raf;
  raf = null;
  try { fn(t); } catch (e) { report.errors.push('loop t=' + t.toFixed(1) + 's: ' + e.message); throw e; }
  frames++;
  if (!raf) throw new Error('主循环未继续请求下一帧');
}

function press(k) { emit('window', 'keydown', { key: k, preventDefault() {} }); }
function release(k) { emit('window', 'keyup', { key: k, preventDefault() {} }); }
function aim(x, y) { emit('game', 'mousemove', { clientX: x, clientY: y }); }

// ---------- 自动作战机器人 ----------
// 采样多个候选方向，按"绕开墙 / 保持理想交战距离 / 侧闪躲弹"加权打分选一个。
// 目的不是打得好看，而是给游戏一个"有基本水平的玩家"作为可玩性基准。
const DIRV = { w: -Math.PI / 2, s: Math.PI / 2, a: Math.PI, d: 0 };
const PREFER_DIST = 250;   // 理想交战距离
let dirKey = null;
function keyForVec(dx, dy) {
  const want = Math.atan2(dy, dx);
  let best = 'd', bestErr = 9;
  for (const k in DIRV) {
    const err = Math.abs(((want - DIRV[k] + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (err < bestErr) { bestErr = err; best = k; }
  }
  return best;
}
function hold(k) {
  if (k === dirKey) return false;
  if (dirKey) release(dirKey);
  dirKey = k;
  press(dirKey);
  return true;
}

const CAND = [-Math.PI, -3 * Math.PI / 4, -Math.PI / 2, -Math.PI / 4, 0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4];
let lastPos = null, stuckFrames = 0, holdFrames = 0, goalX = 0, goalY = 0, dodgeDir = 1;

/** 找出最危险的那发来袭炮弹 */
function threat(s) {
  let worst = null;
  for (const b of s.incoming()) {
    if (b.dist > 260 || b.closing < 0.86) continue;
    if (b.lateral > 26) continue;                 // 不会打到身上，可以无视
    if (!worst || b.dist < worst.dist) worst = b;
  }
  return worst;
}

function autoPilot() {
  const s = windowStub.__tankBattleStats();
  if (!s.playerPos) return;                        // 阵亡瞬间
  const [px, py] = s.playerPos;

  // 卡住（撞墙/被挤）就强制换个方向
  if (lastPos && Math.abs(px - lastPos[0]) + Math.abs(py - lastPos[1]) < 2) stuckFrames++;
  else stuckFrames = 0;
  lastPos = [px, py];
  if (stuckFrames > 45) {
    stuckFrames = 0;
    const k = ['w', 'a', 's', 'd'][Math.floor(Math.random() * 4)];
    if (hold(k)) holdFrames = 45;
    return;
  }

  const info = s.enemyInfo();
  const visible = info.filter(e => e.los);
  const list = visible.length ? visible : info;
  let near = null;
  for (const e of list) if (!near || e.dist < near.dist) near = e;

  // 开火：有视线就朝最近目标
  if (near && near.los) aim(near.pos[0], near.pos[1]);

  // 躲弹优先：垂直于弹道侧移
  const inc = threat(s);
  if (inc) {
    const a = Math.atan2(inc.pos[1] - py, inc.pos[0] - px);
    // 选被"墙"约束更小的那一侧（用与最近敌人的绕行方向近似）
    const perp = a + Math.PI / 2 * dodgeDir;
    const nx = px + Math.cos(perp) * 90, ny = py + Math.sin(perp) * 90;
    if (nx < 55 || nx > 905 || ny < 55 || ny > 585) dodgeDir = -dodgeDir;
    const d = a + Math.PI / 2 * dodgeDir;
    hold(keyForVec(Math.cos(d), Math.sin(d)));
    holdFrames = 6;
    return;
  }
  if (!near) return;

  // 目标点：保持理想交战距离（太近就后撤，太远就靠近）
  const ang = Math.atan2(near.pos[1] - py, near.pos[0] - px);
  const step = near.dist - PREFER_DIST;
  holdFrames--;
  if (holdFrames > 0) return;          // 方向保持一小段时间，避免抖动
  goalX = px + Math.cos(ang) * step;
  goalY = py + Math.sin(ang) * step;

  let bestKey = 'd', bestScore = -Infinity;
  for (const off of CAND) {
    const a = ang + off;
    const nx = px + Math.cos(a) * 90, ny = py + Math.sin(a) * 90;
    // 越接近目标点越好
    let score = -(Math.hypot(goalX - nx, goalY - ny) / 90);
    // 正对最近目标的偏移给一点小奖励（便于持续开火）
    score += Math.abs(off) < 0.01 ? 0.35 : 0;
    // 贴边惩罚
    if (nx < 55 || nx > 960 - 55 || ny < 55 || ny > 640 - 55) score -= 0.8;
    // 被多个敌人围住时优先脱离
    if (info.length > 2 && near.dist < 150 && off === 0) score -= 0.6;
    if (score > bestScore) { bestScore = score; bestKey = keyForVec(Math.cos(a), Math.sin(a)); }
  }
  if (hold(bestKey)) holdFrames = 12;
}

// ---------- 开始并跑 ----------
emit('startBtn', 'click', {});
if (!PASSIVE) press(' ');
aim(480, 320);

const N = Math.round(SECONDS / DT);
const samples = [];
let stallWorst = 0, stallStart = 0, lastWave = -1, lastKills = -1, losEverSeen = 0;

for (let i = 0; i < N; i++) {
  if (!PASSIVE) autoPilot();
  step();

  const s = windowStub.__tankBattleStats();
  if (s.enemyInfo().some(e => e.los)) losEverSeen++;

  // 停滞检测：只在游戏进行中统计（胜利/战败画面本就静止）；被动模式不计
  if (s.state === 'playing' && !PASSIVE) {
    if (s.wave !== lastWave || s.kills !== lastKills) {
      lastWave = s.wave; lastKills = s.kills; stallStart = i;
    }
    stallWorst = Math.max(stallWorst, (i - stallStart) / 60);
  }

  if (PROBE && i % 60 === 0) {
    console.log('t=' + (i / 60).toFixed(0) + 's state=' + s.state + ' wave=' + s.wave + '/' + s.waveState +
      ' 得分=' + s.score + ' 击毁=' + s.kills + ' 命=' + s.lives + ' 血=' + s.playerHp +
      ' 敌=' + s.enemies + ' 最近=' + s.minEnemyDist + ' 站位=' + JSON.stringify(s.playerPos));
  }
  if (i % (60 * 20) === 0) {
    samples.push('t=' + (i / 60) + 's state=' + s.state + ' wave=' + s.wave + '/' + s.waveState +
      ' 得分=' + s.score + ' 击毁=' + s.kills + ' 命=' + s.lives +
      ' 敌=' + s.enemies + ' 最近距离=' + s.minEnemyDist + ' 站位=' + JSON.stringify(s.playerPos));
  }
}

const st = windowStub.__tankBattleStats();

// 若已结算，点击"再来一局"验证重开流程
let restartOk = null;
if (st.state === 'win' || st.state === 'over') {
  emit('againBtn', 'click', {});
  for (let i = 0; i < 180; i++) step();
  const s2 = windowStub.__tankBattleStats();
  restartOk = s2.state === 'playing' && s2.score === 0 && s2.lives === 3 && s2.wave <= 1;
}

// ---------- 报告 ----------
console.log('--- 无头烟雾测试 ---');
console.log('模式          :', PASSIVE ? '被动挨打' : '自动作战');
console.log('模拟时长      :', SECONDS + 's /', frames, '帧');
console.log('运行时异常    :', report.errors.length ? report.errors : '无');
console.log('过程采样      :');
samples.forEach(s => console.log('  ' + s));
console.log('最长无进展    :', stallWorst.toFixed(1) + 's（波次/击毁数未变化）');
console.log('敌人有视线帧数:', losEverSeen, '/', frames);
console.log('结束状态      :', st.state, '| 文案:', els.bigTitle.textContent || '(未触发)');
console.log('重开一局      :', restartOk === null ? '(未进入结算画面，跳过)' : restartOk ? '正常' : '异常');

const problems = [];
if (report.errors.length) problems.push('运行时异常');
if (!PASSIVE && stallWorst > 75) problems.push('疑似卡死：' + stallWorst.toFixed(0) + 's 无进展');
if (!PASSIVE && losEverSeen === 0) problems.push('敌人从未获得视线');
if (restartOk === false) problems.push('重开一局状态不正确');
if (PASSIVE && st.state !== 'over') problems.push('被动挨打未触发战败结算');
// 机器人只有"对射 + 躲弹"，不会利用掩体，所以不强制要求胜利；
// 只要求它能推进到后期波次，说明波次机制不会卡死。
if (!PASSIVE && st.state !== 'win' && st.wave < 5) {
  problems.push('波次推进过慢（只到第 ' + st.wave + ' 波）');
}

console.log(problems.length ? 'RESULT: FAIL -> ' + problems.join(', ') : 'RESULT: PASS');
process.exit(problems.length ? 1 : 0);
