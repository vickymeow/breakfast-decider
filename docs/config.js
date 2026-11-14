// 接口地址：你自己部署的 Supabase 云函数地址（结尾不要带斜杠）
window.BREAKFAST_API = "https://jnrceiwidetzijmdbczs.supabase.co/functions/v1/breakfast";

// 买菜跳转：清单里每样东西旁边有个按钮，点了打开这家店的搜索结果（{q} 会替换成东西的名字）。
// 不想要就把 search 改成空字符串。换别的店改这里即可。
window.STORE = { name: "Weee", search: "https://www.sayweee.com/en/search?keyword={q}" };
// 红包：点菜时可选的金额；unit 是金额前面的符号（比如 "¥" 或 "$"），留空就只显示数字
window.HONGBAO = { unit: "¥", amounts: [5, 10, 20, 50, 100] };
