// 把 web/index.html 打进云函数：生成 supabase/functions/breakfast/page.ts
// 图标 web/icon.png 不进函数，部署时上传到 breakfast 存储桶（见 README）。
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
if (html.includes('`') || html.includes('${')) throw new Error('index.html 不能包含反引号或 ${');
const out = '// 由 scripts/build.js 生成，不要手改；改 web/index.html 后重新运行 node scripts/build.js\n'
  + 'export const HTML: string = String.raw`' + html + '`;\n';
fs.writeFileSync(path.join(root, 'supabase/functions/breakfast/page.ts'), out);
console.log('page.ts written:', out.length, 'bytes');
