// 测试工具：以某个身份、在某个时间打开网页（本地后端），提供会计数的 tap()
const { chromium, devices } = require('playwright');
const API = process.env.API || 'http://localhost:8787';
const WEB = process.env.WEB || 'http://localhost:8080';
async function open(role, when, opts = {}) {
  const ver = (await (await fetch(WEB + '/version.txt')).text()).trim();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN', timezoneId: 'America/Los_Angeles', deviceScaleFactor: opts.dsf || 1 });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(when));
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'application/javascript', body:
    `window.BREAKFAST_API=${JSON.stringify(API)};window.STORE={name:"Weee",search:"https://www.sayweee.com/en/search?keyword={q}"};window.HONGBAO={unit:"$",amounts:[5,10,20,50]};` }));
  await page.addInitScript(({ r, ver }) => { r = { r, ver }; try { localStorage.setItem('bf_role', r.r); localStorage.setItem('bf_push_later_' + r.r, '1'); localStorage.setItem('bf_ver', r.ver); } catch (e) {} }, { r: role, ver });
  await page.goto(WEB + '/index.html');
  await page.waitForFunction(() => !document.querySelector('#app').hidden && document.querySelector('#nav button'));
  await page.waitForTimeout(900);
  const log = [];
  const t = {
    browser, page, log, taps: 0,
    async tap(locator, why) { const l = typeof locator === 'string' ? page.locator(locator) : locator; await l.first().scrollIntoViewIfNeeded(); await l.first().click(); t.taps++; log.push(why || String(locator)); await page.waitForTimeout(450); },
    async screens() { return page.evaluate(() => +(document.documentElement.scrollHeight / innerHeight).toFixed(1)); },
    async yOf(sel) { return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; return +((e.getBoundingClientRect().top + scrollY) / innerHeight).toFixed(1); }, sel); },
    async close() { await browser.close(); },
  };
  return t;
}
module.exports = { open, API };
