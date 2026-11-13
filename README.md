# 早饭决定器 Breakfast Decider

给妈妈和女儿用的共享早饭决定器。女儿晚上点一张图选好，妈妈早上打开只看到一个大答案。全中文、大字、大按钮，为老人优化，不用注册不用登录，一个网址两部手机同步。

A tiny shared "what's for breakfast" app for a parent and a child. Chinese UI, big type, no accounts. One URL, both phones see the same menu and the same pick.

## 功能

- **选早饭**（女儿）：点一张图就选好；下午 3 点后自动选的是明天。也可以点「随便」（当场定下一道具体的菜）或「今天不吃」。
- **今天早上**（妈妈）：只看一个大答案，大图、超大菜名、一个「读给我听」按钮（系统中文朗读）。没选就是鸡蛋三明治。
- **菜单**：打字或语音加新菜、给每道菜拍一张真照片、删除（点两下确认）、上下排序。
- **第一次打开选「我是妈妈 / 我是女儿」**：妈妈的手机以后一打开就是今天的答案，少一个页签，字再大一号。
- **添加到主屏幕**：带图标和名字，像一个 App 一样打开。
- **同步**：每 10 秒拉一次，切回页面时立刻刷新。

## 结构

```
web/index.html                         前端（纯 HTML/CSS/JS，没有框架）
web/icon.png                           主屏幕图标
supabase/functions/breakfast/index.ts  后端：Supabase Edge Function，同时托管网页和接口
supabase/functions/breakfast/assets.ts 由 scripts/build.js 生成：把网页和图标打进函数
supabase/migrations/...sql             一张表（一行 JSON）+ 一个公开图片桶
scripts/build.js                       改完 web/ 后运行：node scripts/build.js
```

数据存在 `breakfast_state` 表的一行 JSON 里，只有云函数用 service role 读写，表本身对外没有任何策略。照片存在公开桶 `breakfast`，上传只经过云函数（限 5MB、jpg/png/webp）。

## 部署（Supabase 免费版够用）

1. 在 [Supabase](https://supabase.com) 新建一个项目。
2. 运行迁移：
   ```bash
   supabase link --project-ref <你的 project ref>
   supabase db push
   ```
3. 部署函数（必须关掉 JWT 校验，否则没登录的手机打不开）：
   ```bash
   node scripts/build.js
   supabase functions deploy breakfast --no-verify-jwt
   ```
4. 打开 `https://<你的 project ref>.supabase.co/functions/v1/breakfast/`，把这个链接发给家人。

可选：函数的环境变量 `BREAKFAST_TZ`（默认 `Asia/Shanghai`）只在手机没传日期时兜底用，正常情况下日期按手机本地时间算。

## 给老人手机装上

1. 微信里收到链接后，点右上角「…」→「在浏览器打开」（微信自带的浏览器不能添加到主屏幕）。
2. iPhone：Safari 底部「分享」→「添加到主屏幕」。安卓：Chrome 右上角「⋮」→「添加到主屏幕」或「安装应用」。
3. 第一次打开点「我是妈妈」。以后从桌面图标打开，直接就是今天的早饭。

## 本地开发

```bash
supabase start
supabase functions serve breakfast --no-verify-jwt
# 打开 http://localhost:54321/functions/v1/breakfast/
```

MIT License.
