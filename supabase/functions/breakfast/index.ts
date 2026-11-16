// 早饭决定器后端：Supabase Edge Function（Deno），只提供接口；网页在 docs/ 由 GitHub Pages 托管。
// 数据全部在 breakfast_state 表的一行 JSON 里（见 Db 类型），照片在 breakfast 存储桶。
// 语音识别与食材建议用阿里云百炼的 Qwen（OpenAI 兼容接口），配置 DASHSCOPE_API_KEY 即开启。
//
//   GET  /api/state?date&hour&ddate&tz  全部状态；顺带做：6 点自动随机早饭、过期晚饭计划结算；tz = 手机的时区，记下来给定时提醒用
//   POST /api/pick        {type, ids, date, who}     早饭选择（多选）
//   POST /api/dishes      {name, cat, ingredients, mom, by}   加菜（菜库）
//   POST /api/dishes/:id/update {name?, cat?, mom?, ingredients?}
//   POST /api/dishes/:id/move   {direction}          上下挪一格（旧网页用）
//   POST /api/dishes/reorder    {cat, ids}           菜单排序（拖动后整栏的新顺序）
//   POST /api/dishes/:id/photo  （请求体是图片）
//   DELETE /api/dishes/:id
//   POST /api/wishes      {dishId | name, who, hb?, hbMsg?}   点菜进心愿单（hb = 红包金额，只是记一笔，钱自己在微信发；hbMsg = 给妈妈的一句话）
//   POST /api/wishes/:id/remove
//   POST /api/wishes/:id/update {hb?, hbMsg?, hbPaid?}
//   POST /api/push/subscribe   {who, key, sub}       这台手机打开通知（Web Push 订阅）
//   POST /api/push/unsubscribe {who, endpoint}
//   POST /api/push/test        {who}                 发一条试试
//   有人说不回来吃、点菜、选好早饭、包红包、红包发了 → 给妈妈的手机发通知（同一个人 30 秒内的动作合成一条）
//   妈妈定了做什么、做好了 → 给女儿、小陈的手机发通知。每条通知同时记在 inbox 里，网页上「最近的动态」能看到内容
//   POST /api/dinner/done  {date}                     妈妈点「做好了」：这天的晚饭当场结算（菜记一次、心愿变做过了、红包进账本）
//   POST /api/hb/paid      {who, ids:[]}              红包发了（账本 ledger 里的条目标成已发）
//   POST /api/dinner/add   {who, date, dishId}        菜谱本里点「我想做」：把这道菜加进那天晚饭（不替换已定的菜）；女儿小陈加的同时进心愿单，告诉妈妈
//   GET/POST /api/cron                                定时提醒（pg_cron 每 15 分钟调一次；按家里的时区，每条每天只发一次）:
//        晚上 8 点没选明早早饭 → 提醒女儿、小陈；早上 9 点、下午 3 点没说今晚回不回来 → 提醒本人；下午 4 点妈妈还没定今晚做什么 → 提醒妈妈
//   POST /api/profile/:who/photo （请求体是图片）     头像
//   POST /api/feedback    {who, text}                 提意见（存在 feedback 里，不随 state 下发）
//   POST /api/suggest     {cat}                       Qwen 推荐几道菜单里没有的新菜
//   POST /api/dinner/reply {who, home, date}          回不回来吃
//   POST /api/dinner/cook  {date, dishIds, text}      妈妈定今晚/明晚做什么（空 = 取消）
//   POST /api/shopping    {op:"add", names:[], from?} | {op:"toggle"|"remove", id} | {op:"clear_done"} | {op:"ordered"}   买菜清单（全家共用）
//   POST /api/staples     {op:"add", names:[]} | {op:"remove", name}   常买（家里人自己加、自己删）
//   POST /api/transcribe  （请求体是录音）           Qwen 语音转文字
//   POST /api/ingredients {name}                      Qwen 给出食材清单
//   POST /api/intent      {text, prev?, dates:[]}     妈妈说的一句话 → 拆成要做的事（排菜、买东西、做不了、问问题……），网页确认后再执行
//   POST /api/ideas       {query?, cat, n?, exclude?}  AI 想几道新菜（带要买的和做法）；query 是一类菜，比如「鱼」
//   POST /api/wishes/:id/decline {reason?}            妈妈说这道菜这次做不了：心愿拿掉，告诉点菜的人
//   定了做什么菜（dinner/cook、dinner/add）：新排上的菜的食材自动进菜篮子（没食材先让 AI 填）；菜换掉了，它自动加的、还没买的拿掉
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { newVapid, sendPush, type PushSub, type Vapid } from "./push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BUILD = "2026-11-16 妈妈端改版";   // 部署后打开接口地址能看到，确认是不是新版本
const TABLE = "breakfast_state";
const BUCKET = "breakfast";
const ROW_ID = 1;
const FUNCTION_NAME = "breakfast";
const TZ = Deno.env.get("BREAKFAST_TZ") || "Asia/Shanghai";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const AUTO_PICK_HOUR = Number(Deno.env.get("AUTO_PICK_HOUR") || "6");
// ---- Qwen（阿里云百炼）----
// 新加坡/国际站默认地址；国内站改成 https://dashscope.aliyuncs.com/compatible-mode/v1
const DASHSCOPE_API_KEY = (Deno.env.get("DASHSCOPE_API_KEY") || "").trim();
// Token Plan 套餐的 key 以 sk-sp- 开头，必须走套餐专属地址；普通 key 走通用地址
const IS_TOKEN_PLAN = DASHSCOPE_API_KEY.startsWith("sk-sp-");
const DEFAULT_BASE = IS_TOKEN_PLAN ? "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DASHSCOPE_BASE_URL = (Deno.env.get("DASHSCOPE_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");
// 语音模型：Token Plan 套餐里叫 qwen-audio-3.0-asr-flash，按量付费叫 qwen3-asr-flash；哪个能用记住哪个
const QWEN_ASR_MODEL = Deno.env.get("QWEN_ASR_MODEL") || (IS_TOKEN_PLAN ? "qwen-audio-3.0-asr-flash" : "qwen3-asr-flash");
const ASR_CANDIDATES = [QWEN_ASR_MODEL, "qwen-audio-3.0-asr-flash", "qwen3-asr-flash"].filter((x, i, a) => a.indexOf(x) === i);
let workingAsrModel: string | null = null;
// 套餐里没有 qwen-flash，默认直接用套餐里的 qwen3.8-flash，省一次白跑
const QWEN_CHAT_MODEL = Deno.env.get("QWEN_CHAT_MODEL") || (IS_TOKEN_PLAN ? "qwen3.8-flash" : "qwen-flash");
// 对话模型候选：配置的优先，其余按便宜到贵排；套餐里没有的（404 model_not_found）自动跳过，记住能用的
const CHAT_CANDIDATES = [QWEN_CHAT_MODEL, "qwen3.8-flash", "qwen3.6-flash", "qwen3.7-plus", "qwen3.6-plus", "qwen-flash", "qwen-turbo", "qwen-plus", "qwen3.8-max", "qwen3.7-max", "qwen3-max", "qwen-max"].filter((x, i, a) => a.indexOf(x) === i);
let workingChatModel: string | null = null;
// 语音识别可以单独用另一把 key / 地址（套餐若不含 ASR 模型时用按量付费的普通 key）
const ASR_API_KEY = (Deno.env.get("QWEN_ASR_API_KEY") || DASHSCOPE_API_KEY).trim();
// 没听到人声时抛这个，接口回 422，网页提示「没听清」
class NoSpeech extends Error {}
const ASR_BASE_URL = (Deno.env.get("QWEN_ASR_BASE_URL") || (ASR_API_KEY.startsWith("sk-sp-") ? "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" : (Deno.env.get("QWEN_ASR_API_KEY") ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" : DASHSCOPE_BASE_URL))).replace(/\/+$/, "");

type Cat = "breakfast" | "dinner";
type Dish = {
  id: number; name: string; emoji?: string; image?: string;
  cat: Cat; mom: boolean; ingredients: string[]; lastMade: string | null; times: number; by?: string;
  steps?: string[];   // 做法，一步一句（AI 想的新菜带着）
};
type Pick = { type: "dish" | "random" | "skip"; dish: number | null; dishes?: number[]; resolvedName: string | null; auto?: boolean };
type Reply = { home: boolean | null; at: string };
// pending：妈妈只说了一类菜（比如「鱼」）还没定怎么做
type Plan = { date: string; replies: Record<string, Reply>; cook: { dishIds: number[]; text: string; at: string; pending?: string } | null; done?: boolean };
type Wish = { id: number; dishId: number; who: string; at: string; status: "open" | "planned" | "done"; plannedFor?: string; doneAt?: string; hb?: number; hbMsg?: string; hbPaid?: boolean };
type Feedback = { id: number; who: string; text: string; at: string; done?: boolean };
// 红包账本：菜做好了（结算时）心愿上的红包记进来，谁、哪道菜、多少、哪天做的、发了没
type Ledger = { id: number; wishId: number; who: string; dishId: number; name: string; hb: number; msg?: string; date: string; paidAt?: string };
// 发过的通知（给谁、谁引起的、内容），网页上「最近的动态」看
type Inbox = { id: number; to: string; from: string; body: string; at: string };
// auto：定了菜自动加的（dishId 是哪道菜），菜换掉了会自动拿掉；note：数量之类的备注
type ShopItem = { id: number; name: string; done: boolean; from?: string; at: string; doneAt?: string; auto?: boolean; dishId?: number; note?: string };
type Db = { v: number; dishes: Dish[]; pick: Pick | null; pickDate: string | null; plans: Record<string, Plan>; wishes: Wish[]; shopping: ShopItem[]; shopHistory: Record<string, number>; profiles: Record<string, { avatar?: string }>; feedback: Feedback[]; orderV?: number; staples?: string[];
  push?: Record<string, (PushSub & { at: string })[]>; vapid?: Vapid; notify?: Record<string, { evs: Ev[]; token: number; at: string }>;
  tz?: string; ledger?: Ledger[]; ledgerV?: number; inbox?: Inbox[]; reminded?: Record<string, string> };
// 要告诉家里人的动态：先记下来，30 秒内没有新动作再按当时的情况合成一条发出去（点错马上取消的就不发了）
// 女儿、小陈的动作发给妈妈；妈妈的动作（定了做什么、做好了）发给女儿、小陈
type Ev = { k: "wish" | "hb" | "paid" | "lpaid" | "away" | "pick" | "cook" | "made" | "plan"; id?: number; date?: string };
// 一类菜：只说这些词，说明还没想好怎么做
const CATEGORY_WORDS = ["鱼", "虾", "肉", "猪肉", "牛肉", "羊肉", "鸡", "鸡肉", "鸭", "排骨", "牛排骨", "猪排骨", "青菜", "蔬菜", "菜", "汤", "豆腐", "蛋", "鸡蛋", "海鲜", "面", "面条", "饭"];
const MEMBERS = ["kid", "jim"];
const PEOPLE = ["mom", "kid", "jim"];
const NAMES: Record<string, string> = { mom: "妈妈", kid: "女儿", jim: "小陈" };
const NOTIFY_TO = "mom";
const NOTIFY_DELAY_MS = 30000;
const HB_UNIT = Deno.env.get("HB_UNIT") ?? "$";
const UNSURE = "还没想好";
const NO_COOK = "不做饭，各自解决";
const INBOX_MAX = 40;
// 推送服务要求带一个联系方式；用不对外的占位地址，可以用 VAPID_SUBJECT 改
const PUSH_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:noreply@example.com";
const cleanMsg = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
const cleanHb = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 0; };

const SEED_NAMES: [string, string][] = [["乌冬面","🍜"],["炒荞麦面","🍝"],["馄饨","🥟"],["蒸饺","🥟"],["煎饺","🥟"],["炒饭","🍚"],["吐司","🍞"],["鸡蛋","🥚"]];
const EMOJI_RULES: [string, string][] = [
  ["三明治","🥪"],["汉堡","🍔"],["吐司","🍞"],["面包","🍞"],["馒头","🍞"],["花卷","🍞"],["馄饨","🥟"],["云吞","🥟"],["饺","🥟"],["包子","🥟"],["小笼","🥟"],["烧卖","🥟"],
  ["炒饭","🍚"],["米饭","🍚"],["饭团","🍙"],["粥","🥣"],["麦片","🥣"],["燕麦","🥣"],["意面","🍝"],["荞麦","🍝"],["面","🍜"],["粉","🍜"],["蛋","🥚"],["煎饼","🥞"],["饼","🥞"],
  ["华夫","🧇"],["牛奶","🥛"],["豆浆","🥛"],["酸奶","🥛"],["油条","🥖"],["香蕉","🍌"],["苹果","🍎"],["水果","🍎"],["汤","🍲"],["火腿","🥓"],["培根","🥓"],["香肠","🌭"],["红薯","🍠"],["玉米","🌽"],
  ["鱼","🐟"],["虾","🦐"],["蟹","🦀"],["鸡","🍗"],["鸭","🍗"],["排骨","🍖"],["牛","🥩"],["羊","🍖"],["肉","🍖"],["豆腐","🧈"],["茄子","🍆"],["土豆","🥔"],["番茄","🍅"],["西红柿","🍅"],["青菜","🥬"],["菜","🥬"],["菇","🍄"],["火锅","🍲"],["咖喱","🍛"],["披萨","🍕"],["寿司","🍣"],
];
const emojiFor = (name: string) => (EMOJI_RULES.find(([k]) => name.includes(k)) || [, "🍽️"])[1]!;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nowIso = () => new Date().toISOString();
const addDays = (date: string, n: number) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- 数据读写与迁移 ----
function fresh(): Db {
  return { v: 2, dishes: SEED_NAMES.map(([name, emoji], i) => ({ id: i + 1, name, emoji, cat: "breakfast", mom: true, ingredients: [], lastMade: null, times: 0 })), pick: null, pickDate: null, plans: {}, wishes: [], shopping: [], shopHistory: {}, profiles: {}, feedback: [], orderV: 1, staples: [] };
}
// 旧结构（v1：dishes 只有早饭；dinner 一份含 wish 文本）升到 v2
// deno-lint-ignore no-explicit-any
function migrate(raw: any): { db: Db; changed: boolean } {
  if (raw && raw.v === 2) {
    const db = raw as Db; let changed = false;
    if (!Array.isArray(db.shopping)) { db.shopping = []; changed = true; }
    if (!db.shopHistory || typeof db.shopHistory !== "object") { db.shopHistory = {}; changed = true; }
    if (!db.profiles || typeof db.profiles !== "object") { db.profiles = {}; changed = true; }
    if (!Array.isArray(db.feedback)) { db.feedback = []; changed = true; }
    // 常买由家里人自己加，一开始是空的（不再用写死的牛奶鸡蛋补齐）
    if (!Array.isArray(db.staples)) { db.staples = []; changed = true; }
    if (!Array.isArray(db.ledger)) { db.ledger = []; changed = true; }
    if (!Array.isArray(db.inbox)) { db.inbox = []; changed = true; }
    if (!db.ledgerV) {
      // 一次性：以前做过的、带红包的心愿补进账本
      for (const w of db.wishes) if (w.status === "done" && w.hb && !db.ledger.some((e) => e.wishId === w.id)) {
        const d = db.dishes.find((x) => x.id === w.dishId);
        db.ledger.push({ id: w.id, wishId: w.id, who: w.who, dishId: w.dishId, name: d?.name || "菜", hb: w.hb, msg: w.hbMsg, date: w.doneAt || nowIso().slice(0, 10), paidAt: w.hbPaid ? nowIso() : undefined });
      }
      db.ledgerV = 1; changed = true;
    }
    if (!db.orderV) {
      // 一次性：正餐按「新加的在上面」重排（早饭的手动顺序不动）；之后新菜都插在最前
      const dinner = db.dishes.filter((d) => d.cat === "dinner").sort((a, b) => b.id - a.id);
      let k = 0; db.dishes = db.dishes.map((d) => d.cat === "dinner" ? dinner[k++] : d);
      db.orderV = 1; changed = true;
    }
    return { db, changed };
  }
  const db: Db = fresh();
  if (raw && Array.isArray(raw.dishes) && raw.dishes.length) {
    // deno-lint-ignore no-explicit-any
    db.dishes = raw.dishes.map((d: any) => ({ id: Number(d.id), name: String(d.name), emoji: d.emoji, image: d.image, cat: "breakfast", mom: true, ingredients: [], lastMade: null, times: 0 }));
  }
  db.pick = raw?.pick ?? null; db.pickDate = raw?.pickDate ?? null;
  const od = raw?.dinner;
  if (od && od.date) {
    const plan: Plan = { date: od.date, replies: {}, cook: null };
    for (const who of Object.keys(od.replies || {})) {
      const r = od.replies[who]; plan.replies[who] = { home: r.home ?? null, at: r.at || nowIso() };
      if (r.wish && r.wish !== "随便") { const dish = ensureDish(db, r.wish, "dinner", who); db.wishes.push({ id: Date.now() + db.wishes.length, dishId: dish.id, who, at: r.at || nowIso(), status: "open" }); }
    }
    if (od.cook && od.cook.text) plan.cook = { dishIds: [], text: od.cook.text, at: od.cook.at || nowIso() };
    db.plans[od.date] = plan;
  }
  return { db, changed: true };
}
async function loadDb(): Promise<{ db: Db; changed: boolean }> {
  const { data, error } = await supabase.from(TABLE).select("data").eq("id", ROW_ID).maybeSingle();
  if (error) throw error;
  if (!data) return { db: fresh(), changed: true };
  return migrate(data.data);
}
async function saveDb(db: Db) {
  const { error } = await supabase.from(TABLE).upsert({ id: ROW_ID, data: db, updated_at: nowIso() });
  if (error) throw error;
}
function ensureDish(db: Db, name: string, cat: Cat, by?: string): Dish {
  const n = name.trim();
  const found = db.dishes.find((d) => d.name === n);
  if (found) return found;
  const dish: Dish = { id: Date.now() + Math.floor(Math.random() * 1000), name: n, emoji: emojiFor(n), cat, mom: false, ingredients: [], lastMade: null, times: 0, by };
  db.dishes.unshift(dish); // 新加的排在最上面
  return dish;
}
function planFor(db: Db, date: string): Plan {
  if (!db.plans[date]) db.plans[date] = { date, replies: {}, cook: null };
  return db.plans[date];
}
// 心愿状态跟着计划走：被排进未结算计划的 = planned，否则 open
function syncWishes(db: Db) {
  const planned = new Map<number, string>();
  for (const p of Object.values(db.plans)) if (!p.done && p.cook) for (const id of p.cook.dishIds) if (!planned.has(id) || p.date < planned.get(id)!) planned.set(id, p.date);
  for (const w of db.wishes) {
    if (w.status === "done") continue;
    if (planned.has(w.dishId)) { w.status = "planned"; w.plannedFor = planned.get(w.dishId); }
    else { w.status = "open"; delete w.plannedFor; }
  }
}
// 定了菜 → 这道菜的食材自动进菜篮子（标着哪天哪道菜；家里有的妈妈说一句或点「不用买」拿掉）
// 没填食材的菜先让 AI 填（最多等 8 秒，填不上就算了）
async function fillIngredients(db: Db, ids: number[]) {
  if (!DASHSCOPE_API_KEY) return;
  const need = ids.map((id) => db.dishes.find((d) => d.id === id)).filter((d): d is Dish => !!d && !(d.ingredients || []).length).slice(0, 4);
  if (!need.length) return;
  await Promise.all(need.map(async (d) => {
    const items = await Promise.race([qwenIngredients(d.name).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    if (items && items.length) d.ingredients = cleanList(items);
  }));
}
function autoShop(db: Db, date: string, ids: number[]): string[] {
  const added: string[] = [];
  for (const id of ids) {
    const d = db.dishes.find((x) => x.id === id); if (!d || d.cat !== "dinner") continue;
    for (const n of d.ingredients || []) {
      if (db.shopping.some((it) => it.name === n && !it.done)) continue;
      if (db.shopping.length >= 150) return added;
      db.shopping.push({ id: Date.now() + Math.floor(Math.random() * 1e6), name: n, done: false, from: `${weekdayOf(date)} · ${d.name}`, at: nowIso(), auto: true, dishId: d.id });
      added.push(n);
    }
  }
  return added;
}
// 菜换掉了：它自动加的、还没买的拿掉（别的还排着的菜也要用的留着）
function pruneAuto(db: Db) {
  const ids = new Set<number>(); const need = new Set<string>();
  for (const p of Object.values(db.plans)) if (!p.done && p.cook) for (const id of p.cook.dishIds) {
    ids.add(id); for (const n of db.dishes.find((d) => d.id === id)?.ingredients || []) need.add(n);
  }
  db.shopping = db.shopping.filter((it) => it.done || !it.auto || (it.dishId != null && ids.has(it.dishId)) || need.has(it.name));
}
// 一天的晚饭结算：菜记一次“做过”，心愿变“做过了”，心愿上的红包记进账本
function finishPlan(db: Db, p: Plan): { made: Dish[]; hb: Ledger[] } {
  const made: Dish[] = [], hb: Ledger[] = [];
  const ledger = db.ledger || (db.ledger = []);
  if (p.cook) for (const id of p.cook.dishIds) {
    const d = db.dishes.find((x) => x.id === id); if (d) { d.times = (d.times || 0) + 1; d.lastMade = p.date; made.push(d); }
    for (const w of db.wishes) if (w.status !== "done" && w.dishId === id) {
      w.status = "done"; w.doneAt = p.date;
      if (w.hb && !ledger.some((e) => e.wishId === w.id)) {
        const e: Ledger = { id: Date.now() + ledger.length + Math.floor(Math.random() * 1000), wishId: w.id, who: w.who, dishId: id, name: d?.name || "菜", hb: w.hb, msg: w.hbMsg, date: p.date, paidAt: w.hbPaid ? nowIso() : undefined };
        ledger.push(e); hb.push(e);
      }
    }
  }
  if (ledger.length > 200) db.ledger = ledger.slice(-200);
  p.done = true;
  return { made, hb };
}
// 过了的计划自动结算；清掉太老的计划和心愿
function settle(db: Db, today: string): boolean {
  let changed = false;
  for (const p of Object.values(db.plans)) {
    if (p.done || p.date >= today) continue;
    finishPlan(db, p); changed = true;
  }
  for (const k of Object.keys(db.plans)) if (k < addDays(today, -3)) { delete db.plans[k]; changed = true; }
  const before = db.wishes.length;
  db.wishes = db.wishes.filter((w) => !(w.status === "done" && w.doneAt && w.doneAt < addDays(today, -14)));
  if (db.wishes.length !== before) changed = true;
  // 买到的东西两天后自动从清单消失
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString();
  const sb = db.shopping.length;
  db.shopping = db.shopping.filter((it) => !(it.done && it.doneAt && it.doneAt < cutoff));
  if (db.shopping.length !== sb) changed = true;
  return changed;
}
function autoPickIfDue(db: Db, date: string, hour: number): boolean {
  if (!(hour >= AUTO_PICK_HOUR && hour < 15)) return false;
  if (db.pick && db.pickDate === date) return false;
  const pool = db.dishes.filter((d) => d.cat === "breakfast");
  if (!pool.length) return false;
  const dish = pool[Math.floor(Math.random() * pool.length)];
  db.pick = { type: "random", dish: dish.id, dishes: [dish.id], resolvedName: dish.name, auto: true };
  db.pickDate = date;
  return true;
}
// 家里的时区：手机打开网页时报上来的（db.tz），没有就用环境变量
function validTz(tz: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return /^[A-Za-z_]+\/[A-Za-z_\/+-]+$|^UTC$/.test(tz); } catch { return false; } }
function localNow(db?: Db): { date: string; hour: number; minutes: number } {
  const tz = (db?.tz && validTz(db.tz)) ? db.tz : TZ;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day"))).toISOString().slice(0, 10);
  const hour = get("hour") % 24;
  return { date, hour, minutes: hour * 60 + get("minute") };
}
function targetDate(db?: Db): string {
  const n = localNow(db);
  return n.hour >= 15 ? addDays(n.date, 1) : n.date;
}

// ---- 给妈妈的手机发通知 ----
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
function inBackground(p: Promise<unknown>) {
  const q = p.catch((e) => console.error("notify failed", e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(q);
}
const weekdayOf = (date: string) => "周" + "日一二三四五六"[new Date(date + "T00:00:00Z").getUTCDay()];
const hbLine = (w: Wish) => `🧧${HB_UNIT}${w.hb}${w.hbMsg ? " " + w.hbMsg : ""}`;
const dishNames = (db: Db, ids: number[]) => ids.map((id) => db.dishes.find((d) => d.id === id)?.name || "").filter(Boolean).join("、");
// 这条动态发给谁：女儿、小陈的 → 妈妈；妈妈的 → 女儿、小陈
const recipientsOf = (who: string) => who === "mom" ? MEMBERS : [NOTIFY_TO];
// 记一条到收件箱（网页上「最近的动态」看得到，没打开通知也有）
function inboxAdd(db: Db, to: string, from: string, body: string) {
  const box = db.inbox || (db.inbox = []);
  box.push({ id: Date.now() + Math.floor(Math.random() * 1000), to, from, body, at: nowIso() });
  if (box.length > INBOX_MAX) db.inbox = box.slice(-INBOX_MAX);
}
// 记一条动态。返回给 scheduleNotify 用的凭据
function queueNotify(db: Db, who: string, ev: Ev): { who: string; token: number } | null {
  if (!PEOPLE.includes(who)) return null;
  const notify = db.notify || (db.notify = {});
  const q = notify[who] || (notify[who] = { evs: [], token: 0, at: nowIso() });
  if (!q.evs.some((e) => e.k === ev.k && e.id === ev.id && e.date === ev.date)) q.evs.push(ev);
  q.token = Date.now() + Math.random(); q.at = nowIso();
  return { who, token: q.token };
}
function scheduleNotify(t: { who: string; token: number } | null) {
  if (!t) return;
  inBackground(new Promise((r) => setTimeout(r, NOTIFY_DELAY_MS)).then(() => flushNotify(t.who, t.token)));
}
// 按现在的情况把记下的动态写成一句话（已经取消的就不说了）
function describe(db: Db, who: string, evs: Ev[]): string[] {
  const lines: string[] = [];
  const wishOf = (id?: number) => { const w = db.wishes.find((x) => x.id === id); const d = w && db.dishes.find((x) => x.id === w.dishId); return w && d ? { w, d } : null; };
  const ordered = new Set(evs.filter((e) => e.k === "wish").map((e) => e.id));
  for (const e of evs) {
    if (e.k === "wish") { const x = wishOf(e.id); if (x && x.w.status !== "done") lines.push(`点了 ${x.d.name}` + (x.w.hb ? `（${hbLine(x.w)}）` : "")); }
    else if (e.k === "hb") { if (ordered.has(e.id)) continue; const x = wishOf(e.id); if (x && x.w.hb && !x.w.hbPaid) lines.push(`给 ${x.d.name} 包了 ${hbLine(x.w)}`); }
    else if (e.k === "paid") { const x = wishOf(e.id); if (x && x.w.hb && x.w.hbPaid) lines.push(`红包发了 🧧${HB_UNIT}${x.w.hb}（${x.d.name}）`); }
    else if (e.k === "lpaid") { const l = (db.ledger || []).find((x) => x.id === e.id); if (l && l.paidAt) lines.push(`红包发了 🧧${HB_UNIT}${l.hb}（${l.name}）`); }
    else if (e.k === "away" && e.date) { const r = db.plans[e.date]?.replies?.[who]; if (r && r.home === false) lines.push(`${weekdayOf(e.date)}晚上不回来吃`); }
    else if (e.k === "pick" && e.date) { if (db.pick && db.pickDate === e.date) lines.push(db.pick.type === "skip" ? `${weekdayOf(e.date)}早饭不吃` : `${weekdayOf(e.date)}早饭选好了：${db.pick.resolvedName}`); }
    else if (e.k === "plan" && e.date) {
      const p = db.plans[e.date]; const d = db.dishes.find((x) => x.id === e.id);
      if (p?.cook && !p.done && d && p.cook.dishIds.includes(d.id)) lines.push(`把 ${d.name} 排到${weekdayOf(e.date)}晚上了`);
    }
    // 妈妈的动作
    else if (e.k === "cook" && e.date) {
      const p = db.plans[e.date]; if (!p?.cook || p.done) continue;
      const names = [dishNames(db, p.cook.dishIds), p.cook.pending ? `${p.cook.pending}（还没定怎么做）` : ""].filter(Boolean).join("、");
      if (names) lines.push(`${weekdayOf(e.date)}晚上做 ${names}${p.cook.text && p.cook.text !== UNSURE && p.cook.text !== NO_COOK ? "、" + p.cook.text : ""}`);
      else if (p.cook.text && p.cook.text !== UNSURE) lines.push(`${weekdayOf(e.date)}晚上${p.cook.text}`);
    }
    else if (e.k === "made" && e.date) {
      const p = db.plans[e.date]; if (!p?.cook || !p.done) continue;
      const names = dishNames(db, p.cook.dishIds);
      const owe = (db.ledger || []).filter((l) => l.date === e.date && !l.paidAt);
      lines.push(`${names || "晚饭"} 做好了，回家吃饭啦 🍚` + (owe.length ? `。点了菜的记得给妈妈发红包 🧧` : ""));
    }
  }
  return lines;
}
// token 为 null：不管有没有新动作，直接发（兜底：后台计时没跑完的）
async function flushNotify(who: string, token: number | null) {
  const { db } = await loadDb();
  const q = db.notify?.[who];
  if (!q || (token !== null && q.token !== token)) return;
  delete db.notify![who];
  const lines = describe(db, who, q.evs);
  const tos = recipientsOf(who);
  const body = `${NAMES[who]}：${lines.join("；")}`;
  if (lines.length) for (const to of tos) inboxAdd(db, to, who, body);
  await saveDb(db);
  if (lines.length) for (const to of tos) await pushTo(db, to, { title: who === "mom" ? "吃什么 · 妈妈说" : "吃什么 · 家里有新动态", body, tag: "breakfast-" + who });
}
// ---- 定时提醒（/api/cron 每 15 分钟被调一次）----
// 每条规则有个时间窗口，窗口里第一次跑到就发，同一天不重发；按家里的时区算
type Rule = { key: string; from: number; to: number; targets: (db: Db, date: string) => { to: string; title: string; body: string }[] };
const H = (h: number, m = 0) => h * 60 + m;
const RULES: Rule[] = [
  { key: "bf", from: H(20), to: H(22), targets: (db, date) => {
    const tmr = addDays(date, 1);
    if (db.pick && db.pickDate === tmr) return [];
    return MEMBERS.map((to) => ({ to, title: "吃什么 · 明早吃什么？", body: `还没选明早的早饭。不选的话早上 ${AUTO_PICK_HOUR} 点就随机一个，打开选一下 🥐` }));
  } },
  { key: "dn1", from: H(9), to: H(11), targets: (db, date) => MEMBERS.filter((m) => noReply(db, date, m)).map((to) => ({ to, title: "吃什么 · 今晚回来吃吗？", body: "告诉妈妈一下今晚回不回来吃，想吃什么顺便点一个 🍲" })) },
  { key: "dn2", from: H(15), to: H(16, 30), targets: (db, date) => MEMBERS.filter((m) => noReply(db, date, m)).map((to) => ({ to, title: "吃什么 · 今晚回来吃吗？", body: "还没说今晚回不回来。下午 5 点还没说，妈妈就按回来吃算了" })) },
  { key: "mom", from: H(16), to: H(17, 30), targets: (db, date) => {
    const p = db.plans[date];
    if (p?.cook || p?.done) return [];
    if (!MEMBERS.some((m) => p?.replies?.[m]?.home !== false)) return [];   // 都说了不回来
    const wish = db.wishes.filter((w) => w.status !== "done").sort((a, b) => (b.hb || 0) - (a.hb || 0)).map((w) => db.dishes.find((d) => d.id === w.dishId)?.name || "").filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 3);
    const home = MEMBERS.filter((m) => p?.replies?.[m]?.home !== false).map((m) => NAMES[m]).join("、");
    return [{ to: "mom", title: "吃什么 · 今晚做什么？", body: `${home}回来吃，今晚做什么还没定。` + (wish.length ? `他们想吃：${wish.join("、")}` : "打开点一下就定了") }];
  } },
];
function noReply(db: Db, date: string, who: string): boolean { const r = db.plans[date]?.replies?.[who]; return !r || r.home === null; }
async function runReminders(): Promise<{ date: string; minutes: number; sent: string[]; skipped?: string }> {
  const { db } = await loadDb();
  // 还不知道家里在哪个时区（新网页还没被打开过）就先不发，免得半夜提醒
  if (!db.tz || !validTz(db.tz)) return { date: "", minutes: -1, sent: [], skipped: "no tz yet" };
  const { date, minutes } = localNow(db);
  const rem = db.reminded || (db.reminded = {});
  let pruned = false;
  for (const k of Object.keys(rem)) if (rem[k] < addDays(date, -2)) { delete rem[k]; pruned = true; }
  const out: { to: string; title: string; body: string }[] = [], sent: string[] = [];
  for (const r of RULES) {
    if (minutes < r.from || minutes > r.to) continue;
    for (const t of r.targets(db, date)) {
      const k = `${r.key}:${t.to}`;
      if (rem[k] === date) continue;
      rem[k] = date; out.push(t); sent.push(k);
      inboxAdd(db, t.to, "sys", t.body);
    }
  }
  // 只有真发了（或清了旧记录）才写库：每 15 分钟空跑一次时不碰数据，免得盖掉家里人刚点的
  if (out.length || pruned) await saveDb(db);
  for (const t of out) await pushTo(db, t.to, { title: t.title, body: t.body, tag: "breakfast-remind" });
  return { date, minutes, sent };
}
async function pushTo(db: Db, to: string, data: Record<string, unknown>): Promise<number[]> {
  const subs = db.push?.[to] || [];
  if (!subs.length || !db.vapid) return [];
  const results = await Promise.all(subs.map((s) => sendPush(s, { url: "./", ...data }, db.vapid!, PUSH_SUBJECT).then((r) => r.status, (e) => { console.error("push failed", e); return 0; })));
  console.log("push", to, results);
  // 404 / 410：这台手机的订阅没用了，删掉
  const dead = subs.filter((_, i) => results[i] === 404 || results[i] === 410).map((s) => s.endpoint);
  if (dead.length) { const { db: fresh } = await loadDb(); if (fresh.push?.[to]) { fresh.push[to] = fresh.push[to].filter((s) => !dead.includes(s.endpoint)); await saveDb(fresh); } }
  return results;
}

// ---- Qwen ----
function toB64(bytes: Uint8Array): string {
  let bin = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
// 几种请求写法：文档打不开，哪种被接受就记住哪种（按模型 + 写法）
let workingAsrVariant = -1;
function asrBodies(model: string, b64: string, contentType: string, fmt: string): { name: string; body: unknown }[] {
  const dataUrl = `data:${contentType};base64,${b64}`;
  const alt = fmt === "mp4" ? "m4a" : fmt === "webm" ? "opus" : fmt;
  const u = (part: unknown) => [{ role: "user", content: [part] }];
  return [
    { name: "plain", body: { model, stream: false, messages: u({ type: "input_audio", input_audio: { data: dataUrl, format: fmt } }) } },
    { name: "sys+opts", body: { model, stream: false, messages: [{ role: "system", content: [{ type: "text", text: "家里做饭的对话，内容是菜名和食材。" }] }, ...u({ type: "input_audio", input_audio: { data: dataUrl, format: fmt } })], asr_options: { enable_itn: false, language: "zh" } } },
    { name: "alt-format", body: { model, stream: false, messages: u({ type: "input_audio", input_audio: { data: dataUrl, format: alt } }) } },
    { name: "no-format", body: { model, stream: false, messages: u({ type: "input_audio", input_audio: { data: dataUrl } }) } },
    { name: "raw-b64", body: { model, stream: false, messages: u({ type: "input_audio", input_audio: { data: b64, format: fmt } }) } },
    { name: "audio_url", body: { model, stream: false, messages: u({ type: "audio_url", audio_url: { url: dataUrl } }) } },
    { name: "plain+text", body: { model, stream: false, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: dataUrl, format: fmt } }, { type: "text", text: "请把这段话转成文字。" }] }] } },
  ];
}
// 语音识别。实测（2026-11）：qwen-audio-3.0-asr-flash 不走 OpenAI 兼容的对话接口，要走百炼原生的
//   POST {host}/api/v1/services/aigc/multimodal-generation/generation
//   {model, input:{messages:[{role:"user",content:[{audio:"data:audio/wav;base64,..."}]}]}, parameters:{format, sample_rate}}
// parameters.format 必填（少了就回空的 400）；返回 {text, sentence}；录音里没有人声也是回 400。
async function asrNative(model: string, b64: string, contentType: string, fmt: string): Promise<{ ok: boolean; status: number; text: string; raw: string }> {
  const url = new URL(ASR_BASE_URL).origin + "/api/v1/services/aigc/multimodal-generation/generation";
  const body = { model, input: { messages: [{ role: "user", content: [{ audio: `data:${contentType};base64,${b64}` }] }] }, parameters: { format: fmt, sample_rate: 16000, language_hints: ["zh"] } };
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${ASR_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await r.text();
  let text = "";
  try { const j = JSON.parse(raw); text = String(j.text || j.sentence?.text || j.output?.text || j.output?.sentence?.text || "").trim(); } catch { /* 不是 JSON */ }
  return { ok: r.ok, status: r.status, text, raw };
}
async function qwenTranscribe(bytes: Uint8Array, contentType: string): Promise<string> {
  const fmt = contentType.includes("wav") ? "wav" : contentType.includes("webm") ? "webm" : contentType.includes("ogg") ? "ogg" : contentType.includes("mpeg") ? "mp3" : contentType.includes("aac") ? "aac" : "mp4";
  const b64 = toB64(bytes);
  const models = workingAsrModel ? [workingAsrModel, ...ASR_CANDIDATES.filter((m) => m !== workingAsrModel)] : ASR_CANDIDATES;
  let lastErr = "";
  // 1) 百炼原生接口（套餐走这条）
  for (const model of models) {
    const r = await asrNative(model, b64, contentType, fmt);
    if (r.ok) {
      workingAsrModel = model; workingAsrVariant = 100;
      console.log("qwen asr ok (native)", model, contentType, bytes.length, r.text.length);
      if (!r.text) throw new NoSpeech("empty text");
      return r.text;
    }
    lastErr = `${model} native ${contentType} ${bytes.length}B: ${r.status} ${r.raw.slice(0, 200)}`;
    console.error("qwen asr failed", lastErr);
    if (r.status === 401 || r.status === 403) throw new Error("asr: " + lastErr);
    if (r.status === 404) continue;                       // 这把 key 没有这个模型，换下一个
    if (r.status === 400 && !/url error/i.test(r.raw)) throw new NoSpeech(lastErr); // 接口通了但没识别出内容：没人声 / 录音读不了
  }
  // 2) 按量付费的 key：OpenAI 兼容的对话接口（qwen3-asr-flash）
  if (ASR_API_KEY.startsWith("sk-sp-")) throw new Error("asr: " + lastErr);
  for (const model of models) {
    const variants = asrBodies(model, b64, contentType, fmt);
    const order = workingAsrVariant >= 0 && workingAsrVariant < variants.length ? [workingAsrVariant, ...variants.map((_, i) => i).filter((i) => i !== workingAsrVariant)] : variants.map((_, i) => i);
    for (const vi of order) {
      const v = variants[vi];
      const r = await fetch(`${ASR_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${ASR_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(v.body) });
      const txt = await r.text();
      if (r.ok) {
        workingAsrModel = model; workingAsrVariant = vi;
        console.log("qwen asr ok", model, v.name, contentType, bytes.length);
        const c = JSON.parse(txt)?.choices?.[0]?.message?.content;
        return (Array.isArray(c) ? c.map((x: { text?: string }) => x.text || "").join("") : String(c || "")).trim();
      }
      lastErr = `${model} ${v.name} ${contentType} ${bytes.length}B: ${r.status} ${txt.slice(0, 300)}`;
      console.error("qwen asr failed", lastErr);
      if (r.status === 401 || r.status === 403) throw new Error("asr: " + lastErr);
      if (r.status === 404 && txt.includes("model_not_found")) break;
    }
  }
  throw new Error("asr: " + lastErr);
}
async function qwenChat(messages: unknown[], extra: Record<string, unknown> = {}): Promise<string> {
  const order = workingChatModel ? [workingChatModel, ...CHAT_CANDIDATES.filter((m) => m !== workingChatModel)] : CHAT_CANDIDATES;
  let lastErr = "";
  for (const model of order) {
    const body = { model, stream: false, enable_thinking: false, temperature: 0.2, messages, ...extra };
    const r = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${DASHSCOPE_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (r.ok) { workingChatModel = model; return String(JSON.parse(txt)?.choices?.[0]?.message?.content || ""); }
    lastErr = `${model}: ${r.status} ${txt.slice(0, 200)}`;
    // 模型不在套餐里 → 换下一个；其它错误（鉴权、参数）也试下一个但记下来
    console.error("qwen chat failed", lastErr);
    if (r.status === 401 || r.status === 403) break;
  }
  throw new Error("chat: " + lastErr);
}
async function qwenIngredients(name: string): Promise<string[]> {
  const sys = "你是中餐家常菜助手。用户给出一道菜，列出在家做这道菜通常需要买的东西：主料、配菜、以及这道菜特有的调料。不要列盐、糖、油、水、生抽、老抽、料酒、葱姜蒜这类几乎每家都有的基础调料。简体中文，每项 2 到 6 个字，5 到 10 项。只返回 JSON：{\"items\":[\"...\"]}";
  let content = "";
  try { content = await qwenChat([{ role: "system", content: sys }, { role: "user", content: name }], { response_format: { type: "json_object" } }); }
  catch (e) {
    // 有的模型不支持 json_object，去掉再试一次
    if (String(e).includes("response_format") || String(e).includes("400")) content = await qwenChat([{ role: "system", content: sys }, { role: "user", content: name }]);
    else throw e;
  }
  let items: unknown = [];
  try { const j = JSON.parse(content); items = Array.isArray(j) ? j : (j.items || j.ingredients || []); }
  catch { const m = content.match(/\[[\s\S]*\]/); if (m) { try { items = JSON.parse(m[0]); } catch { items = []; } } }
  return (items as unknown[]).map((x) => String(x).trim()).filter((x) => x && x.length <= 12).slice(0, 12);
}

// AI 想新菜：带要买的东西和做法。query 是一类菜（「鱼」），没有就随便推荐
async function qwenIdeas(cat: Cat, have: string[], query = "", n = 6): Promise<{ name: string; ingredients: string[]; steps: string[] }[]> {
  const kind = cat === "breakfast" ? "早饭" : "家常正餐（晚饭的菜）";
  const what = query ? `用「${query}」做的${kind}，${n} 道，做法各不一样（清蒸、红烧、煎、炖、炒、汤……）` : `${n} 道适合在家做的${kind}，荤素搭配，口味别都一样`;
  const sys = `你是中餐家常菜助手，给一家人推荐新菜。推荐${what}。要求：菜单里已经有的不要推荐；做法不复杂；食材在美国的华人超市买得到。每道菜附上要买的主要食材（不含盐糖油生抽料酒葱姜蒜这类家里都有的调料，每项 2 到 6 个字，3 到 8 项），和做法（3 到 6 步，每步一句、不超过 25 个字，写给会做饭的长辈看，说清火候和时间）。菜名 2 到 8 个字。只返回 JSON：{"items":[{"name":"菜名","ingredients":["..."],"steps":["..."]}]}`;
  const user = "菜单里已经有：" + (have.length ? have.slice(0, 120).join("、") : "（还是空的）");
  const msgs = [{ role: "system", content: sys }, { role: "user", content: user }];
  let content = "";
  try { content = await qwenChat(msgs, { response_format: { type: "json_object" }, temperature: 0.9 }); }
  catch (e) {
    if (String(e).includes("response_format") || String(e).includes("400")) content = await qwenChat(msgs, { temperature: 0.9 });
    else throw e;
  }
  let items: unknown = [];
  try { const j = JSON.parse(content); items = Array.isArray(j) ? j : (j.items || j.dishes || []); }
  catch { const m = content.match(/\[[\s\S]*\]/); if (m) { try { items = JSON.parse(m[0]); } catch { items = []; } } }
  const out: { name: string; ingredients: string[]; steps: string[] }[] = [];
  for (const x of (Array.isArray(items) ? items : [])) {
    // deno-lint-ignore no-explicit-any
    const o = x as any; const name = String((o && o.name) || (typeof o === "string" ? o : "")).trim().slice(0, 30);
    if (!name || have.includes(name) || out.some((y) => y.name === name)) continue;
    out.push({ name, ingredients: cleanList(o && o.ingredients).filter((y) => y.length <= 12).slice(0, 10), steps: cleanSteps(o && o.steps) });
  }
  return out.slice(0, Math.max(1, n));
}

// ---- 一句话 → 要做的事 ----
// 妈妈习惯一句话说好几件事：「星期三做鱼，礼拜五包饺子，买点葱姜，丝瓜汤这次做不了没丝瓜了」
// 先拆成 actions 给网页，网页念给她听、她说「对」才执行。听不懂的放进 unclear，绝不猜着加。
type Act = { type: string; date?: string; dish?: string; generic?: boolean; dishId?: number; isNew?: boolean;
  items?: { name: string; note?: string }[]; names?: string[]; reason?: string; wishIds?: number[]; what?: string; query?: string; name?: string; cat?: string; text?: string };
const DAY_CN = "日一二三四五六";
function dayWord(date: string, today: string): string {
  const w = "周" + DAY_CN[new Date(date + "T00:00:00Z").getUTCDay()];
  return date === today ? `今晚 ${w}` : date === addDays(today, 1) ? `明晚 ${w}` : date === addDays(today, 2) ? `后天晚上 ${w}` : `${w}晚上`;
}
async function qwenIntent(db: Db, text: string, prev: string, today: string, dates: string[]): Promise<Act[]> {
  const dinner = db.dishes.filter((d) => d.cat === "dinner").map((d) => d.name);
  const bf = db.dishes.filter((d) => d.cat === "breakfast").map((d) => d.name);
  const shop = db.shopping.filter((x) => !x.done).map((x) => x.name);
  const wishes = db.wishes.filter((w) => w.status !== "done").map((w) => `${NAMES[w.who] || w.who}想吃${db.dishes.find((d) => d.id === w.dishId)?.name || ""}`);
  const sys = `你帮一位不太会用手机的妈妈，把她说的一句话拆成要做的事。她说话随意，一句话里可能有好几件事；语音识别可能有错字，按意思理解（比如「小程」就是「小陈」，「礼拜三」「星期三」「周三」一样）。
可以排晚饭的日子，第一个是今晚：${dates.map((d) => `${d}（${dayWord(d, today)}）`).join("、")}
家里菜谱里的晚饭菜：${dinner.join("、") || "（没有）"}
早饭：${bf.join("、") || "（没有）"}
菜篮子里还没买的：${shop.join("、") || "（空的）"}
家里人想吃、还没做的：${wishes.join("、") || "（没有）"}

只返回 JSON：{"actions":[...]}。每个 action 只能是下面一种：
{"type":"plan","date":"日期","dish":"菜名","generic":false} 哪天晚上做什么，一道菜一条；没说哪天就是今晚；菜名跟菜谱里是同一道菜时用菜谱里的写法；只说了一类东西、没说怎么做（鱼、排骨、鸡、牛肉、青菜、汤）时 generic 为 true，dish 写那一类。
{"type":"unplan","date":"日期","dish":"菜名"} 那天不做这道了。
{"type":"nocook","date":"日期"} 那天不做饭。
{"type":"buy","items":[{"name":"东西","note":"数量或备注，没有就空字符串"}]} 要买的东西。
{"type":"have","items":[{"name":"东西"}]} 家里有了、不用买了。
{"type":"bought","items":[{"name":"东西"}]} 已经买到了。
{"type":"ordered"} 都下单了，菜篮子清空。
{"type":"decline","dish":"菜名","reason":"原因，没有就空字符串"} 家里人想吃的某道菜这次做不了。
{"type":"made"} 今晚的饭做好了。
{"type":"ask","what":"home"} 她在问问题，what 是 home（今晚几个人回来吃）、breakfast（早饭吃什么）、plan（这几天做什么）、shopping（还要买什么）之一。
{"type":"ideas","query":"一类菜"} 她想看某类菜有什么做法，或者想要新菜点子；没说哪类时 query 为空字符串。
{"type":"add_dish","name":"菜名","cat":"dinner"} 只把一道菜加进菜谱、不排日子；早饭 cat 写 breakfast。
{"type":"unclear","text":"原话里听不懂的那一段"} 听不懂、拿不准的部分原样放这里，不要猜。
不要编她没说的事。菜名和东西名里不要带「做」「吃」「买」「星期三」这类字。`;
  const user = prev ? `她刚才说：「${prev}」\n现在她更正说：「${text}」\n按更正后的意思，给出完整的 actions。` : text;
  let content = "";
  const msgs = [{ role: "system", content: sys }, { role: "user", content: user }];
  try { content = await qwenChat(msgs, { response_format: { type: "json_object" }, temperature: 0.1 }); }
  catch (e) { if (String(e).includes("response_format") || String(e).includes("400")) content = await qwenChat(msgs, { temperature: 0.1 }); else throw e; }
  const j = JSON.parse((content.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  return Array.isArray(j.actions) ? j.actions : [];
}
// 没有 AI 或者 AI 出错时的简单兜底：认得日子、「做」「买」「买到了」「家里有」「做好了」
function localIntent(text: string, today: string, dates: string[]): Act[] {
  const t = text.replace(/[，,。.!！?？\s]+/g, "，");
  const out: Act[] = [];
  for (const seg of t.split("，").map((x) => x.trim()).filter(Boolean)) {
    let date = dates[0];
    const m = seg.match(/(?:星期|礼拜|周)([一二三四五六日天])/);
    if (m) { const k = "日一二三四五六天".indexOf(m[1]) % 7; const hit = dates.find((d) => new Date(d + "T00:00:00Z").getUTCDay() === k); if (hit) date = hit; }
    else if (/明天|明晚/.test(seg)) date = dates.find((d) => d === addDays(today, 1)) || date;
    else if (/后天/.test(seg)) date = dates.find((d) => d === addDays(today, 2)) || date;
    const body = seg.replace(/(?:星期|礼拜|周)[一二三四五六日天]|今天|今晚|明天|明晚|后天|晚上|我们|我|要|想/g, "");
    if (/做好了/.test(body)) out.push({ type: "made" });
    else if (/(买到了|买了)/.test(body)) out.push({ type: "bought", items: [{ name: body.replace(/(买到了|买了|也|都)/g, "") }] });
    else if (/(家里有|不用买)/.test(body)) out.push({ type: "have", items: [{ name: body.replace(/(家里有了?|不用买了?)/g, "") }] });
    else if (/不做饭/.test(body)) out.push({ type: "nocook", date });
    else if (/^买/.test(body) || /买点|买个|买些/.test(body)) for (const n of body.replace(/买点|买个|买些|买/g, "、").split(/[、和跟]/)) { if (n.trim()) out.push({ type: "buy", items: [{ name: n.trim() }] }); }
    else if (/(做|烧|炖|蒸|煮|包)/.test(body)) out.push({ type: "plan", date, dish: body.replace(/^(做|烧|炖|蒸|煮)/, "") });
    else out.push({ type: "unclear", text: seg });
  }
  return out;
}
// 把 AI 给的 actions 对上家里的数据：日子、菜（菜谱里有没有、是不是一类菜）、心愿
function resolveActs(db: Db, acts: Act[], dates: string[]): Act[] {
  const out: Act[] = [];
  const norm = (x: unknown) => String(x ?? "").replace(/\s+/g, "").trim().slice(0, 30);
  const day = (d: unknown) => (dates.includes(String(d)) ? String(d) : dates[0]);
  const items = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => typeof x === "string" ? { name: norm(x) } : { name: norm(x?.name), note: norm(x?.note).slice(0, 20) || undefined }).filter((x) => x.name && x.name.length <= 12);
  for (const a of acts.slice(0, 20)) {
    const type = String(a?.type || "");
    if (type === "plan") {
      const name = norm(a.dish); if (!name) continue;
      const dish = db.dishes.find((d) => d.name === name);
      const contains = db.dishes.filter((d) => d.cat === "dinner" && d.name !== name && d.name.includes(name));
      const generic = CATEGORY_WORDS.includes(name) || (!dish && !!a.generic) || (!dish && name.length <= 2 && contains.length >= 2);
      out.push(generic ? { type, date: day(a.date), dish: name, generic: true } : { type, date: day(a.date), dish: name, dishId: dish?.id, isNew: !dish });
    } else if (type === "unplan") {
      const name = norm(a.dish); const date = day(a.date); const p = db.plans[date];
      const dish = p?.cook?.dishIds.map((id) => db.dishes.find((d) => d.id === id)).find((d) => d && (d.name === name || d.name.includes(name) || name.includes(d.name)));
      if (dish) out.push({ type, date, dish: dish.name, dishId: dish.id });
      else if (p?.cook?.pending && (p.cook.pending === name)) out.push({ type, date, dish: name });
      else out.push({ type: "unclear", text: `${name}（那天没排这道）` });
    } else if (type === "nocook") out.push({ type, date: day(a.date) });
    else if (type === "buy" || type === "have" || type === "bought") { const it = items(a.items); if (it.length) out.push({ type, items: it }); }
    else if (type === "ordered" || type === "made") out.push({ type });
    else if (type === "decline") {
      const name = norm(a.dish);
      const ws = db.wishes.filter((w) => w.status !== "done").filter((w) => { const d = db.dishes.find((x) => x.id === w.dishId); return d && (d.name === name || d.name.includes(name) || name.includes(d.name)); });
      if (ws.length) out.push({ type, dish: db.dishes.find((d) => d.id === ws[0].dishId)!.name, reason: norm(a.reason).slice(0, 20), wishIds: ws.map((w) => w.id), names: [...new Set(ws.map((w) => NAMES[w.who] || w.who))] });
      else out.push({ type: "unclear", text: `${name}做不了（没人点这道菜）` });
    } else if (type === "ask") { const w = String(a.what || ""); out.push({ type, what: ["home", "breakfast", "plan", "shopping"].includes(w) ? w : "plan" }); }
    else if (type === "ideas") out.push({ type, query: norm(a.query).slice(0, 10) });
    else if (type === "add_dish") { const name = norm(a.name); if (name) out.push({ type, name, cat: a.cat === "breakfast" ? "breakfast" : "dinner", isNew: !db.dishes.some((d) => d.name === name) }); }
    else if (type === "unclear") { const t = norm(a.text); if (t) out.push({ type, text: t }); }
  }
  return out;
}

// ---- 响应 ----
function corsHeaders(): Headers {
  const h = new Headers();
  h.set("access-control-allow-origin", ALLOWED_ORIGIN);
  h.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-max-age", "86400");
  h.set("vary", "origin");
  return h;
}
const encoder = new TextEncoder();
const json = (body: unknown, status = 200) => {
  const headers = corsHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(encoder.encode(JSON.stringify(body)), { status, headers });
};
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const cleanSteps = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x).replace(/^\s*\d+[.、．)]\s*/, "").trim()).filter((x) => x && x.length <= 60).slice(0, 10);
const cleanList = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 20).filter((x, i, a) => a.indexOf(x) === i).slice(0, 30);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/" + FUNCTION_NAME);
  let path = i >= 0 ? url.pathname.slice(i + FUNCTION_NAME.length + 1) : url.pathname;
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "") || "/";
  const m = req.method;
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  try {
    if (m === "GET" && path === "/") return json({ ok: true, build: BUILD, hint: "这是早饭决定器的接口；网页请打开 GitHub Pages 的地址。", tz: TZ, qwenKey: DASHSCOPE_API_KEY ? "已配置" : "没有读到 DASHSCOPE_API_KEY", tokenPlan: IS_TOKEN_PLAN, qwenBase: DASHSCOPE_BASE_URL, asrBase: ASR_BASE_URL, asrModel: QWEN_ASR_MODEL, chatModel: QWEN_CHAT_MODEL });

    // 自检：key 的样子 + 几个地址哪个认这把 key（不泄露 key 本身）
    if (m === "GET" && path === "/api/qwen-check") {
      const k = DASHSCOPE_API_KEY;
      const bases = [DASHSCOPE_BASE_URL, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1"].filter((b, i, a) => a.indexOf(b) === i);
      const results = [];
      for (const b of bases) {
        try {
          const r = await fetch(`${b}/models`, { headers: { authorization: `Bearer ${k}` } });
          const t = await r.text();
          results.push({ base: b, status: r.status, ok: r.ok, snippet: t.slice(0, 160) });
        } catch (e) { results.push({ base: b, status: 0, ok: false, snippet: String(e).slice(0, 160) }); }
      }
      // 再用主地址真跑一次最小对话，看套餐是否放行这个模型
      let chat: unknown = null;
      try { const reply = await qwenChat([{ role: "user", content: "回复一个字：好" }]); chat = { ok: true, model: workingChatModel, reply: reply.slice(0, 50) }; }
      catch (e) { chat = { ok: false, error: String(e).slice(0, 300) }; }
      return json({ keyLength: k.length, keyStartsWith: k.slice(0, 6), tokenPlan: IS_TOKEN_PLAN, usingBase: DASHSCOPE_BASE_URL, asrBase: ASR_BASE_URL, keyHasWhitespace: /\s/.test(k), keyHasQuotes: /["'“”‘’]/.test(k), results, chatTest: chat });
    }

    // 列出当前地址 / key 能用的模型（看套餐包含什么）
    if (m === "GET" && path === "/api/qwen-models") {
      try {
        const r = await fetch(`${DASHSCOPE_BASE_URL}/models`, { headers: { authorization: `Bearer ${DASHSCOPE_API_KEY}` } });
        const t = await r.text();
        let ids: string[] = [];
        try { const j = JSON.parse(t); ids = (j.data || []).map((x: { id: string }) => x.id); } catch { /* 原样返回 */ }
        return json({ base: DASHSCOPE_BASE_URL, status: r.status, count: ids.length, models: ids, raw: ids.length ? undefined : t.slice(0, 500), workingChatModel, workingAsrModel, candidates: CHAT_CANDIDATES, asrCandidates: ASR_CANDIDATES });
      } catch (e) { return json({ error: String(e) }, 502); }
    }

    if ((m === "GET" || m === "POST") && path === "/api/cron") {
      const r = await runReminders();
      const { db } = await loadDb();
      for (const [w, q] of Object.entries(db.notify || {})) if (Date.now() - Date.parse(q.at) > NOTIFY_DELAY_MS * 3) inBackground(flushNotify(w, null));
      return json(r);
    }

    if (m === "GET" && path === "/api/state") {
      let { db, changed } = await loadDb();
      const qDate = url.searchParams.get("date") || "";
      const qHour = Number(url.searchParams.get("hour"));
      const dDate = url.searchParams.get("ddate") || "";
      const qTz = url.searchParams.get("tz") || "";
      if (qTz && qTz !== db.tz && validTz(qTz)) { db.tz = qTz; changed = true; }
      if (DATE_RE.test(qDate)) {
        changed = settle(db, qDate) || changed;
        if (Number.isInteger(qHour) && qHour >= 0 && qHour <= 23) changed = autoPickIfDue(db, qDate, qHour) || changed;
      }
      if (DATE_RE.test(dDate)) { if (!db.plans[dDate]) { planFor(db, dDate); changed = true; } }
      if (!db.vapid) { db.vapid = await newVapid(); changed = true; }
      syncWishes(db);
      if (changed) await saveDb(db);
      // 兜底：有记下来却很久没发出去的动态（后台计时被打断了），现在补发
      for (const [w, q] of Object.entries(db.notify || {})) if (Date.now() - Date.parse(q.at) > NOTIFY_DELAY_MS * 3) inBackground(flushNotify(w, null));
      const dayPlan = (n: number): Plan => db.plans[addDays(dDate, n)] || { date: addDays(dDate, n), replies: {}, cook: null };
      // today / tomorrow 留给还没刷新的旧网页；新网页用 days（从今晚起 7 天，可以提前排一周）
      const plans = DATE_RE.test(dDate) ? { today: db.plans[dDate], tomorrow: dayPlan(1), days: [0, 1, 2, 3, 4, 5, 6].map(dayPlan) } : {};
      // 常买：家里人自己加的；recent 是最近买得多的，改常买时可以一点就加
      const staples = db.staples || [];
      const recent = Object.entries(db.shopHistory).sort((a, b) => b[1] - a[1]).map(([n]) => n).filter((n) => !staples.includes(n)).slice(0, 16);
      // frequent 留给还没刷新的旧网页
      const pushOnAll: Record<string, number> = {}; for (const w of PEOPLE) pushOnAll[w] = (db.push?.[w] || []).length;
      return json({ dishes: db.dishes, pick: db.pick, pickDate: db.pickDate, targetDate: targetDate(db), wishes: db.wishes, plans, shopping: db.shopping, staples, recent, frequent: staples, pushKey: db.vapid?.publicKey || "", pushOn: pushOnAll[NOTIFY_TO], pushOnAll, profiles: db.profiles, voice: !!DASHSCOPE_API_KEY, ai: !!DASHSCOPE_API_KEY, autoPickHour: AUTO_PICK_HOUR, ledger: db.ledger || [], inbox: (db.inbox || []).slice(-INBOX_MAX), tz: db.tz || TZ, hbUnit: HB_UNIT });
    }

    if (m === "POST" && path === "/api/pick") {
      const body = await req.json().catch(() => ({}));
      const type = String(body.type || "");
      const { db } = await loadDb();
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : targetDate(db);
      const pool = db.dishes.filter((d) => d.cat === "breakfast");
      if (type === "skip") db.pick = { type: "skip", dish: null, dishes: [], resolvedName: null };
      else if (type === "random") {
        if (!pool.length) return bad("还没有早饭菜");
        const dish = pool[Math.floor(Math.random() * pool.length)];
        db.pick = { type: "random", dish: dish.id, dishes: [dish.id], resolvedName: dish.name };
      } else if (type === "dishes") {
        const wanted: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
        const picked = wanted.filter((id, k) => wanted.indexOf(id) === k).map((id) => db.dishes.find((d) => d.id === id)).filter((d): d is Dish => !!d);
        if (!picked.length) { db.pick = null; db.pickDate = null; await saveDb(db); return json({ pick: null, pickDate: null }); }
        db.pick = { type: "dish", dish: picked[0].id, dishes: picked.map((d) => d.id), resolvedName: picked.map((d) => d.name).join("＋") };
      } else return bad("不认识的选择");
      db.pickDate = date;
      const t = queueNotify(db, String(body.who || ""), { k: "pick", date });
      await saveDb(db);
      scheduleNotify(t);
      return json({ pick: db.pick, pickDate: db.pickDate });
    }

    if (m === "POST" && path === "/api/dishes") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 30);
      if (!name) return bad("菜名不能为空");
      const cat: Cat = body.cat === "dinner" ? "dinner" : "breakfast";
      const { db } = await loadDb();
      if (db.dishes.length >= 200) return bad("菜太多啦，先删几道");
      const exists = db.dishes.find((d) => d.name === name);
      if (exists) return json({ dish: exists, existed: true });
      const dish = ensureDish(db, name, cat, String(body.by || ""));
      if (body.mom === true) dish.mom = true;
      if (body.ingredients) dish.ingredients = cleanList(body.ingredients);
      if (body.steps) dish.steps = cleanSteps(body.steps);
      await saveDb(db);
      return json({ dish, existed: false });
    }

    if (m === "POST" && path === "/api/dishes/reorder") {
      const body = await req.json().catch(() => ({}));
      const cat: Cat = body.cat === "dinner" ? "dinner" : "breakfast";
      const ids: number[] = (Array.isArray(body.ids) ? body.ids.map(Number) : []).filter((x: number, k: number, a: number[]) => a.indexOf(x) === k);
      const { db } = await loadDb();
      // 这一栏的菜在总表里占的位置不变，按新顺序依次填回去；没传到的菜排在后面、保持原来的先后
      const slots = db.dishes.map((d, k) => d.cat === cat ? k : -1).filter((k) => k >= 0);
      const same = slots.map((k) => db.dishes[k]);
      const ordered = [...ids.map((id) => same.find((d) => d.id === id)).filter((d): d is Dish => !!d), ...same.filter((d) => !ids.includes(d.id))];
      slots.forEach((k, j) => { db.dishes[k] = ordered[j]; });
      await saveDb(db);
      return json({ ok: true });
    }

    const dishRoute = path.match(/^\/api\/dishes\/(\d+)(?:\/(move|photo|update))?$/);
    if (dishRoute) {
      const id = Number(dishRoute[1]); const sub = dishRoute[2];
      const { db } = await loadDb();
      const idx = db.dishes.findIndex((d) => d.id === id);
      if (idx < 0) return bad("找不到这道菜", 404);
      const dish = db.dishes[idx];
      if (m === "DELETE" && !sub) {
        db.dishes.splice(idx, 1);
        if (db.pick && db.pick.type !== "skip") {
          const rest = (db.pick.dishes || (db.pick.dish != null ? [db.pick.dish] : [])).filter((x) => x !== id);
          if (!rest.length) { db.pick = null; db.pickDate = null; }
          else db.pick = { ...db.pick, dish: rest[0], dishes: rest, resolvedName: rest.map((x) => db.dishes.find((d) => d.id === x)?.name || "").filter(Boolean).join("＋") };
        }
        db.wishes = db.wishes.filter((w) => w.dishId !== id);
        for (const p of Object.values(db.plans)) if (p.cook) p.cook.dishIds = p.cook.dishIds.filter((x) => x !== id);
        await saveDb(db);
        if (dish.image) await supabase.storage.from(BUCKET).remove([`${id}.jpg`]).catch(() => {});
        return json({ ok: true });
      }
      if (m === "POST" && sub === "update") {
        const body = await req.json().catch(() => ({}));
        if (typeof body.name === "string" && body.name.trim()) {
          const n = body.name.trim().slice(0, 30);
          if (db.dishes.some((d) => d.id !== id && d.name === n)) return bad("已经有这道菜了");
          dish.name = n; dish.emoji = emojiFor(n);
        }
        if (body.cat === "dinner" || body.cat === "breakfast") dish.cat = body.cat;
        if (typeof body.mom === "boolean") dish.mom = body.mom;
        if (body.ingredients !== undefined) dish.ingredients = cleanList(body.ingredients);
        if (body.steps !== undefined) dish.steps = cleanSteps(body.steps);
        await saveDb(db);
        return json({ dish });
      }
      if (m === "POST" && sub === "move") {
        const body = await req.json().catch(() => ({}));
        const same = db.dishes.map((d, k) => ({ d, k })).filter((x) => x.d.cat === dish.cat);
        const pos = same.findIndex((x) => x.d.id === id);
        const j = body.direction === "up" ? pos - 1 : pos + 1;
        if (j >= 0 && j < same.length) {
          const a = same[pos].k, b = same[j].k;
          [db.dishes[a], db.dishes[b]] = [db.dishes[b], db.dishes[a]];
          await saveDb(db);
        }
        return json({ ok: true });
      }
      if (m === "POST" && sub === "photo") {
        const ct = (req.headers.get("content-type") || "").split(";")[0].trim();
        if (!/^image\/(jpeg|png|webp)$/.test(ct)) return bad("只能传 jpg / png / webp 图片");
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.length) return bad("图片是空的");
        if (bytes.length > 5 * 1024 * 1024) return bad("照片太大了，超过 5MB");
        const key = `${id}.jpg`;
        const { error } = await supabase.storage.from(BUCKET).upload(key, bytes, { contentType: ct, upsert: true, cacheControl: "31536000" });
        if (error) throw error;
        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
        dish.image = `${pub.publicUrl}?v=${Date.now()}`;
        await saveDb(db);
        return json({ dish });
      }
    }

    if (m === "POST" && path === "/api/wishes") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!MEMBERS.includes(who) && who !== "mom") return bad("不认识这个人");
      const { db } = await loadDb();
      let dish: Dish | undefined;
      if (body.dishId) dish = db.dishes.find((d) => d.id === Number(body.dishId));
      else if (typeof body.name === "string" && body.name.trim()) dish = ensureDish(db, String(body.name).slice(0, 30), "dinner", who);
      if (!dish) return bad("找不到这道菜");
      const dup = db.wishes.find((w) => w.dishId === dish!.id && w.who === who && w.status !== "done");
      const hb = body.hb !== undefined ? cleanHb(body.hb) : undefined;
      const hbMsg = typeof body.hbMsg === "string" ? cleanMsg(body.hbMsg) : undefined;
      let t: { who: string; token: number } | null = null;
      if (dup) {
        const before = dup.hb || 0;
        if (hb !== undefined) dup.hb = hb || undefined;
        if (hbMsg !== undefined) dup.hbMsg = hbMsg || undefined;
        if ((dup.hb || 0) > before) t = queueNotify(db, who, { k: "hb", id: dup.id });
      } else {
        const w: Wish = { id: Date.now(), dishId: dish.id, who, at: nowIso(), status: "open", hb: hb || undefined, hbMsg: (hb && hbMsg) || undefined };
        db.wishes.push(w);
        t = queueNotify(db, who, { k: "wish", id: w.id });
      }
      syncWishes(db);
      await saveDb(db);
      scheduleNotify(t);
      return json({ wishes: db.wishes, dish });
    }
    const wishRoute = path.match(/^\/api\/wishes\/(\d+)\/(remove|update|decline)$/);
    if (wishRoute && m === "POST") {
      const id = Number(wishRoute[1]);
      const { db } = await loadDb();
      let t: { who: string; token: number } | null = null;
      if (wishRoute[2] === "decline") {
        // 妈妈说这道菜这次做不了（比如时令过了）：心愿拿掉，告诉点菜的人，带上原因
        const body = await req.json().catch(() => ({}));
        const w = db.wishes.find((x) => x.id === id);
        if (!w) return bad("找不到这个心愿", 404);
        const d = db.dishes.find((x) => x.id === w.dishId);
        const reason = cleanMsg(body.reason);
        db.wishes = db.wishes.filter((x) => x.id !== id);
        const text = `妈妈：${d?.name || "这道菜"} 这次做不了${reason ? "，" + reason : ""}，换一道吧`;
        inboxAdd(db, w.who, "mom", text);
        await saveDb(db);
        inBackground(pushTo(db, w.who, { title: "吃什么 · 妈妈说", body: text, tag: "breakfast-mom" }));
        return json({ wishes: db.wishes });
      }
      if (wishRoute[2] === "remove") db.wishes = db.wishes.filter((w) => w.id !== id);
      else {
        const body = await req.json().catch(() => ({}));
        const w = db.wishes.find((x) => x.id === id);
        if (!w) return bad("找不到这个心愿", 404);
        const before = { hb: w.hb || 0, msg: w.hbMsg || "", paid: !!w.hbPaid };
        if (body.hb !== undefined) w.hb = cleanHb(body.hb) || undefined;
        if (typeof body.hbMsg === "string") w.hbMsg = cleanMsg(body.hbMsg) || undefined;
        if (!w.hb) w.hbMsg = undefined;
        if (typeof body.hbPaid === "boolean") { w.hbPaid = body.hbPaid || undefined; for (const l of db.ledger || []) if (l.wishId === w.id) l.paidAt = body.hbPaid ? (l.paidAt || nowIso()) : undefined; }
        // 包了红包、改了金额或那句话、红包发了 → 告诉妈妈
        if (w.hb && (w.hb !== before.hb || (w.hbMsg || "") !== before.msg)) t = queueNotify(db, w.who, { k: "hb", id: w.id });
        if (w.hbPaid && !before.paid) t = queueNotify(db, w.who, { k: "paid", id: w.id });
      }
      await saveDb(db);
      scheduleNotify(t);
      return json({ wishes: db.wishes });
    }

    const profRoute = path.match(/^\/api\/profile\/(\w+)\/photo$/);
    if (profRoute && m === "POST") {
      const who = profRoute[1];
      if (!PEOPLE.includes(who)) return bad("不认识这个人");
      const ct = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(ct)) return bad("只能传 jpg / png / webp 图片");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length) return bad("图片是空的");
      if (bytes.length > 3 * 1024 * 1024) return bad("照片太大了，超过 3MB");
      const key = `avatar-${who}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(key, bytes, { contentType: ct, upsert: true, cacheControl: "31536000" });
      if (error) throw error;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
      const { db } = await loadDb();
      db.profiles[who] = { ...(db.profiles[who] || {}), avatar: `${pub.publicUrl}?v=${Date.now()}` };
      await saveDb(db);
      return json({ profiles: db.profiles });
    }

    if (m === "POST" && path === "/api/feedback") {
      const body = await req.json().catch(() => ({}));
      const who = PEOPLE.includes(String(body.who)) ? String(body.who) : "";
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return bad("还没写内容");
      const { db } = await loadDb();
      db.feedback.push({ id: Date.now(), who, text, at: nowIso() });
      if (db.feedback.length > 100) db.feedback = db.feedback.slice(-100);
      await saveDb(db);
      return json({ ok: true });
    }

    if (m === "POST" && (path === "/api/suggest" || path === "/api/ideas")) {
      if (!DASHSCOPE_API_KEY) return bad("还没配置 AI", 501);
      const body = await req.json().catch(() => ({}));
      const cat: Cat = body.cat === "breakfast" ? "breakfast" : "dinner";
      const query = String(body.query || "").trim().slice(0, 10);
      const n = Math.min(8, Math.max(1, Number(body.n) || (query ? 3 : 6)));
      const exclude = (Array.isArray(body.exclude) ? body.exclude : []).map((x: unknown) => String(x)).slice(0, 30);
      const { db } = await loadDb();
      try { return json({ items: await qwenIdeas(cat, [...db.dishes.map((d) => d.name), ...exclude], query, n) }); }
      catch { return bad("AI 服务出错了，请再试一次", 502); }
    }

    if (m === "POST" && path === "/api/intent") {
      const body = await req.json().catch(() => ({}));
      const text = String(body.text || "").trim().slice(0, 300);
      const prev = String(body.prev || "").trim().slice(0, 300);
      if (!text) return bad("没听到说什么");
      const { db } = await loadDb();
      const today = DATE_RE.test(String(body.today || "")) ? String(body.today) : localNow(db).date;
      let dates: string[] = (Array.isArray(body.dates) ? body.dates : []).map(String).filter((d: string) => DATE_RE.test(d)).slice(0, 14);
      if (!dates.length) dates = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(today, i));
      let acts: Act[] = []; let via = "ai";
      if (DASHSCOPE_API_KEY) { try { acts = await qwenIntent(db, text, prev, today, dates); } catch (e) { console.error("intent ai failed", e); via = "local"; } }
      else via = "local";
      if (via === "local") acts = localIntent(prev ? text : text, today, dates);
      return json({ text, actions: resolveActs(db, acts, dates), via });
    }

    if (m === "POST" && path === "/api/dinner/reply") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!MEMBERS.includes(who)) return bad("不认识这个人");
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const { db } = await loadDb();
      const plan = planFor(db, date);
      const wasAway = plan.replies[who]?.home === false;
      plan.replies[who] = { home: body.home === true ? true : body.home === false ? false : null, at: nowIso() };
      const t = plan.replies[who].home === false && !wasAway ? queueNotify(db, who, { k: "away", date }) : null;
      await saveDb(db);
      scheduleNotify(t);
      return json({ plan });
    }

    if (m === "POST" && path === "/api/dinner/cook") {
      const body = await req.json().catch(() => ({}));
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const { db } = await loadDb();
      const plan = planFor(db, date);
      const ids: number[] = (Array.isArray(body.dishIds) ? body.dishIds.map(Number) : []).filter((x: number, k: number, a: number[]) => a.indexOf(x) === k && db.dishes.some((d) => d.id === x));
      const text = String(body.text || "").trim().slice(0, 60);
      const pending = String(body.pending || "").trim().slice(0, 20);
      if (plan.done) return bad("这天已经做好了");
      const sig = () => JSON.stringify(plan.cook ? [plan.cook.dishIds, plan.cook.text, plan.cook.pending || ""] : null);
      const before = sig();
      const prevIds = plan.cook ? plan.cook.dishIds.slice() : [];
      plan.cook = ids.length || text || pending ? { dishIds: ids, text, at: nowIso(), ...(pending ? { pending } : {}) } : null;
      // 新排上的菜：食材自动进菜篮子；换掉的菜自动加的东西拿掉
      const newIds = ids.filter((x) => !prevIds.includes(x));
      await fillIngredients(db, newIds);
      const shopAdded = autoShop(db, date, newIds);
      pruneAuto(db);
      syncWishes(db);
      const t = sig() !== before ? queueNotify(db, "mom", { k: "cook", date }) : null;
      await saveDb(db);
      scheduleNotify(t);
      return json({ plan, wishes: db.wishes, shopAdded });
    }

    // 妈妈点「做好了」：当场结算这天的晚饭，红包进账本，告诉女儿、小陈
    if (m === "POST" && path === "/api/dinner/done") {
      const body = await req.json().catch(() => ({}));
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const { db } = await loadDb();
      const plan = db.plans[date];
      if (!plan || !plan.cook || !plan.cook.dishIds.length) return bad("这天还没定做什么");
      if (plan.done) return json({ plan, made: dishNames(db, plan.cook.dishIds), hb: (db.ledger || []).filter((l) => l.date === date), already: true });
      const r = finishPlan(db, plan);
      syncWishes(db);
      const t = queueNotify(db, "mom", { k: "made", date });
      await saveDb(db);
      scheduleNotify(t);
      return json({ plan, made: r.made.map((d) => d.name).join("＋"), hb: (db.ledger || []).filter((l) => l.date === date), home: MEMBERS.filter((w) => plan.replies[w]?.home !== false).map((w) => NAMES[w]) });
    }

    // 菜谱本里点「我想做」→ 选一天：把这道菜加进那天的晚饭，原来定的菜留着
    if (m === "POST" && path === "/api/dinner/add") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!PEOPLE.includes(who)) return bad("不认识这个人");
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const { db } = await loadDb();
      const today = localNow(db).date;
      if (date < addDays(today, -2) || date > addDays(today, 14)) return bad("只能排最近两周的");
      const plan = planFor(db, date);
      if (plan.done) return bad("这天已经做好了，换一天吧");
      const keep = plan.cook && plan.cook.text && plan.cook.text !== UNSURE && plan.cook.text !== NO_COOK ? plan.cook.text : "";
      // 只说了一类菜（「周三做鱼」）还没定怎么做：先记下这一类，菜篮子里会提醒
      const pendingOnly = String(body.pending || "").trim().slice(0, 20);
      if (pendingOnly && !body.dishId) {
        plan.cook = { dishIds: plan.cook ? plan.cook.dishIds.slice() : [], text: keep, at: nowIso(), pending: pendingOnly };
        const tp = queueNotify(db, who, who === "mom" ? { k: "cook", date } : { k: "plan", date });
        await saveDb(db);
        scheduleNotify(tp);
        return json({ plan, wishes: db.wishes, added: false, shopAdded: [] });
      }
      const dish = db.dishes.find((d) => d.id === Number(body.dishId));
      if (!dish) return bad("找不到这道菜");
      // replaceDishId：原来排的是「鱼」这种没食材的菜，换成具体的做法
      const ids = (plan.cook ? plan.cook.dishIds.slice() : []).filter((x) => x !== Number(body.replaceDishId));
      const added = !ids.includes(dish.id);
      if (added) ids.push(dish.id);
      // 原来写的「还没想好」「不做饭」作废；别的文字（比如妈妈说的一道菜单外的菜）留着；定了具体做法，「还没定怎么做」也作废
      const pend = plan.cook?.pending && !body.clearPending ? { pending: plan.cook.pending } : {};
      plan.cook = { dishIds: ids, text: keep, at: nowIso(), ...pend };
      // 女儿小陈排的：也算点了这道菜，进心愿单（可以包红包，做好了会结算）
      if (MEMBERS.includes(who) && !db.wishes.some((w) => w.dishId === dish.id && w.who === who && w.status !== "done")) {
        db.wishes.push({ id: Date.now(), dishId: dish.id, who, at: nowIso(), status: "open" });
      }
      await fillIngredients(db, added ? [dish.id] : []);
      const shopAdded = added ? autoShop(db, date, [dish.id]) : [];
      pruneAuto(db);
      syncWishes(db);
      const t = added ? queueNotify(db, who, who === "mom" ? { k: "cook", date } : { k: "plan", id: dish.id, date }) : null;
      await saveDb(db);
      scheduleNotify(t);
      return json({ plan, wishes: db.wishes, added, shopAdded });
    }

    // 红包发了：账本里标成已发
    if (m === "POST" && path === "/api/hb/paid") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      const ids: number[] = (Array.isArray(body.ids) ? body.ids.map(Number) : []);
      const { db } = await loadDb();
      let t: { who: string; token: number } | null = null;
      for (const l of db.ledger || []) if (ids.includes(l.id) && !l.paidAt) {
        l.paidAt = nowIso();
        const w = db.wishes.find((x) => x.id === l.wishId); if (w) w.hbPaid = true;
        if (PEOPLE.includes(who)) t = queueNotify(db, who, { k: "lpaid", id: l.id });
      }
      await saveDb(db);
      scheduleNotify(t);
      return json({ ledger: db.ledger || [] });
    }

    if (m === "POST" && path === "/api/shopping") {
      const body = await req.json().catch(() => ({}));
      const op = String(body.op || "");
      const { db } = await loadDb();
      const added: number[] = [];
      // 按名字找清单里还没买的（说「鸡蛋」也能对上「土鸡蛋」）
      const findOpen = (n: string) => db.shopping.filter((it) => !it.done && (it.name === n || it.name.includes(n) || n.includes(it.name)));
      if (op === "add") {
        const names = cleanList(body.names);
        if (!names.length) return bad("没有要加的东西");
        const from = typeof body.from === "string" ? body.from.slice(0, 30) : "";
        const notes = body.notes && typeof body.notes === "object" ? body.notes : {};
        for (const n of names) {
          const open = db.shopping.find((it) => it.name === n && !it.done);
          const note = typeof notes[n] === "string" ? notes[n].trim().slice(0, 20) : "";
          if (open) { if (note) open.note = note; continue; }
          if (db.shopping.length >= 150) return bad("清单太长了，先清一下已买的");
          const id = Date.now() + Math.floor(Math.random() * 1e6);
          db.shopping.push({ id, name: n, done: false, from: from || undefined, at: nowIso(), note: note || undefined });
          db.shopHistory[n] = (db.shopHistory[n] || 0) + 1;
          added.push(id);
        }
        const keys = Object.keys(db.shopHistory);
        if (keys.length > 60) for (const k of keys.sort((a, b) => db.shopHistory[a] - db.shopHistory[b]).slice(0, keys.length - 60)) delete db.shopHistory[k];
      } else if (op === "toggle" || op === "remove") {
        const id = Number(body.id);
        const it = db.shopping.find((x) => x.id === id);
        if (!it) return bad("清单里没有这一项", 404);
        if (op === "remove") db.shopping = db.shopping.filter((x) => x.id !== id);
        else { it.done = !it.done; it.doneAt = it.done ? nowIso() : undefined; }
      } else if (op === "check" || op === "drop") {
        // 说一句：「鸡蛋买到了」= check（打钩），「葱家里有」= drop（拿掉）
        const names = cleanList(body.names); const hit: string[] = [];
        for (const n of names) for (const it of findOpen(n)) {
          hit.push(it.name);
          if (op === "check") { it.done = true; it.doneAt = nowIso(); } else db.shopping = db.shopping.filter((x) => x.id !== it.id);
        }
        await saveDb(db);
        return json({ shopping: db.shopping, hit });
      } else if (op === "clear_done") {
        db.shopping = db.shopping.filter((x) => !x.done);
      } else if (op === "ordered") {
        // 已下单：全部算买到并清空（常买记录在加入时已记过）
        db.shopping = [];
      } else return bad("不认识的操作");
      await saveDb(db);
      return json({ shopping: db.shopping, added });
    }

    if (m === "POST" && path === "/api/push/subscribe") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!PEOPLE.includes(who)) return bad("不认识这个人");
      const s = body.sub || {};
      const endpoint = String(s.endpoint || ""), p256dh = String(s.keys?.p256dh || ""), auth = String(s.keys?.auth || "");
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return bad("通知订阅不对");
      const { db } = await loadDb();
      if (!db.vapid || body.key !== db.vapid.publicKey) return bad("通知的钥匙换了，请再点一次", 409);
      const push = db.push || (db.push = {});
      push[who] = [...(push[who] || []).filter((x) => x.endpoint !== endpoint), { endpoint, keys: { p256dh, auth }, at: nowIso() }].slice(-5);
      await saveDb(db);
      return json({ ok: true, devices: push[who].length });
    }
    if (m === "POST" && path === "/api/push/unsubscribe") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      const { db } = await loadDb();
      if (db.push?.[who]) { db.push[who] = db.push[who].filter((x) => x.endpoint !== String(body.endpoint || "")); await saveDb(db); }
      return json({ ok: true });
    }
    if (m === "POST" && path === "/api/push/test") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!PEOPLE.includes(who)) return bad("不认识这个人");
      const { db } = await loadDb();
      if (!(db.push?.[who] || []).length) return bad("这台手机还没打开通知", 404);
      const text = who === "mom" ? "以后有人说不回来吃、点菜、选好早饭、包红包，手机会提醒你打开看" : "以后晚上会提醒选早饭，早上提醒说今晚回不回来；妈妈定了做什么、做好了也会告诉你";
      const results = await pushTo(db, who, { title: "吃什么 · 通知打开了 🔔", body: text, tag: "breakfast-test" });
      return json({ results, ok: results.some((s) => s >= 200 && s < 300) });
    }

    if (m === "POST" && path === "/api/staples") {
      const body = await req.json().catch(() => ({}));
      const { db } = await loadDb();
      const list = db.staples || (db.staples = []);
      if (body.op === "add") {
        const names = cleanList(body.names);
        if (!names.length) return bad("没有要加的东西");
        for (const n of names) if (!list.includes(n)) list.push(n);
        if (list.length > 40) return bad("常买太多了，先删几样");
      } else if (body.op === "remove") {
        const n = String(body.name || "").trim();
        db.staples = list.filter((x) => x !== n);
      } else return bad("不认识的操作");
      await saveDb(db);
      return json({ staples: db.staples });
    }

    if (m === "POST" && path === "/api/transcribe") {
      if (!DASHSCOPE_API_KEY) return bad("还没配置语音识别", 501);
      const ct = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!ct.startsWith("audio/") && ct !== "video/mp4") return bad("请上传录音");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length < 500) return bad("没录到声音");
      if (bytes.length > 6 * 1024 * 1024) return bad("录音太长了");
      try { return json({ text: await qwenTranscribe(bytes, ct) }); }
      catch (e) { return e instanceof NoSpeech ? bad("没听清，请靠近手机再说一次", 422) : bad("语音识别服务出错了，请再试一次", 502); }
    }

    if (m === "POST" && path === "/api/ingredients") {
      if (!DASHSCOPE_API_KEY) return bad("还没配置 AI", 501);
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 30);
      if (!name) return bad("菜名不能为空");
      try { return json({ items: await qwenIngredients(name) }); }
      catch { return bad("AI 服务出错了，请再试一次", 502); }
    }

    return bad("没有这个地址", 404);
  } catch (e) {
    console.error(e);
    return bad("服务器出错了，请稍后再试", 500);
  }
});
