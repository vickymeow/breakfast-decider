// 早饭决定器后端：Supabase Edge Function（Deno），只提供接口；网页在 docs/ 由 GitHub Pages 托管。
// 数据全部在 breakfast_state 表的一行 JSON 里（见 Db 类型），照片在 breakfast 存储桶。
// 语音识别与食材建议用阿里云百炼的 Qwen（OpenAI 兼容接口），配置 DASHSCOPE_API_KEY 即开启。
//
//   GET  /api/state?date&hour&ddate     全部状态；顺带做：6 点自动随机早饭、过期晚饭计划结算
//   POST /api/pick        {type, ids, date}          早饭选择（多选）
//   POST /api/dishes      {name, cat, ingredients, mom, by}   加菜（菜库）
//   POST /api/dishes/:id/update {name?, cat?, mom?, ingredients?}
//   POST /api/dishes/:id/move   {direction}          上下挪一格（旧网页用）
//   POST /api/dishes/reorder    {cat, ids}           菜单排序（拖动后整栏的新顺序）
//   POST /api/dishes/:id/photo  （请求体是图片）
//   DELETE /api/dishes/:id
//   POST /api/wishes      {dishId | name, who, hb?}   点菜进心愿单（hb = 红包金额，只是记一笔，钱自己在微信发）
//   POST /api/wishes/:id/remove
//   POST /api/wishes/:id/update {hb?, hbPaid?}
//   POST /api/profile/:who/photo （请求体是图片）     头像
//   POST /api/feedback    {who, text}                 提意见（存在 feedback 里，不随 state 下发）
//   POST /api/suggest     {cat}                       Qwen 推荐几道菜单里没有的新菜
//   POST /api/dinner/reply {who, home, date}          回不回来吃
//   POST /api/dinner/cook  {date, dishIds, text}      妈妈定今晚/明晚做什么（空 = 取消）
//   POST /api/shopping    {op:"add", names:[], from?} | {op:"toggle"|"remove", id} | {op:"clear_done"} | {op:"ordered"}   买菜清单（全家共用）
//   POST /api/staples     {op:"add", names:[]} | {op:"remove", name}   常买（家里人自己加、自己删）
//   POST /api/transcribe  （请求体是录音）           Qwen 语音转文字
//   POST /api/ingredients {name}                      Qwen 给出食材清单
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
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
};
type Pick = { type: "dish" | "random" | "skip"; dish: number | null; dishes?: number[]; resolvedName: string | null; auto?: boolean };
type Reply = { home: boolean | null; at: string };
type Plan = { date: string; replies: Record<string, Reply>; cook: { dishIds: number[]; text: string; at: string } | null; done?: boolean };
type Wish = { id: number; dishId: number; who: string; at: string; status: "open" | "planned" | "done"; plannedFor?: string; doneAt?: string; hb?: number; hbPaid?: boolean };
type Feedback = { id: number; who: string; text: string; at: string; done?: boolean };
type ShopItem = { id: number; name: string; done: boolean; from?: string; at: string; doneAt?: string };
type Db = { v: number; dishes: Dish[]; pick: Pick | null; pickDate: string | null; plans: Record<string, Plan>; wishes: Wish[]; shopping: ShopItem[]; shopHistory: Record<string, number>; profiles: Record<string, { avatar?: string }>; feedback: Feedback[]; orderV?: number; staples?: string[] };
const MEMBERS = ["kid", "jim"];
const PEOPLE = ["mom", "kid", "jim"];
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
// 过了的计划结算：菜记一次“做过”，心愿变“做过了”；清掉太老的计划和心愿
function settle(db: Db, today: string): boolean {
  let changed = false;
  for (const p of Object.values(db.plans)) {
    if (p.done || p.date >= today) continue;
    if (p.cook) for (const id of p.cook.dishIds) {
      const d = db.dishes.find((x) => x.id === id); if (d) { d.times = (d.times || 0) + 1; d.lastMade = p.date; }
      for (const w of db.wishes) if (w.status !== "done" && w.dishId === id) { w.status = "done"; w.doneAt = p.date; }
    }
    p.done = true; changed = true;
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
function targetDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  if (Number(get("hour")) % 24 >= 15) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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

async function qwenSuggest(cat: Cat, have: string[]): Promise<{ name: string; ingredients: string[] }[]> {
  const kind = cat === "breakfast" ? "早饭" : "家常正餐（午饭晚饭的菜）";
  const sys = `你是中餐家常菜助手，给一家人推荐新菜。推荐 6 道适合在家做的${kind}，要求：菜单里已经有的不要推荐；做法不复杂；食材在美国的华人超市买得到；荤素搭配，口味别都一样。每道菜附上要买的主要食材（不含盐糖油生抽葱姜蒜这类基础调料），每项 2 到 6 个字，3 到 8 项。菜名 2 到 8 个字。只返回 JSON：{"items":[{"name":"菜名","ingredients":["..."]}]}`;
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
  const out: { name: string; ingredients: string[] }[] = [];
  for (const x of (Array.isArray(items) ? items : [])) {
    // deno-lint-ignore no-explicit-any
    const o = x as any; const name = String((o && o.name) || (typeof o === "string" ? o : "")).trim().slice(0, 30);
    if (!name || have.includes(name) || out.some((y) => y.name === name)) continue;
    out.push({ name, ingredients: cleanList(o && o.ingredients).filter((y) => y.length <= 12).slice(0, 10) });
  }
  return out.slice(0, 8);
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
    if (m === "GET" && path === "/") return json({ ok: true, hint: "这是早饭决定器的接口；网页请打开 GitHub Pages 的地址。", qwenKey: DASHSCOPE_API_KEY ? "已配置" : "没有读到 DASHSCOPE_API_KEY", tokenPlan: IS_TOKEN_PLAN, qwenBase: DASHSCOPE_BASE_URL, asrBase: ASR_BASE_URL, asrModel: QWEN_ASR_MODEL, chatModel: QWEN_CHAT_MODEL });

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

    if (m === "GET" && path === "/api/state") {
      let { db, changed } = await loadDb();
      const qDate = url.searchParams.get("date") || "";
      const qHour = Number(url.searchParams.get("hour"));
      const dDate = url.searchParams.get("ddate") || "";
      if (DATE_RE.test(qDate)) {
        changed = settle(db, qDate) || changed;
        if (Number.isInteger(qHour) && qHour >= 0 && qHour <= 23) changed = autoPickIfDue(db, qDate, qHour) || changed;
      }
      if (DATE_RE.test(dDate)) { if (!db.plans[dDate]) { planFor(db, dDate); changed = true; } }
      syncWishes(db);
      if (changed) await saveDb(db);
      const dayPlan = (n: number): Plan => db.plans[addDays(dDate, n)] || { date: addDays(dDate, n), replies: {}, cook: null };
      // today / tomorrow 留给还没刷新的旧网页；新网页用 days（今晚、明晚、后天）
      const plans = DATE_RE.test(dDate) ? { today: db.plans[dDate], tomorrow: dayPlan(1), days: [db.plans[dDate], dayPlan(1), dayPlan(2)] } : {};
      // 常买：家里人自己加的；recent 是最近买得多的，改常买时可以一点就加
      const staples = db.staples || [];
      const recent = Object.entries(db.shopHistory).sort((a, b) => b[1] - a[1]).map(([n]) => n).filter((n) => !staples.includes(n)).slice(0, 16);
      // frequent 留给还没刷新的旧网页
      return json({ dishes: db.dishes, pick: db.pick, pickDate: db.pickDate, targetDate: targetDate(), wishes: db.wishes, plans, shopping: db.shopping, staples, recent, frequent: staples, profiles: db.profiles, voice: !!DASHSCOPE_API_KEY, ai: !!DASHSCOPE_API_KEY, autoPickHour: AUTO_PICK_HOUR });
    }

    if (m === "POST" && path === "/api/pick") {
      const body = await req.json().catch(() => ({}));
      const type = String(body.type || "");
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : targetDate();
      const { db } = await loadDb();
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
      await saveDb(db);
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
      if (dup) { if (hb !== undefined) dup.hb = hb || undefined; }
      else db.wishes.push({ id: Date.now(), dishId: dish.id, who, at: nowIso(), status: "open", hb: hb || undefined });
      syncWishes(db);
      await saveDb(db);
      return json({ wishes: db.wishes, dish });
    }
    const wishRoute = path.match(/^\/api\/wishes\/(\d+)\/(remove|update)$/);
    if (wishRoute && m === "POST") {
      const id = Number(wishRoute[1]);
      const { db } = await loadDb();
      if (wishRoute[2] === "remove") db.wishes = db.wishes.filter((w) => w.id !== id);
      else {
        const body = await req.json().catch(() => ({}));
        const w = db.wishes.find((x) => x.id === id);
        if (!w) return bad("找不到这个心愿", 404);
        if (body.hb !== undefined) w.hb = cleanHb(body.hb) || undefined;
        if (typeof body.hbPaid === "boolean") w.hbPaid = body.hbPaid || undefined;
      }
      await saveDb(db);
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

    if (m === "POST" && path === "/api/suggest") {
      if (!DASHSCOPE_API_KEY) return bad("还没配置 AI", 501);
      const body = await req.json().catch(() => ({}));
      const cat: Cat = body.cat === "breakfast" ? "breakfast" : "dinner";
      const { db } = await loadDb();
      try { return json({ items: await qwenSuggest(cat, db.dishes.map((d) => d.name)) }); }
      catch { return bad("AI 服务出错了，请再试一次", 502); }
    }

    if (m === "POST" && path === "/api/dinner/reply") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!MEMBERS.includes(who)) return bad("不认识这个人");
      const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const { db } = await loadDb();
      const plan = planFor(db, date);
      plan.replies[who] = { home: body.home === true ? true : body.home === false ? false : null, at: nowIso() };
      await saveDb(db);
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
      plan.cook = ids.length || text ? { dishIds: ids, text, at: nowIso() } : null;
      syncWishes(db);
      await saveDb(db);
      return json({ plan, wishes: db.wishes });
    }

    if (m === "POST" && path === "/api/shopping") {
      const body = await req.json().catch(() => ({}));
      const op = String(body.op || "");
      const { db } = await loadDb();
      if (op === "add") {
        const names = cleanList(body.names);
        if (!names.length) return bad("没有要加的东西");
        const from = typeof body.from === "string" ? body.from.slice(0, 30) : "";
        for (const n of names) {
          const open = db.shopping.find((it) => it.name === n && !it.done);
          if (open) continue;
          if (db.shopping.length >= 150) return bad("清单太长了，先清一下已买的");
          db.shopping.push({ id: Date.now() + Math.floor(Math.random() * 1000), name: n, done: false, from: from || undefined, at: nowIso() });
          db.shopHistory[n] = (db.shopHistory[n] || 0) + 1;
        }
        const keys = Object.keys(db.shopHistory);
        if (keys.length > 60) for (const k of keys.sort((a, b) => db.shopHistory[a] - db.shopHistory[b]).slice(0, keys.length - 60)) delete db.shopHistory[k];
      } else if (op === "toggle" || op === "remove") {
        const id = Number(body.id);
        const it = db.shopping.find((x) => x.id === id);
        if (!it) return bad("清单里没有这一项", 404);
        if (op === "remove") db.shopping = db.shopping.filter((x) => x.id !== id);
        else { it.done = !it.done; it.doneAt = it.done ? nowIso() : undefined; }
      } else if (op === "clear_done") {
        db.shopping = db.shopping.filter((x) => !x.done);
      } else if (op === "ordered") {
        // 已下单：全部算买到并清空（常买记录在加入时已记过）
        db.shopping = [];
      } else return bad("不认识的操作");
      await saveDb(db);
      return json({ shopping: db.shopping });
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
