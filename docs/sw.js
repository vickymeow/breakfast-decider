// 只管手机通知：收到推送就弹一条，点一下打开（或切回）「吃什么」。不缓存任何东西。
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var d={}; try{ d=e.data?e.data.json():{}; }catch(err){ d={body:e.data?e.data.text():''}; }
  e.waitUntil(self.registration.showNotification(d.title||'吃什么', {
    body:d.body||'家里有新动态，打开看看', icon:'icon.png', badge:'icon.png', tag:d.tag||'breakfast', renotify:true,
    data:{url:new URL(d.url||'./', self.registration.scope).href}
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||self.registration.scope;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){ if(list[i].url.indexOf(self.registration.scope)===0&&'focus' in list[i]){ return list[i].focus(); } }
    return self.clients.openWindow(url);
  }));
});
