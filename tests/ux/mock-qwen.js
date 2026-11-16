// 假的百炼对话接口：按提示词认出是哪种请求，给固定的回答（只用于本地测试）
const http = require('http');
function datesFrom(sys){ const m={}; for (const x of sys.matchAll(/(\d{4}-\d{2}-\d{2})（([^）]*)）/g)) { const w=x[2].match(/周([一二三四五六日])/); if(w) m[w[1]]=x[1]; if(/今晚/.test(x[2])) m.tonight=x[1]; } return m; }
http.createServer((req,res)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
  const j=JSON.parse(b||'{}'); const sys=(j.messages||[])[0]?.content||''; const user=(j.messages||[]).slice(-1)[0]?.content||'';
  let out={};
  if (/拆成要做的事/.test(sys)) {
    const d=datesFrom(sys); const acts=[];
    if (/星期三做鱼/.test(user)) acts.push({type:'plan',date:d['三'],dish:'鱼',generic:true});
    if (/礼拜五包饺子/.test(user)) acts.push({type:'plan',date:d['五'],dish:'饺子',generic:false});
    if (/做清蒸鲈鱼/.test(user)) acts.push({type:'plan',date:d['三'],dish:'清蒸鲈鱼',generic:false});
    if (/明天做小炒肉/.test(user)) { acts.push({type:'plan',date:d['一'],dish:'小炒肉',generic:false}); }
    if (/买点葱姜/.test(user)) acts.push({type:'buy',items:[{name:'葱',note:''},{name:'姜',note:''}]});
    if (/鸡蛋买两盒/.test(user)) acts.push({type:'buy',items:[{name:'鸡蛋',note:'两盒'}]});
    if (/丝瓜汤.*做不了/.test(user)) acts.push({type:'decline',dish:'丝瓜汤',reason:'没丝瓜了'});
    if (/酸辣鸡胗.*做不了/.test(user)) acts.push({type:'decline',dish:'酸辣鸡胗',reason:''});
    if (/鸡蛋买到了/.test(user)) acts.push({type:'bought',items:[{name:'鸡蛋'}]});
    if (/葱家里有/.test(user)) acts.push({type:'have',items:[{name:'葱'}]});
    if (/几个人回来/.test(user)) acts.push({type:'ask',what:'home'});
    if (/有什么鱼|鱼有什么做法/.test(user)) acts.push({type:'ideas',query:'鱼'});
    if (/更正/.test(user) && /周四/.test(user)) { acts.length=0; acts.push({type:'plan',date:d['四'],dish:'鱼',generic:true}); }
    if (/我不吃了/.test(user)) acts.push({type:'unclear',text:'我不吃了'});
    out={actions:acts};
  } else if (/推荐/.test(sys) && /做法/.test(sys)) {
    const q=(sys.match(/用「(.+?)」做的/)||[])[1];
    out={items: q ? [
      {name:'红烧鱼块',ingredients:['草鱼','姜','香葱'],steps:['鱼切块，用盐和料酒腌 10 分钟','热油，鱼块两面煎黄','下姜片葱段炒香','加生抽老抽糖和热水，小火炖 15 分钟','大火收汁，撒葱花']},
      {name:'酸菜鱼',ingredients:['黑鱼片','酸菜','泡椒'],steps:['鱼片用蛋清淀粉抓匀','酸菜炒香加水煮开','下鱼片煮 2 分钟','浇热油泼辣椒']},
      {name:'香煎三文鱼',ingredients:['三文鱼','柠檬'],steps:['三文鱼擦干撒盐','中火每面煎 3 分钟','挤柠檬汁']}]
      : [{name:'西兰花炒牛肉',ingredients:['牛里脊','西兰花','蚝油'],steps:['牛肉切片腌 10 分钟','西兰花焯水','大火炒牛肉，下西兰花，加蚝油']},{name:'冬瓜排骨汤',ingredients:['冬瓜','排骨'],steps:['排骨焯水','加水炖 40 分钟','下冬瓜再炖 15 分钟']}]};
  } else if (/食材|列出在家做这道菜/.test(sys)) {
    const name=user; out={items: /饺子/.test(name)?['饺子皮','猪肉馅','韭菜']:/小炒肉/.test(name)?['五花肉','青椒']:['食材甲','食材乙']};
  }
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]}));
}); }).listen(8790,()=>console.log('mock qwen on 8790'));
