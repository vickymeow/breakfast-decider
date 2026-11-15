// axe-core 无障碍检查（WCAG 2.x A/AA + 最佳实践），妈妈的三个页签 + 女儿的点菜页
const { open } = require('./lib');
const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WHEN = process.argv[2] || '2026-11-15T16:30:00-08:00';
(async () => {
  const all = [];
  for (const [role, views] of [['mom', ['today', 'shop', 'recipes']], ['kid', ['order']]]) {
    const t = await open(role, WHEN);
    for (const v of views) {
      await t.page.click(`#nav button[data-view="${v}"]`); await t.page.waitForTimeout(400);
      await t.page.addScriptTag({ content: AXE });
      const r = await t.page.evaluate(async () => { const res = await axe.run(document.querySelector('.view.active'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] } }); return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, ex: v.nodes.slice(0, 3).map((x) => x.target.join(' ') + ' :: ' + (x.failureSummary || '').split('\n')[1]) })); });
      for (const x of r) all.push({ role, view: v, ...x });
    }
    await t.close();
  }
  fs.writeFileSync('axe-before.json', JSON.stringify(all, null, 1));
  for (const x of all) console.log(x.role, x.view, x.impact, x.id, x.n, '|', x.help, '|', (x.ex[0] || '').slice(0, 140));
})();
