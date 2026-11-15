# 妈妈端可用性测量

不碰线上数据：用本地的假数据库跑真实的后端代码，再用手机尺寸的浏览器（iPhone 13，太平洋时间）以「妈妈」身份点一遍，数每件事要点几下、要翻几屏。改版前后各跑一次，对比结果。

`fixture.json` 是 2026-11-15 的菜单和晚饭计划（去掉了红包留言）。

```bash
cd tests/ux && npm install
./run-backend.sh ../../supabase/functions/breakfast 8787 &      # 本地后端，数据在 db-8787.json
python3 -m http.server 8080 --directory ../../docs &            # 网页
node tasks-before.js        # 五件事各要点几下（每个任务从 fixture 重新开始）
node inventory.js shots-before   # 每个页签几屏长、多少能点的东西，截全页图
node axe.js                 # axe-core 无障碍检查
python3 sheet.py shots-before/mom-today.png sheet.png   # 长截图切成一屏一格
```

Playwright 用机器上已有的那份（`require('playwright')`）。
