# 早饭决定器 Breakfast Decider

给全家用的早饭决定器和晚饭报备板。女儿晚上点一张图选好早饭，妈妈早上打开只看到一个大答案；晚饭谁回来吃、想吃什么，一屏告诉妈妈。全中文、大字、大按钮，为老人优化，不用注册不用登录，一个网址两部手机同步。

A tiny shared "what's for breakfast" app for a parent and a child. Chinese UI, big type, no accounts. One URL, both phones see the same menu and the same pick.

## 功能

- **选早饭**（女儿）：点图片就选好，可以多选几样，再点一下取消；下午 3 点后自动选的是明天。也可以点「随便」（当场定下一道具体的菜）或「今天不吃」。
- **今天早上**（妈妈）：只看一个大答案，大图、超大菜名、一个「读给我听」按钮（系统中文朗读）。
- **没人选怎么办**：当天早上 6 点（`AUTO_PICK_HOUR` 可改）以后还没人选，谁先打开页面就自动随机定一样，两边看到的一样；6 点前打开显示默认的鸡蛋三明治。
- **晚饭**（全家）：女儿和 Jim 各自点「回来吃 / 不回来」，再说一句想吃什么；妈妈一屏看到今晚几个人、每人想吃啥，回一句「今晚做 X」大家都能看到。下午 5 点还没说的算回来吃；晚上 8 点后页面自动切到明天的晚饭。成员名单在 `docs/index.html` 的 `PEOPLE` / `MEMBERS` 和函数里的 `MEMBERS` 改。
- **菜单**：打字或语音加新菜、给每道菜拍一张真照片、删除（点两下确认）、上下排序。语音有三级方案：配置了 `OPENAI_API_KEY` 时按一下录音、说完再按一下，后端识别（微信里也能用）；否则 Chrome / Safari 用浏览器自带语音识别；再不行提示用键盘话筒听写。
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

可选：在 Supabase 后台 Edge Functions → Secrets 添加 `OPENAI_API_KEY`，就开启后端录音识别（模型默认 `gpt-4o-mini-transcribe`，可用 `OPENAI_TRANSCRIBE_MODEL` 改），几分钱一小时，不配也能用。函数环境变量 `ALLOWED_ORIGIN` 设成你的 Pages 地址（如 `https://xxx.github.io`）可以限制只有这个网页能调接口；`BREAKFAST_TZ`（默认 `Asia/Shanghai`）只在手机没传日期时兜底用。

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
