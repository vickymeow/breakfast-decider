// 早饭决定器后端：Supabase Edge Function（Deno），只提供接口。
// 网页在 docs/ 里，由 GitHub Pages 托管（Supabase 的 *.supabase.co 域名不允许云函数返回 HTML 页面）。
// 数据在 breakfast_state 表的一行 JSON 里，照片在 breakfast 存储桶。
//   GET  <base>/api/state?date=YYYY-MM-DD&hour=H -> { dishes, pick, pickDate, targetDate, voice }
//        date/hour 是手机的本地日期和钟点：当天早上 6 点后还没人选，就自动随机定一样（AUTO_PICK_HOUR 可改）
//   POST <base>/api/pick   {type, date}     type: "dishes"（配 ids 数组，可多选）| 菜名 | "random" | "skip"
//   POST <base>/api/transcribe （请求体是录音，需配置 OPENAI_API_KEY 才开）
//   POST <base>/api/dinner/reply {who, home, wish, date}   家里人表态：回不回来吃、想吃什么
//   POST <base>/api/dinner/cook  {text, date}              妈妈回复：今晚做什么
//   POST <base>/api/dishes {name}
//   DELETE <base>/api/dishes/:id
//   POST <base>/api/dishes/:id/move  {direction: "up" | "down"}
//   POST <base>/api/dishes/:id/photo （请求体就是图片）
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
// 允许哪个网页来调接口：默认任何来源；想收紧就设置环境变量 ALLOWED_ORIGIN，比如 https://xxx.github.io
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
// 当天到了这个钟点还没人选，就自动随机定一样；只在下午 3 点前生效（3 点后页面已经在选明天）
const AUTO_PICK_HOUR = Number(Deno.env.get("AUTO_PICK_HOUR") || "6");
// 录音转文字（给微信等没有浏览器语音识别的环境用）：在 Supabase 后台 Edge Functions → Secrets 里配置 OPENAI_API_KEY 即开启
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const TRANSCRIBE_MODEL = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-mini-transcribe";

type Dish = { id: number; name: string; emoji?: string; image?: string };
// dishes：选中的菜（可多选）；dish 保留第一道，兼容旧数据
type Pick = { type: "dish" | "random" | "skip"; dish: number | null; dishes?: number[]; resolvedName: string | null; auto?: boolean };
type DinnerReply = { home: boolean | null; wish: string; at: string };
// 晚饭：按天一份；replies 按成员 id；cook 是妈妈的回复；wishes 是最近说过的菜（给快捷按钮用）
type Dinner = { date: string; replies: Record<string, DinnerReply>; cook: { text: string; at: string } | null; wishes: string[] };
type Db = { dishes: Dish[]; pick: Pick | null; pickDate: string | null; dinner?: Dinner };
const MEMBERS = ["kid", "jim"]; // 会对晚饭表态的人（妈妈是 mom，负责回复）

const SEED: Db = {
  dishes: [
    { id: 1, name: "乌冬面", emoji: "🍜" }, { id: 2, name: "炒荞麦面", emoji: "🍝" },
    { id: 3, name: "馄饨", emoji: "🥟" }, { id: 4, name: "蒸饺", emoji: "🥟" },
    { id: 5, name: "煎饺", emoji: "🥟" }, { id: 6, name: "炒饭", emoji: "🍚" },
    { id: 7, name: "吐司", emoji: "🍞" }, { id: 8, name: "鸡蛋", emoji: "🥚" },
  ],
  pick: null, pickDate: null,
};
const EMOJI_RULES: [string, string][] = [
  ["三明治","🥪"],["汉堡","🍔"],["吐司","🍞"],["面包","🍞"],["馒头","🍞"],["花卷","🍞"],["馄饨","🥟"],["云吞","🥟"],["饺","🥟"],["包子","🥟"],["小笼","🥟"],["烧卖","🥟"],
  ["炒饭","🍚"],["米饭","🍚"],["饭团","🍙"],["粥","🥣"],["麦片","🥣"],["燕麦","🥣"],["意面","🍝"],["荞麦","🍝"],["面","🍜"],["粉","🍜"],["蛋","🥚"],["煎饼","🥞"],["饼","🥞"],
  ["华夫","🧇"],["牛奶","🥛"],["豆浆","🥛"],["酸奶","🥛"],["油条","🥖"],["香蕉","🍌"],["苹果","🍎"],["水果","🍎"],["汤","🍲"],["火腿","🥓"],["培根","🥓"],["香肠","🌭"],["红薯","🍠"],["玉米","🌽"],
];
const emojiFor = (name: string) => (EMOJI_RULES.find(([k]) => name.includes(k)) || [, "🍽️"])[1]!;

// ---- 数据读写 ----
async function loadDb(): Promise<Db> {
  const { data, error } = await supabase.from(TABLE).select("data").eq("id", ROW_ID).maybeSingle();
  if (error) throw error;
  if (!data) { await saveDb(SEED); return structuredClone(SEED); }
  const db = data.data as Db;
  if (!Array.isArray(db.dishes)) db.dishes = [];
  return db;
}
// 拿到某一天的晚饭记录；换了天就开一份新的，只保留“最近说过的菜”
function dinnerFor(db: Db, date: string): { dinner: Dinner; changed: boolean } {
  const cur = db.dinner;
  if (cur && cur.date === date) return { dinner: cur, changed: false };
  db.dinner = { date, replies: {}, cook: null, wishes: Array.isArray(cur?.wishes) ? cur!.wishes : [] };
  return { dinner: db.dinner, changed: true };
}
function rememberWish(dinner: Dinner, text: string) {
  const t = text.trim(); if (!t || t === "随便") return;
  dinner.wishes = [t, ...dinner.wishes.filter((w) => w !== t)].slice(0, 12);
}
async function saveDb(db: Db) {
  const { error } = await supabase.from(TABLE).upsert({ id: ROW_ID, data: db, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// 没带日期时的兜底：按 TZ 算，下午 3 点后选的是明天
function targetDate(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = Number(get("hour")) % 24;
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  if (hour >= 15) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 当天 6 点后还没选：随机定一样。返回是否改了
function autoPickIfDue(db: Db, date: string, hour: number): boolean {
  if (!(hour >= AUTO_PICK_HOUR && hour < 15)) return false;
  if (db.pick && db.pickDate === date) return false;
  if (!db.dishes.length) return false;
  const dish = db.dishes[Math.floor(Math.random() * db.dishes.length)];
  db.pick = { type: "random", dish: dish.id, dishes: [dish.id], resolvedName: dish.name, auto: true };
  db.pickDate = date;
  return true;
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/" + FUNCTION_NAME);
  let path = i >= 0 ? url.pathname.slice(i + FUNCTION_NAME.length + 1) : url.pathname;
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (m === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  try {
    if (m === "GET" && path === "/") {
      return json({ ok: true, hint: "这是早饭决定器的接口；网页请打开 GitHub Pages 的地址。" });
    }

    if (m === "GET" && path === "/api/state") {
      const db = await loadDb();
      const qDate = url.searchParams.get("date") || "";
      const qHour = Number(url.searchParams.get("hour"));
      let changed = false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(qDate) && Number.isInteger(qHour) && qHour >= 0 && qHour <= 23) {
        changed = autoPickIfDue(db, qDate, qHour) || changed;
      }
      const dDate = url.searchParams.get("ddate") || "";
      let dinner: Dinner | null = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dDate)) { const r = dinnerFor(db, dDate); dinner = r.dinner; changed = r.changed || changed; }
      else dinner = db.dinner || null;
      if (changed) await saveDb(db);
      return json({ dishes: db.dishes, pick: db.pick, pickDate: db.pickDate, targetDate: targetDate(), voice: !!OPENAI_API_KEY, autoPickHour: AUTO_PICK_HOUR, dinner });
    }

    if (m === "POST" && path === "/api/pick") {
      const body = await req.json().catch(() => ({}));
      const type = String(body.type || "");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : targetDate();
      const db = await loadDb();
      if (type === "skip") db.pick = { type: "skip", dish: null, dishes: [], resolvedName: null };
      else if (type === "random") {
        if (!db.dishes.length) return bad("菜单是空的");
        const dish = db.dishes[Math.floor(Math.random() * db.dishes.length)];
        db.pick = { type: "random", dish: dish.id, dishes: [dish.id], resolvedName: dish.name };
      } else if (type === "dishes") {
        // 多选：按点选顺序保存，去重，忽略不存在的菜；一个都没选 = 清空选择
        const wanted: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
        const picked = wanted.filter((id, k) => wanted.indexOf(id) === k).map((id) => db.dishes.find((d) => d.id === id)).filter((d): d is Dish => !!d);
        if (!picked.length) { db.pick = null; db.pickDate = null; await saveDb(db); return json({ pick: null, pickDate: null }); }
        db.pick = { type: "dish", dish: picked[0].id, dishes: picked.map((d) => d.id), resolvedName: picked.map((d) => d.name).join("＋") };
      } else {
        const dish = db.dishes.find((d) => d.name === type);
        if (!dish) return bad("没有这道菜");
        db.pick = { type: "dish", dish: dish.id, dishes: [dish.id], resolvedName: dish.name };
      }
      db.pickDate = date;
      await saveDb(db);
      return json({ pick: db.pick, pickDate: db.pickDate });
    }

    if (m === "POST" && path === "/api/dinner/reply") {
      const body = await req.json().catch(() => ({}));
      const who = String(body.who || "");
      if (!MEMBERS.includes(who)) return bad("不认识这个人");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const home = body.home === true ? true : body.home === false ? false : null;
      const wish = String(body.wish || "").trim().slice(0, 40);
      const db = await loadDb();
      const { dinner } = dinnerFor(db, date);
      const prev = dinner.replies[who];
      dinner.replies[who] = { home: home === null && prev ? prev.home : home, wish: body.wish === undefined && prev ? prev.wish : wish, at: new Date().toISOString() };
      rememberWish(dinner, dinner.replies[who].wish);
      await saveDb(db);
      return json({ dinner });
    }

    if (m === "POST" && path === "/api/dinner/cook") {
      const body = await req.json().catch(() => ({}));
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : "";
      if (!date) return bad("缺日期");
      const text = String(body.text || "").trim().slice(0, 60);
      const db = await loadDb();
      const { dinner } = dinnerFor(db, date);
      dinner.cook = text ? { text, at: new Date().toISOString() } : null;
      if (text) rememberWish(dinner, text);
      await saveDb(db);
      return json({ dinner });
    }

    if (m === "POST" && path === "/api/dishes") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 30);
      if (!name) return bad("菜名不能为空");
      const db = await loadDb();
      if (db.dishes.length >= 60) return bad("菜太多啦，先删几道");
      if (db.dishes.some((d) => d.name === name)) return bad("已经有这道菜了");
      const dish: Dish = { id: Date.now(), name, emoji: emojiFor(name) };
      db.dishes.push(dish);
      await saveDb(db);
      return json(dish);
    }

    if (m === "POST" && path === "/api/transcribe") {
      if (!OPENAI_API_KEY) return bad("还没配置语音识别", 501);
      const ct = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!ct.startsWith("audio/") && ct !== "video/mp4") return bad("请上传录音");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length < 500) return bad("没录到声音");
      if (bytes.length > 4 * 1024 * 1024) return bad("录音太长了");
      const ext = ct.includes("webm") ? "webm" : ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : ct.includes("mpeg") ? "mp3" : "mp4";
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: ct }), `voice.${ext}`);
      form.append("model", TRANSCRIBE_MODEL);
      form.append("language", "zh");
      form.append("prompt", "早饭菜名，例如：馄饨、鸡蛋三明治、小笼包、豆浆油条");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
      if (!r.ok) { console.error("transcribe failed", r.status, await r.text()); return bad("语音识别服务出错了，请再试一次", 502); }
      const out = await r.json();
      return json({ text: String(out.text || "").trim() });
    }

    const dishRoute = path.match(/^\/api\/dishes\/(\d+)(?:\/(move|photo))?$/);
    if (dishRoute) {
      const id = Number(dishRoute[1]); const sub = dishRoute[2];
      const db = await loadDb();
      const idx = db.dishes.findIndex((d) => d.id === id);
      if (idx < 0) return bad("找不到这道菜", 404);

      if (m === "DELETE" && !sub) {
        const [gone] = db.dishes.splice(idx, 1);
        // 删的是选中的菜：从选择里去掉；一个不剩就清空
        if (db.pick && db.pick.type !== "skip") {
          const rest = (db.pick.dishes || (db.pick.dish != null ? [db.pick.dish] : [])).filter((x) => x !== id);
          if (!rest.length) { db.pick = null; db.pickDate = null; }
          else db.pick = { ...db.pick, dish: rest[0], dishes: rest, resolvedName: rest.map((x) => db.dishes.find((d) => d.id === x)?.name || "").filter(Boolean).join("＋") };
        }
        await saveDb(db);
        if (gone.image) await supabase.storage.from(BUCKET).remove([`${id}.jpg`]).catch(() => {});
        return json({ ok: true });
      }
      if (m === "POST" && sub === "move") {
        const body = await req.json().catch(() => ({}));
        const j = body.direction === "up" ? idx - 1 : idx + 1;
        if (j >= 0 && j < db.dishes.length) {
          [db.dishes[idx], db.dishes[j]] = [db.dishes[j], db.dishes[idx]];
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
        db.dishes[idx].image = `${pub.publicUrl}?v=${Date.now()}`;
        await saveDb(db);
        return json(db.dishes[idx]);
      }
    }
    return bad("没有这个地址", 404);
  } catch (e) {
    console.error(e);
    return bad("服务器出错了，请稍后再试", 500);
  }
});
