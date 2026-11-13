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
docs/index.html                        前端（纯 HTML/CSS/JS，没有框架），由 GitHub Pages 托管
docs/config.js                         只有一行：接口地址，换成你自己的
docs/icon.png, docs/manifest.webmanifest  主屏幕图标与安装信息
supabase/functions/breakfast/index.ts  后端：Supabase Edge Function，只提供接口
supabase/migrations/...sql             一张表（一行 JSON）+ 一个公开图片桶
```

为什么前后端分开：Supabase 自带的 `*.supabase.co` 域名不允许云函数返回 HTML 页面（会被改成纯文本），所以网页放 GitHub Pages，接口放 Supabase。两边都免费。

数据存在 `breakfast_state` 表的一行 JSON 里，只有云函数用 service role 读写，表本身对外没有任何策略。照片存在公开桶 `breakfast`，上传只经过云函数（限 5MB、jpg/png/webp）。

## 部署（两边免费版都够用）

**后端（Supabase）**

1. 在 [Supabase](https://supabase.com) 新建一个项目。
2. 运行迁移并部署函数（必须关掉 JWT 校验，否则没登录的手机调不了）：
   ```bash
   supabase link --project-ref <你的 project ref>
   supabase db push
   supabase functions deploy breakfast --no-verify-jwt
   ```
3. 接口地址就是 `https://<你的 project ref>.supabase.co/functions/v1/breakfast`。

**前端（GitHub Pages）**

1. Fork 或复制这个仓库，把 `docs/config.js` 里的地址换成上面的接口地址。
2. 仓库 Settings → Pages → Source 选 `main` 分支的 `/docs` 目录。
3. 一分钟后打开 `https://<你的用户名>.github.io/<仓库名>/`，把这个链接发给家人。

可选：函数环境变量 `ALLOWED_ORIGIN` 设成你的 Pages 地址（如 `https://xxx.github.io`）可以限制只有这个网页能调接口；`BREAKFAST_TZ`（默认 `Asia/Shanghai`）只在手机没传日期时兜底用。

## 给老人手机装上

1. 微信里收到链接后，点右上角「…」→「在浏览器打开」（微信自带的浏览器不能添加到主屏幕）。
2. iPhone：Safari 底部「分享」→「添加到主屏幕」。安卓：Chrome 右上角「⋮」→「添加到主屏幕」或「安装应用」。
3. 第一次打开点「我是妈妈」。以后从桌面图标打开，直接就是今天的早饭。

## 本地开发

```bash
supabase start
supabase functions serve breakfast --no-verify-jwt
# 把 docs/config.js 临时指向 http://localhost:54321/functions/v1/breakfast
# 然后用任意静态服务器打开 docs/，比如 npx serve docs
```

MIT License.
