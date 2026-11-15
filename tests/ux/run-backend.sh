#!/bin/bash
# 用法：run-backend.sh <源码目录> <端口> [fixture]   源码复制一份，只改监听端口
H=$(cd "$(dirname "$0")" && pwd)
SRC=$1; PORT=${2:-8787}; FIX=${3:-$H/fixture.json}
W=$H/src-$PORT; rm -rf "$W"; cp -r "$SRC" "$W"
sed -i 's/^Deno.serve(async/Deno.serve({ port: '"$PORT"' }, async/' "$W/index.ts"
DB=$H/db-$PORT.json; cp "$FIX" "$DB"
cd "$H"
SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x DB_FILE=$DB DENO_DIR=$H/.deno \
  exec ./node_modules/.bin/deno run --quiet --no-lock --import-map=$H/import_map.json --allow-net --allow-env --allow-read --allow-write "$W/index.ts"
