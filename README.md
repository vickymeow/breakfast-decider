# 早饭决定器 Breakfast Decider

给全家用的早饭决定器和晚饭报备板。女儿晚上点一张图选好早饭，妈妈早上打开只看到一个大答案；晚饭谁回来吃、想吃什么，一屏告诉妈妈。全中文、大字、大按钮，为老人优化，不用注册不用登录，一个网址两部手机同步。

A tiny shared "what's for breakfast" app for a parent and a child. Chinese UI, big type, no accounts. One URL, both phones see the same menu and the same pick.

## 功能

一个菜库、一个心愿单、每天一个答案。妈妈只做三件事：看、点一下、说一句。

页签：妈妈看到「小饭桌 · 菜篮子 · 菜谱本」，女儿和小陈看到「点个菜 · 早饭碗 · 菜篮子 · 菜谱本」。

- **妈妈的「小饭桌」页**：早饭答案（大图大字、读给我听）；晚饭几个人回来吃、每人想吃什么；「今晚做」点开就是候选：心愿单里的菜排最前（谁想吃、等了几天），其次是拿手菜，点一个或几个就定了，全家都看到。顺手还能定明晚。
- **女儿、小陈的「点个菜」页**：今晚回不回来吃两个大按钮；想吃什么从妈妈的菜库里点，像点外卖，进心愿单，不绑定日期；也可以说一道菜库里没有的。心愿单上能看到妈妈安排到哪天、哪些做过了。
- **「早饭碗」页**（女儿、小陈）：选明早的早饭，可以多选；早上 6 点没选自动随机。
- **「菜谱本」页**（全家）：说一道菜的名字就加进去；食材也可以说，或者让 AI 填；拍照、设为拿手菜、按住 ☰ 拖动排序、删除。做过的菜自动记上次日期和次数。
- **语音**：所有要输入的地方都有 🎤。配置了 Qwen 的 key 时走后端录音识别（微信里也能用）：手机先把录音转成 16k 的 WAV，后端调百炼原生的 `multimodal-generation` 接口（Token Plan 套餐的 `qwen-audio-3.0-asr-flash` 不走 OpenAI 兼容接口，且 `parameters.format` 必填）；否则用浏览器自带识别；再不行提示用键盘话筒。
- **规则**：下午 5 点没说算回来吃；晚上 8 点后页面切到明晚；过了的计划自动结算，心愿变「做过了」。
- **「菜篮子」页**（全家）：上面是要买的东西，大字清单，买到了点一下打钩，能说一句一次加几样，常买的会变成快捷按钮，买到的两天后自动消失；在 Weee 下完单点「已下单，清空菜篮子」一键清空。妈妈的页面下面只平铺「做饭要用的」：她定了今晚做什么之后，那几道菜的食材直接列出来，点一下进清单，不用在菜里绕。女儿和小陈多一个「按菜加」：点任意一道菜展开它的食材，不必先决定做什么。没填食材的菜可以当场说一句或让 AI 填。小陈顺路买了打钩，妈妈就知道了。每样东西旁边有个「🛒 Weee」按钮，点了直接打开 Weee 里这样东西的搜索结果（店铺和链接格式在 `docs/config.js` 的 `STORE` 里改，留空就不显示）。

**后来按家里人的反馈加的**

- **头像和个人面板**：右上角是自己的头像，点开可以换真人照片、换个人用、提意见。
- **红包 🧧**：女儿和小陈可以在心愿单里给点的菜包个红包（只是记一笔心意，钱自己在微信里发）；妈妈定菜时红包多的排前面；菜做完后会提醒“记得发红包”，点“红包发了”妈妈那边就显示已发。金额和符号在 `docs/config.js` 的 `HONGBAO` 里改。
- **晚饭看三天**：今晚、明晚、后天都带周几；每天都能说 回来吃 / 不回来 / 没想好，妈妈每天都能提前定菜，也可以标成“没想好”。
- **推荐买的**：放在清单下面，可以折起来。先列“做菜要用”（三天里定好的晚饭还缺的食材，早饭不算），再列“常买”。常买由家里人自己加、自己删（点「✏️ 改常买」，可以说、可以打字，也可以从“最近买过的”里点），一开始是空的。
- **菜单**：正餐、早饭两栏可以折叠；新加的菜排最上面；有 🧧 红包的菜排最前；按住 ☰ 上下拖就能排顺序；页面上直接写着拿手菜是干什么的（点菜页排前面、妈妈定晚饭时单独一栏）。有 AI 时可以“推荐几道新菜”，连食材一起加进菜单，点菜页也能直接点推荐的菜；推荐的结果可以折起来、一道一道删，或者全部清掉。
- **提意见**：每页底部和个人面板里都有，存在数据库的 `feedback` 里（不会下发到网页）。

## 结构

```
docs/index.html                        前端（纯 HTML/CSS/JS，没有框架），由 GitHub Pages 托管
docs/config.js                         接口地址和买菜网站，换成你自己的
docs/version.txt                       网页版本号；改了网页就顺手改一下它，大家的手机会自动刷新到新版
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

可选：在 Supabase 后台 Edge Functions → Secrets 添加 `DASHSCOPE_API_KEY`（阿里云百炼 / Model Studio 的 key），就同时开启后端语音识别（`qwen3-asr-flash`）和 AI 填食材（`qwen-flash`）。Token Plan 套餐的 key（`sk-sp-` 开头）会自动走套餐地址；普通 key 默认走国际站新加坡地址，国内站把 `DASHSCOPE_BASE_URL` 设成 `https://dashscope.aliyuncs.com/compatible-mode/v1`。套餐不含语音模型时，可以另配一把按量付费的 `QWEN_ASR_API_KEY` 只给语音用。模型可用 `QWEN_ASR_MODEL`、`QWEN_CHAT_MODEL` 改。打开 `<接口地址>/api/qwen-check` 能自检 key 和地址。不配也能用。函数环境变量 `ALLOWED_ORIGIN` 设成你的 Pages 地址（如 `https://xxx.github.io`）可以限制只有这个网页能调接口；`BREAKFAST_TZ`（默认 `Asia/Shanghai`）只在手机没传日期时兜底用。

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
