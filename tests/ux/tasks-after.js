// 改版后：妈妈端主要流程跑一遍，数点击；同时收集页面报错，截图
const { open, API } = require('./lib');
const { execSync } = require('child_process');
const fs = require('fs');
const WHEN = '2026-11-15T16:30:00-08:00';
const OUT = 'shots-after'; fs.mkdirSync(OUT, { recursive: true });
const reset = () => execSync('cp fixture.json db-8787.json');
const post = (p, j) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) }).then((r) => r.json());
const db = () => JSON.parse(fs.readFileSync('db-8787.json', 'utf8'));
const out = []; const errors = [];
async function run(name, role, fn) {
  reset(); await post('/api/wishes', { who: 'kid', dishId: 1794650647040 });  // 女儿想吃丝瓜汤
  const t = await open(role, WHEN);
  t.page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
  t.page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  let ok = true, note = '';
  try { note = (await fn(t)) || ''; } catch (e) { ok = false; note = 'FAIL ' + e.message.split('\n')[0]; await t.page.screenshot({ path: `${OUT}/fail-${out.length}.png`, fullPage: true }).catch(() => {}); }
  out.push({ name, taps: t.taps, ok, note, path: t.log.join(' > ') }); await t.close();
}
async function say(t, text) {   // 测试里没有话筒：用「打字」代替说话（等于按一下话筒、说完）
  if (!(await t.page.locator('.view.active .vform').isVisible())) await t.page.locator('.view.active .vlink').click();
  t.taps++; t.log.push('（话筒，说一句）');
  await t.page.locator('.view.active .vform input').fill(text);
  await t.page.locator('.view.active .vform button[type=submit]').click();
  await t.page.waitForSelector('#sheetBody #iOk, #sheetBody .opt, #sheetBody h3', { timeout: 8000 }); await t.page.waitForTimeout(600);
}
(async () => {
  await run('首页截图', 'mom', async (t) => { await t.page.screenshot({ path: `${OUT}/mom-today.png`, fullPage: true }); const y = await t.yOf('#bfLine'); return `明早在第 ${y} 屏，页面 ${await t.screens()} 屏`; });
  await run('说一句：周三做鱼+周五饺子+葱姜+丝瓜汤做不了', 'mom', async (t) => {
    await say(t, '星期三做鱼，礼拜五包饺子，买点葱姜，丝瓜汤这次做不了没丝瓜了');
    await t.page.screenshot({ path: `${OUT}/mom-heard.png`, fullPage: true });
    const rows = await t.page.locator('#sheetBody .act').count();
    await t.tap('#iOk', '对，就这样');
    await t.page.waitForSelector('#sheetBody .opt', { timeout: 8000 }); await t.page.waitForTimeout(800);
    await t.page.screenshot({ path: `${OUT}/mom-category.png`, fullPage: true });
    await t.tap(t.page.locator('#sheetBody .opt', { hasText: '红烧鱼块' }), '点新做法 红烧鱼块');
    await t.page.waitForSelector('#dsYes', { timeout: 8000 });
    await t.page.screenshot({ path: `${OUT}/mom-recipe.png`, fullPage: true });
    await t.tap('#dsYes', '加'); await t.page.screenshot({ path: `${OUT}/mom-days.png`, fullPage: true });
    await t.tap('#dsGo', '就这天');
    await t.page.waitForTimeout(1200);
    const d = db(); const name = (id) => d.dishes.find((x) => x.id === id)?.name;
    const wed = d.plans['2026-11-18'].cook, fri = d.plans['2026-11-20'].cook;
    const shop = d.shopping.filter((x) => !x.done).map((x) => x.name);
    const silk = d.wishes.some((w) => w.dishId === 1794650647040);
    const inbox = (d.inbox || []).filter((x) => x.to === 'kid').map((x) => x.body).join(' / ');
    return `确认单 ${rows} 行；周三=${wed.dishIds.map(name).join('+')} 还没定=${wed.pending || '无'}；周五=${fri.dishIds.map(name).join('+')}；菜篮子=${shop.join('、')}；丝瓜汤心愿还在=${silk}；给女儿的消息=${inbox}`;
  });
  await run('说一句：周三做清蒸鲈鱼（具体的菜）', 'mom', async (t) => {
    await say(t, '星期三做清蒸鲈鱼'); await t.tap('#iOk', '对，就这样'); await t.page.waitForSelector('#dOk', { timeout: 8000 });
    await t.page.screenshot({ path: `${OUT}/mom-done.png`, fullPage: true });
    await t.tap('#dOk', '好');
    const d = db(); return `周三=${d.plans['2026-11-18'].cook.dishIds.length} 道；菜篮子=${d.shopping.map((x) => x.name + (x.from ? '(' + x.from + ')' : '')).join('、')}`;
  });
  await run('说一句后撤销', 'mom', async (t) => {
    await say(t, '星期三做清蒸鲈鱼'); await t.tap('#iOk', '对'); await t.page.waitForSelector('#dUndo'); await t.tap('#dUndo', '撤销'); await t.page.waitForTimeout(1200);
    const d = db(); return `撤销后周三=${JSON.stringify(d.plans['2026-11-18'].cook.dishIds)}；菜篮子 ${d.shopping.length} 样`;
  });
  await run('说一句：鸡蛋买两盒 → 鸡蛋买到了，葱家里有', 'mom', async (t) => {
    await post('/api/shopping', { op: 'add', names: ['葱'] });
    await t.page.reload(); await t.page.waitForTimeout(1000);
    await say(t, '鸡蛋买两盒'); await t.tap('#iOk', '对'); await t.page.waitForSelector('#dOk'); await t.tap('#dOk', '好');
    await say(t, '鸡蛋买到了，葱家里有'); await t.tap('#iOk', '对'); await t.page.waitForSelector('#dOk'); await t.tap('#dOk', '好');
    const d = db(); return d.shopping.map((x) => x.name + (x.note ? '[' + x.note + ']' : '') + (x.done ? '✓' : '')).join('、');
  });
  await run('问：今晚几个人回来吃', 'mom', async (t) => { await say(t, '今晚几个人回来吃'); const txt = await t.page.locator('#sheetBody').innerText(); return txt.replace(/\s+/g, ' ').slice(0, 90); });
  await run('听不懂的话不乱加', 'mom', async (t) => { await say(t, '我不吃了'); const txt = await t.page.locator('#sheetBody').innerText(); return txt.replace(/\s+/g, ' ').slice(0, 60) + ' | 菜篮子 ' + db().shopping.length + ' 样'; });
  await run('首页：丝瓜汤 做不了（点两下）', 'mom', async (t) => {
    await t.tap(t.page.locator('#tonightCard [data-decline]').first(), '做不了'); await t.tap(t.page.locator('#tonightCard [data-decline]').first(), '确定');
    await t.page.waitForTimeout(800); const d = db(); return '丝瓜汤心愿还在=' + d.wishes.some((w) => w.dishId === 1794650647040);
  });
  await run('首页：丝瓜汤 今晚做（点一下）', 'mom', async (t) => {
    await t.tap(t.page.locator('#tonightCard [data-tonight]').first(), '今晚做'); await t.page.waitForTimeout(800);
    const d = db(); const c = d.plans['2026-11-15'].cook.dishIds; return `今晚 ${c.length} 道，含丝瓜汤=${c.includes(1794650647040)}；菜篮子=${d.shopping.map((x) => x.name).join('、')}`;
  });
  await run('菜谱：浏览，点开一道菜，点周二', 'mom', async (t) => {
    await t.tap('#nav button[data-view="recipes"]', '菜谱'); await t.page.screenshot({ path: `${OUT}/mom-recipes.png`, fullPage: true });
    await t.tap(t.page.locator('#recipeGrid .card', { hasText: '孜然牛肉' }), '点孜然牛肉');
    await t.page.screenshot({ path: `${OUT}/mom-dish.png`, fullPage: true });
    await t.tap(t.page.locator('#dsAct .dgrid button', { hasText: '周二' }), '点周二'); await t.page.waitForTimeout(1000);
    const d = db(); return '周二=' + JSON.stringify(d.plans['2026-11-17']?.cook?.dishIds) + '；菜篮子 ' + d.shopping.length + ' 样';
  });
  await run('菜谱：帮我想新菜 → 看做法 → 先不加', 'mom', async (t) => {
    await t.tap('#nav button[data-view="recipes"]', '菜谱'); await t.tap('#btnMenuSuggest', '帮我想新菜');
    await t.page.waitForSelector('#sheetBody [data-see]'); await t.page.screenshot({ path: `${OUT}/mom-ideas.png`, fullPage: true });
    await t.tap(t.page.locator('#sheetBody [data-see]').first(), '看做法'); await t.page.waitForSelector('#dsNo');
    const mid = db().shopping.length; await t.tap('#dsNo', '先不加'); await t.page.waitForTimeout(1200);
    const d = db(); return `菜谱加了 西兰花炒牛肉=${d.dishes.some((x) => x.name === '西兰花炒牛肉')}；菜篮子 加时 ${mid} 样 → 先不加后 ${d.shopping.length} 样`;
  });
  await run('菜篮子页', 'mom', async (t) => {
    await post('/api/shopping', { op: 'add', names: ['牛奶'] });
    await t.tap('#nav button[data-view="shop"]', '菜篮子'); await t.page.screenshot({ path: `${OUT}/mom-shop.png`, fullPage: true });
    const r = await t.page.locator('#shopRemind').innerText(); const form = await t.page.locator('#shopForm').isVisible();
    return `提醒：${r.replace(/\s+/g, ' ')}；输入框显示=${form}`;
  });
  await run('小陈：这几天', 'jim', async (t) => {
    await t.page.screenshot({ path: `${OUT}/jim-days.png`, fullPage: true });
    await t.tap(t.page.locator('#daysList [data-pickbf]').first(), '早饭 去菜谱挑');
    await t.page.screenshot({ path: `${OUT}/jim-pick.png`, fullPage: true });
    await t.tap(t.page.locator('#listBreakfast li', { hasText: '蒸饺' }).locator('[data-act="bf"]'), '就吃这个'); await t.page.waitForTimeout(800);
    await t.tap('#pickBack', '回到这几天');
    const v = await t.page.locator('#daysList .dcard').first().innerText();
    return v.replace(/\s+/g, ' ').slice(0, 120);
  });
  console.table(out.map((o) => ({ 流程: o.name, 点几下: o.taps, 成功: o.ok, 结果: o.note.slice(0, 150) })));
  for (const o of out) console.log('-', o.name, '|', o.note);
  console.log('页面报错:', errors.length ? errors : '无');
})();
