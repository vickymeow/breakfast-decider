// 早饭决定器后端 + 网页托管：Supabase Edge Function（Deno）
// 同一个地址既返回网页，也提供接口；数据在 breakfast_state 表的一行 JSON 里，照片在 breakfast 存储桶。
//   GET  <base>/                      -> 网页
//   GET  <base>/manifest.webmanifest  -> 添加到主屏幕用
//   GET  <base>/icon.png
//   GET  <base>/api/state             -> { dishes, pick, pickDate }
//   POST <base>/api/pick   {type, date}     type: 菜名 | "random" | "skip"
//   POST <base>/api/dishes {name}
//   DELETE <base>/api/dishes/:id
//   POST <base>/api/dishes/:id/move  {direction: "up" | "down"}
//   POST <base>/api/dishes/:id/photo （请求体就是图片）
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { HTML, ICON_PNG_B64 } from "./assets.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const TABLE = "breakfast_state";
const BUCKET = "breakfast";
const ROW_ID = 1;
const FUNCTION_NAME = "breakfast";
const TZ = Deno.env.get("BREAKFAST_TZ") || "Asia/Shanghai";

type Dish = { id: number; name: string; emoji?: string; image?: string };
type Pick = { type: "dish" | "random" | "skip"; dish: number | null; resolvedName: string | null };
type Db = { dishes: Dish[]; pick: Pick | null; pickDate: string | null };

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function b64ToBytes(b64: string) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const ICON = b64ToBytes(ICON_PNG_B64);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/" + FUNCTION_NAME);
  let path = i >= 0 ? url.pathname.slice(i + FUNCTION_NAME.length + 1) : url.pathname;
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "") || "/";
  const m = req.method;

  try {
    // ---- 静态 ----
    if (m === "GET" && path === "/") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (m === "GET" && path === "/icon.png") {
      return new Response(ICON, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
    }
    if (m === "GET" && path === "/manifest.webmanifest") {
      const manifest = {
        name: "早饭", short_name: "早饭", lang: "zh-CN", start_url: "./", scope: "./", display: "standalone",
        background_color: "#fff8e7", theme_color: "#ffcf4d",
        icons: [{ src: "./icon.png", sizes: "192x192", type: "image/png", purpose: "any" }],
      };
      return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }

    // ---- 接口 ----
    if (m === "GET" && path === "/api/state") {
      const db = await loadDb();
      return json({ dishes: db.dishes, pick: db.pick, pickDate: db.pickDate, targetDate: targetDate() });
    }

    if (m === "POST" && path === "/api/pick") {
      const body = await req.json().catch(() => ({}));
      const type = String(body.type || "");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : targetDate();
      const db = await loadDb();
      if (type === "skip") db.pick = { type: "skip", dish: null, resolvedName: null };
      else if (type === "random") {
        if (!db.dishes.length) return bad("菜单是空的");
        const dish = db.dishes[Math.floor(Math.random() * db.dishes.length)];
        db.pick = { type: "random", dish: dish.id, resolvedName: dish.name };
      } else {
        const dish = db.dishes.find((d) => d.name === type);
        if (!dish) return bad("没有这道菜");
        db.pick = { type: "dish", dish: dish.id, resolvedName: dish.name };
      }
      db.pickDate = date;
      await saveDb(db);
      return json({ pick: db.pick, pickDate: db.pickDate });
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

    const dishRoute = path.match(/^\/api\/dishes\/(\d+)(?:\/(move|photo))?$/);
    if (dishRoute) {
      const id = Number(dishRoute[1]); const sub = dishRoute[2];
      const db = await loadDb();
      const idx = db.dishes.findIndex((d) => d.id === id);
      if (idx < 0) return bad("找不到这道菜", 404);

      if (m === "DELETE" && !sub) {
        const [gone] = db.dishes.splice(idx, 1);
        if (db.pick && db.pick.dish === id) { db.pick = null; db.pickDate = null; }
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
