# Mac 上的下单助手（给 Claude 桌面版 / Cowork 用的任务说明）

目的：家里人在「吃什么」网页的买菜页点了「选好了，下单吧」之后，这个助手在**登录着 Weee 的浏览器**里把单子里的东西逐样加进购物车，然后停下来，由人确认付款。**永远不要自动付款。**

接口地址（把 `<API>` 换成你自己的，例如 `https://xxxx.supabase.co/functions/v1/breakfast`）：

- 查新单子：`GET <API>/api/orders?status=pending`，返回 `{ "orders": [ { "id", "items": ["五花肉", "青菜"], "by", "at" } ] }`
- 改状态：`POST <API>/api/orders/<id>/status`，JSON 体 `{ "status": "cart", "note": "加了 5 样，青菜没找到" }`
  - `cart` = 已加入购物车；`done` = 已下单（清单里对应的东西会自动打钩）；`cancelled` = 取消

## 建议在 Mac 上这样设置

1. Mac 上装好 Claude 桌面版，Chrome 里装好 Claude in Chrome 扩展，并在 Chrome 里登录 Weee（sayweee.com）。
2. 在 Claude 桌面版里新建一个**定时任务**（比如每天 10:00 和 16:00 各跑一次），任务内容用下面这段：

```
你是家里的下单助手。
1. 用 fetch 或浏览器打开 <API>/api/orders?status=pending，看有没有待处理的单子。没有就直接结束，什么都不用说。
2. 有的话，在 Chrome 里打开 https://www.sayweee.com ，确认已登录（右上角能看到账号）。没登录就停下来告诉我，不要自己登录。
3. 对单子里的每一样东西：在 Weee 搜索框搜这个名字，在结果里选最常规、份量适中的那一款（优先有「Weee!」自营标、评分高的），加 1 份进购物车。同一样东西只加一次。搜不到或拿不准的就跳过，记下来。
4. 全部处理完后，POST <API>/api/orders/<id>/status，status 填 "cart"，note 里写明加了几样、哪些没找到。
5. 最后用一两句话告诉我：加了什么，没找到什么。不要点结账，不要付款，付款由人来做。
```

3. 爸爸收到提示后，打开 Weee 购物车核对、付款。付完在网页的买菜页点「已经下单了」，清单会自动打钩。

## 为什么不是网页直接下单

Weee 没有对外开放下单接口，网页做不到自动加购物车。登录态在家里的电脑上，让电脑上的 Claude 代劳是最稳妥的，付款留给人也最安全。
