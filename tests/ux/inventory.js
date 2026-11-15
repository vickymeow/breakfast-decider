// 清点：每个身份、每个页签，屏幕有几屏长、能点的东西有多少、小字小按钮多少；截全页图
const { open } = require('./lib');
const fs = require('fs');
const OUT = process.argv[2] || 'shots-before'; fs.mkdirSync(OUT, { recursive: true });
const WHEN = process.argv[3] || '2026-11-15T16:30:00-08:00';
(async () => {
  const res = [];
  for (const role of ['mom', 'kid']) {
    const t = await open(role, WHEN);
    const tabs = await t.page.$$eval('#nav button', (bs) => bs.map((b) => ({ v: b.dataset.view, name: b.textContent.trim() })));
    for (const tab of tabs) {
      await t.page.click(`#nav button[data-view="${tab.v}"]`); await t.page.waitForTimeout(500);
      await t.page.evaluate(() => scrollTo(0, 0));
      const info = await t.page.evaluate(() => {
        const view = document.querySelector('.view.active');
        const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]'); };
        const els = [...view.querySelectorAll('button, a, input, label')].filter(vis);
        const small = els.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; });
        const texts = [...view.querySelectorAll('*')].filter((e) => vis(e) && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
        const tiny = texts.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 18);
        const nav = document.querySelector('#nav').getBoundingClientRect().height;
        return { screens: +(document.documentElement.scrollHeight / innerHeight).toFixed(1), tappable: els.length, under44: small.length, under44list: small.slice(0, 12).map((e) => (e.textContent || e.placeholder || '').trim().slice(0, 14)), textUnder18: tiny.length, navPx: Math.round(nav),
          labels: els.map((e) => (e.textContent || e.placeholder || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 18)) };
      });
      await t.page.screenshot({ path: `${OUT}/${role}-${tab.v}.png`, fullPage: true });
      res.push({ role, tab: tab.name, view: tab.v, ...info });
    }
    await t.close();
  }
  fs.writeFileSync(`${OUT}/inventory.json`, JSON.stringify(res, null, 1));
  for (const r of res) console.log(r.role, r.tab.padEnd(6), 'screens', r.screens, 'tappable', r.tappable, 'under44', r.under44, 'text<18px', r.textUnder18);
})();
