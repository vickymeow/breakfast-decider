// 把 web/index.html 和 web/icon.png 打进云函数，生成 supabase/functions/breakfast/assets.ts
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const icon = fs.readFileSync(path.join(root, 'web/icon.png')).toString('base64');
const out = `// 由 scripts/build.js 生成，不要手改；改 web/ 下的文件后重新运行 node scripts/build.js
export const HTML: string = ${JSON.stringify(html)};
export const ICON_PNG_B64: string = ${JSON.stringify(icon)};
`;
fs.writeFileSync(path.join(root, 'supabase/functions/breakfast/assets.ts'), out);
console.log('assets.ts written:', out.length, 'bytes');
