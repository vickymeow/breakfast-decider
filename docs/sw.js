// 只管手机通知：收到推送就弹一条，点一下打开（或切回）「吃什么」，并把通知的内容带给网页显示出来。不缓存任何东西。
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var d={}; try{ d=e.data?e.data.json():{}; }catch(err){ d={body:e.data?e.data.text():''}; }
  var body=d.body||'家里有新动态，打开看看';
  e.waitUntil(self.registration.showNotification(d.title||'吃什么', {
    body:body, icon:'icon.png', badge:'icon.png', tag:d.tag||'breakfast', renotify:true,
    data:{url:new URL(d.url||'./', self.registration.scope).href, body:body, title:d.title||''}
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var data=e.notification.data||{}, url=data.url||self.registration.scope;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){
      if(list[i].url.indexOf(self.registration.scope)===0&&'focus' in list[i]){
        try{ list[i].postMessage({type:'notice', title:data.title, body:data.body}); }catch(err){}
        return list[i].focus();
      }
    }
    // 网页没开着：打开时把内容放在地址后面，网页一打开就弹出来
    return self.clients.openWindow(url+(url.indexOf('#')<0?'#':'&')+'n='+encodeURIComponent(data.body||''));
  }));
});
