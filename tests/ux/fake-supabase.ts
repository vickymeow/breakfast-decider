// 本地测试用：假的 Supabase 客户端。数据存在 DB_FILE（一行 JSON），图片不真传。
const FILE = Deno.env.get("DB_FILE") || "./db.json";
function read(): unknown { try { return JSON.parse(Deno.readTextFileSync(FILE)); } catch { return null; } }
export function createClient(_u: string, _k: string, _o?: unknown) {
  return {
    from(_t: string) {
      return {
        select(_c: string) { return { eq(_k: string, _v: unknown) { return { maybeSingle: async () => { const d = read(); return { data: d ? { data: d } : null, error: null }; } }; } }; },
        upsert: async (row: { data: unknown }) => { Deno.writeTextFileSync(FILE, JSON.stringify(row.data)); return { error: null }; },
      };
    },
    storage: { from(_b: string) { return { upload: async () => ({ error: null }), getPublicUrl: (k: string) => ({ data: { publicUrl: "http://localhost/" + k } }), remove: async () => ({}) }; } },
  };
}
