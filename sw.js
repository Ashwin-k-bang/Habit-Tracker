/* Habits service worker: network first, cached copy only when offline. Data (data/*) and the GitHub API are never cached.
   Only caches starting with "habits-" are touched, so other apps on the same github.io domain are left alone. */
const V='habits-v1';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.startsWith('habits-')&&x!==V).map(x=>caches.delete(x)))).then(()=>clients.claim())));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.includes('/data/'))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok){const c=r.clone();caches.open(V).then(x=>x.put(e.request,c))}return r})
    .catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
