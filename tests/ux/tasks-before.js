// 基线：现在的网页上，妈妈完成五件事最少要点几下、要往下翻多少屏。每个任务用新的数据副本。
// 时间：周日 11-15 下午 4:30（妈妈要定晚饭的时候）
const { open } = require('./lib');
const { execSync } = require('child_process');
const WHEN = '2026-11-15T16:30:00-08:00';
const reset = () => execSync('cp fixture.json db-8787.json');
const out = [];
async function run(name, fn) {
  reset(); const t = await open('mom', WHEN);
  let ok = true, note = '';
  try { note = (await fn(t)) || ''; } catch (e) { ok = false; note = 'FAIL ' + e.message.split('\n')[0]; }
  out.push({ name, taps: t.taps, path: t.log.join(' > '), ok, note }); await t.close();
}
(async () => {
  await run('T1 看明早吃什么', async (t) => { const y = await t.yOf('#morningCard .name'); return `答案在第 ${y} 屏（下午晚饭排在上面）`; });
  await run('T2 看今晚谁回来、想吃什么', async (t) => { const y = await t.yOf('#dinnerBoard .count'); const y2 = await t.yOf('#dinnerBoard .person:last-child'); return `「回来吃几人」在第 ${y} 屏，最后一个人在第 ${y2} 屏`; });
  await run('T3a 定周三晚上做清蒸鲈鱼（从小饭桌）', async (t) => {
    await t.tap('#foldMoreDaysMom', '再往后几天');
    await t.tap(t.page.locator('#cookCard .tmr', { hasText: '周三' }).locator('button[data-date]'), '周三 定一下/改');
    await t.tap(t.page.locator('#chooser .chips button', { hasText: '清蒸鲈鱼' }), '点 清蒸鲈鱼');
    await t.tap('#chooserOk', '就这么定');
    const s = await t.page.evaluate(() => document.querySelector('#cookCard').innerText.includes('清蒸鲈鱼'));
    return s ? '周三显示清蒸鲈鱼' : '没看到结果';
  });
  await run('T3b 定周三晚上做清蒸鲈鱼（从菜谱本，我想做）', async (t) => {
    await t.tap('#nav button[data-view="recipes"]', '菜谱本');
    const y = await t.page.locator('#listDinner li', { hasText: '清蒸鲈鱼' }).evaluate((e) => +((e.getBoundingClientRect().top + scrollY) / innerHeight).toFixed(1));
    await t.tap(t.page.locator('#listDinner li', { hasText: '清蒸鲈鱼' }).locator('[data-act="want"]'), '我想做');
    await t.tap(t.page.locator('.daypick button', { hasText: '周三' }), '选周三');
    await t.tap('#wantStay', '接着看菜谱');
    return `清蒸鲈鱼在菜谱本第 ${y} 屏`;
  });
  await run('T4 把周三那道菜的食材放进菜篮子（先排好再买）', async (t) => {
    await t.page.evaluate(async () => { await fetch(window.BREAKFAST_API + '/api/dinner/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'mom', date: '2026-11-18', dishId: 1794650669218 }) }); });
    await t.page.reload(); await t.page.waitForTimeout(1200);
    await t.tap('#nav button[data-view="shop"]', '菜篮子');
    const before = await t.page.evaluate(() => document.querySelectorAll('#suggestBox [data-from="清蒸鲈鱼"]').length);
    for (let i = 0; i < before; i++) await t.tap(t.page.locator('#suggestBox [data-from="清蒸鲈鱼"]'), '＋ 食材');
    const n = await t.page.evaluate(() => document.querySelectorAll('#shopList .shop-item').length);
    return `要一样一样点：${before} 样，清单里现在 ${n} 样；另一条路是菜谱本里「我要买」1 下，但要先找到那道菜`;
  });
  await run('T5 做好了告诉大家', async (t) => {
    await t.tap(t.page.locator('#cookCard button[data-done]'), '做好了');
    await t.tap('#cheerOk', '好');
  });
  await run('T6 告诉女儿「酸辣鸡胗这次做不了」', async (t) => {
    const has = await t.page.evaluate(() => /做不了/.test(document.body.innerText));
    return has ? '有按钮' : '做不到：页面上没有这个选项';
  });
  console.table(out.map((o) => ({ 任务: o.name, 点几下: o.taps, 成功: o.ok, 说明: o.note })));
  require('fs').writeFileSync('tasks-before.json', JSON.stringify(out, null, 1));
})();
