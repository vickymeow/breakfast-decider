// 接口地址：你自己部署的 Supabase 云函数地址（结尾不要带斜杠）
window.BREAKFAST_API = "https://jnrceiwidetzijmdbczs.supabase.co/functions/v1/breakfast";

// 买菜跳转：清单里每样东西旁边有个按钮，点了打开这家店的搜索结果（{q} 会替换成东西的名字）。
// 用中文页面（/zh/ 加 set_lang=zh），妈妈看得懂。不想要就把 search 改成空字符串。换别的店改这里即可。
window.STORE = { name: "Weee", search: "https://www.sayweee.com/zh/search?keyword={q}&set_lang=zh" };
// 红包：点菜时可选的金额；unit 是金额前面的符号（家里在美国就用 "$"，国内用 "¥"），留空就只显示数字。后端通知里的符号用环境变量 HB_UNIT 改（默认 $）
window.HONGBAO = { unit: "$", amounts: [5, 10, 20, 50] };
