/* ===== Habits: standalone habit tracker. Local storage (IndexedDB) + GitHub sync (data/habits.json) =====
   Records: habit {id,k:'h',name,c,u}   success {id:'d_<habit>_<date>',k:'d',h:habitId,d:'YYYY-MM-DD',u}   delete marker {id,del:true,u}
   Each record merges on its own (newest u wins), so two devices never lose a tick. */
const $=s=>document.querySelector(s), pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseD=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* one-link device setup: open  .../habits/#token=github_pat_xxx  once on a device */
(()=>{const m=location.hash.match(/^#token=([^&]+)/);if(!m)return;
  let o={};try{o=JSON.parse(localStorage.getItem('hb-sync')||'{}')}catch(e){}
  o.token=decodeURIComponent(m[1]).trim();localStorage.setItem('hb-sync',JSON.stringify(o));
  history.replaceState(null,'',location.pathname+location.search)})();

const HB=(()=>{
  let db,rev=0,etag=null,sha=null,remote=[],busy=false,again=false,kt=null,pt=null,st='off',msg='',last=0,pause=0;
  const dataL=[],statL=[],BC=window.BroadcastChannel?new BroadcastChannel('daylog-habits'):null;
  const tabs=()=>{try{BC&&BC.postMessage(1)}catch(e){}};
  const cfg=()=>{
    let s={};try{s=JSON.parse(localStorage.getItem('hb-sync')||'{}')}catch(e){}
    const m=location.hostname.match(/^([^.]+)\.github\.io$/);
    return{owner:s.owner||(m?m[1]:''),repo:s.repo||(m?(location.pathname.split('/')[1]||''):''),
      branch:s.branch||'',path:'data/habits.json',token:(s.token||'').trim()};
  };
  const save=o=>{localStorage.setItem('hb-sync',JSON.stringify(o));etag=null;sha=null;remote=[];pause=0;last=0};
  const set=(s,m)=>{st=s;msg=m||'';statL.forEach(f=>f(st,msg))};
  const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

  const open=()=>new Promise((res,rej)=>{const r=indexedDB.open('daylog-habits',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('items',{keyPath:'id'});
    r.onsuccess=()=>{db=r.result;res()};r.onerror=()=>rej(r.error)});
  const tx=(mode,f)=>new Promise((res,rej)=>{const t=db.transaction('items',mode);const o=f(t.objectStore('items'));t.oncomplete=()=>res(o&&o.result);t.onerror=()=>rej(t.error)});
  const allRaw=()=>tx('readonly',s=>s.getAll());
  const putRaw=l=>tx('readwrite',s=>{l.forEach(e=>s.put(e))});
  const putNewer=l=>new Promise((res,rej)=>{let n=0;const t=db.transaction('items','readwrite'),s=t.objectStore('items');
    l.forEach(e=>{const g=s.get(e.id);g.onsuccess=()=>{const o=g.result;if(!o||(e.u||0)>(o.u||0)){s.put(e);n++}}});
    t.oncomplete=()=>res(n>0);t.onerror=()=>rej(t.error)});
  const put=e=>{const r=putRaw([{...e,u:Date.now()}]);kick();tabs();return r};
  const del=ids=>{const n=Date.now();const r=putRaw([].concat(ids).map(id=>({id,del:true,u:n})));kick();tabs();return r};
  const mark=(h,d,s)=>s?put({id:'d_'+h+'_'+d,k:'d',h,d,...(s==='fail'?{f:1}:{})}):del('d_'+h+'_'+d);

  const note=(h,d,t)=>t?put({id:'n_'+h+'_'+d,k:'n',h,d,t}):del('n_'+h+'_'+d);

  /* returns {habits:[...], done:Set, fail:Set, notes:Map('habitId|YYYY-MM-DD' -> text)} */
  async function all(){
    const raw=(await allRaw()).filter(e=>!e.del);
    const habits=raw.filter(e=>e.k==='h').sort((a,b)=>(a.c||0)-(b.c||0)||(a.id<b.id?-1:1));
    const ids=new Set(habits.map(h=>h.id));
    const dd=raw.filter(e=>e.k==='d'&&ids.has(e.h));
    const done=new Set(dd.filter(e=>!e.f).map(e=>e.h+'|'+e.d)),fail=new Set(dd.filter(e=>e.f).map(e=>e.h+'|'+e.d));
    const notes=new Map(raw.filter(e=>e.k==='n'&&ids.has(e.h)&&e.t).map(e=>[e.h+'|'+e.d,e.t]));
    return{habits,done,fail,notes};
  }

  /* GitHub */
  const b64d=b=>new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g,'')),c=>c.charCodeAt(0)));
  const b64e=s=>{const u=new TextEncoder().encode(s);let o='';for(let i=0;i<u.length;i+=8192)o+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(o)};
  const url=c=>`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;
  const hdr=(c,x)=>({Accept:'application/vnd.github+json',...(c.token?{Authorization:'Bearer '+c.token}:{}),...x});
  const fail=r=>{
    const e=new Error(r.status===401?'GitHub rejected the token. Make a new one.':
      r.status===403?(r.headers.get('x-ratelimit-remaining')==='0'?(pause=(+r.headers.get('x-ratelimit-reset')||0)*1000||Date.now()+36e5,'GitHub rate limit reached. Retrying later.'):'Token lacks permission. It needs Contents: Read and write on this repo.'):
      r.status===404?'Repo or file not found (check owner and repo name, and that the token covers this repo).':
      r.status===409||r.status===422?'conflict':`GitHub error ${r.status}`);
    e.status=r.status;return e;
  };
  const nEnt=e=>e.del?{id:e.id,del:true,u:e.u||0}
    :e.k==='h'?{id:e.id,k:'h',name:e.name||'',c:e.c||0,u:e.u||0}
    :e.k==='n'?{id:e.id,k:'n',h:e.h,d:e.d,t:e.t||'',u:e.u||0}
    :{id:e.id,k:'d',h:e.h,d:e.d,...(e.f?{f:1}:{}),u:e.u||0};
  const ser=l=>'{\n"v":1,\n"items":[\n'+[...l].map(nEnt).sort((a,b)=>a.id<b.id?-1:1).map(e=>JSON.stringify(e)).join(',\n')+'\n]\n}\n';
  function parse(t){
    if(!t.trim())return[];
    let j;try{j=JSON.parse(t)}catch(e){throw new Error('data/habits.json is not valid JSON. Sync stopped so nothing gets overwritten.')}
    return Array.isArray(j.items)?j.items:[];
  }
  function merge(a,b){const m=new Map();a.forEach(e=>m.set(e.id,e));b.forEach(e=>{const o=m.get(e.id);if(!o||(e.u||0)>(o.u||0))m.set(e.id,e)});return[...m.values()]}
  async function pull(c){
    const q=c.branch?'?ref='+encodeURIComponent(c.branch):'';
    const r=await fetch(url(c)+q,{headers:hdr(c,etag?{'If-None-Match':etag}:{}),cache:'no-store'});
    if(r.status===304)return{same:true};
    if(r.status===404){etag=null;sha=null;return{doc:[]}}
    if(!r.ok)throw fail(r);
    const j=await r.json();etag=r.headers.get('ETag');sha=j.sha;
    let t=j.content?b64d(j.content):'';
    if(!j.content){const r2=await fetch(url(c)+q,{headers:hdr(c,{Accept:'application/vnd.github.raw+json'}),cache:'no-store'});if(!r2.ok)throw fail(r2);t=await r2.text()}
    return{doc:parse(t)};
  }
  async function push(c,list){
    const body={message:'Habits sync '+new Date().toISOString().slice(0,16).replace('T',' '),content:b64e(ser(list))};
    if(sha)body.sha=sha;if(c.branch)body.branch=c.branch;
    const r=await fetch(url(c),{method:'PUT',headers:hdr(c,{'Content-Type':'application/json'}),body:JSON.stringify(body)});
    if(r.status===409||r.status===422)return false;
    if(!r.ok)throw fail(r);
    sha=(await r.json()).content.sha;etag=null;return true;
  }
  async function run(force){
    const c=cfg();
    if(!c.owner||!c.repo){set('off','Sync is not set up.');return}
    if(!navigator.onLine){set('err','Offline. Changes are kept on this device and sync later.');return}
    if(force!==true){if(Date.now()<pause)return;if(!c.token&&Date.now()-last<60000)return}
    if(busy){again=true;return}
    last=Date.now();busy=true;set('busy');let changed=false;
    try{
      for(let i=0;i<4;i++){
        const r0=rev;
        const f=await pull(c);
        if(!f.same)remote=f.doc;
        const local=await allRaw();
        if(rev!==r0)continue;
        const merged=merge(remote,local);
        if(merged.length&&await putNewer(merged.map(nEnt)))changed=true;
        if(rev!==r0)continue;
        if(c.token&&ser(merged)!==ser(remote)){
          if(await push(c,merged)){remote=merged;break}
          etag=null;continue;
        }
        break;
      }
      set(c.token?'ok':'ro',c.token?'':'Read-only. Add a GitHub token to save from this device.');
    }catch(e){set('err',e.message||String(e))}
    finally{busy=false;if(changed){dataL.forEach(f=>f());tabs()}if(again){again=false;run()}}
  }
  function kick(){rev++;clearTimeout(kt);kt=setTimeout(()=>run(true),700)}
  function start(ms){
    run(true);clearInterval(pt);pt=setInterval(()=>{if(document.visibilityState==='visible')run()},ms||5000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')run()});
    addEventListener('online',()=>run(true));
  }
  if(BC)BC.onmessage=()=>dataL.forEach(f=>f());
  return{open,all,put,del,mark,note,uid,start,cfg,save,run:()=>run(true),on:f=>dataL.push(f),onStatus:f=>{statL.push(f);f(st,msg)},state:()=>({st,msg})};
})();

/* ===== shared habit logic ===== */
const today=()=>ymd(new Date());
/* current streak: consecutive done days ending today (or yesterday if today is not ticked yet) */
function streakOf(id,done){
  const d=new Date();if(!done.has(id+'|'+ymd(d)))d.setDate(d.getDate()-1);
  let n=0;while(done.has(id+'|'+ymd(d))){n++;d.setDate(d.getDate()-1)}return n;
}
function bestOf(id,done){
  const ds=[...done].filter(k=>k.startsWith(id+'|')).map(k=>k.split('|')[1]).sort();
  let best=0,run=0,prev=null;
  for(const s of ds){const d=parseD(s);
    if(prev){const p=new Date(prev);p.setDate(p.getDate()+1);run=ymd(p)===s?run+1:1}else run=1;
    best=Math.max(best,run);prev=d}
  return best;
}
document.documentElement.dataset.theme=localStorage.getItem('hb-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');

function bindSyncButton(){
  const css=document.createElement('style');
  css.textContent='#sdlg{border:1px solid var(--line);border-radius:var(--r);background:var(--card);color:var(--ink);padding:18px;width:min(92vw,420px)}#sdlg::backdrop{background:rgba(0,0,0,.45)}#sdlg h3{margin:0}#sdlg label{display:block;font-size:13px;color:var(--mute);margin:10px 0 4px}#sdlg input{font:inherit;color:inherit;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 10px;min-width:0}#sdlg ol{font-size:13px;color:var(--mute);padding-left:20px;margin:10px 0}#sdlg .btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}#sdlg .btns button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 14px}#sdlg .btns .pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}#sMsg{font-size:13px;min-height:18px;margin-top:8px}';
  document.head.appendChild(css);
  const d=document.createElement('dialog');d.id='sdlg';
  d.innerHTML=`<h3>Sync across devices</h3>
    <p class="note" style="margin:6px 0 0">Your habit data is saved in this GitHub repo (<code>data/habits.json</code>), so every device shows the same ticks. Each device needs the token once.</p>
    <label>GitHub username<input id="sOwner" autocomplete="off" autocapitalize="off"></label>
    <label>Repository name<input id="sRepo" autocomplete="off" autocapitalize="off"></label>
    <label>Branch (leave empty for the default)<input id="sBranch" autocomplete="off" autocapitalize="off"></label>
    <label>Access token<input id="sTok" type="password" autocomplete="off" placeholder="github_pat_..."></label>
    <ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a></li>
      <li>Repository access: <b>Only select repositories</b>, pick this repo</li>
      <li>Permissions &rarr; Repository &rarr; <b>Contents: Read and write</b></li>
      <li>Generate, copy, paste above</li></ol>
    <div id="sMsg" role="status"></div>
    <div class="btns"><button type="button" id="sOff">Remove token</button><button type="button" id="sX">Close</button><button type="button" class="pri" id="sGo">Save &amp; sync</button></div>`;
  document.body.appendChild(d);
  const open=()=>{const c=HB.cfg();$('#sOwner').value=c.owner;$('#sRepo').value=c.repo;$('#sBranch').value=c.branch;$('#sTok').value=c.token;$('#sMsg').textContent=HB.state().msg;d.showModal()};
  $('#syncb').addEventListener('click',e=>{e.preventDefault();open()});
  $('#sX').onclick=()=>d.close();
  $('#sGo').onclick=()=>{if(!$('#sTok').value.trim()){$('#sMsg').textContent='The token box is empty. Paste your github_pat_... token first.';$('#sTok').focus();return}
    HB.save({owner:$('#sOwner').value.trim(),repo:$('#sRepo').value.trim(),branch:$('#sBranch').value.trim(),token:$('#sTok').value.trim()});$('#sMsg').textContent='Connecting...';HB.run()};
  $('#sOff').onclick=()=>{const c=HB.cfg();HB.save({...c,token:''});$('#sTok').value='';$('#sMsg').textContent='Token removed from this device.';HB.run()};
  HB.onStatus((s,m)=>{const b=$('#syncb');if(!b)return;b.className=s;
    b.textContent={ok:'● Synced',busy:'● Syncing...',ro:'Set up sync',off:'Set up sync',err:'⚠ Sync issue'}[s]||'Sync';b.title=m||'';
    if(d.open)$('#sMsg').textContent=s==='ok'?'Connected. Your data is saved to GitHub.':(m||'')});
  if(location.hash==='#sync')setTimeout(open,300);
}

/* ===== day notes: dialog + long-press helper ===== */
function noteDialog(title,cur,onSave){
  let d=document.getElementById('ndlg');
  if(!d){
    const css=document.createElement('style');
    css.textContent='#ndlg{border:1px solid var(--line);border-radius:var(--r);background:var(--card);color:var(--ink);padding:18px;width:min(92vw,420px)}#ndlg::backdrop{background:rgba(0,0,0,.45)}#ndlg h3{margin:0 0 10px;font-size:16px}#ndlg textarea{font:inherit;color:inherit;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;resize:vertical;min-height:120px}#ndlg .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}#ndlg .btns button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 14px}#ndlg .btns .pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}';
    document.head.appendChild(css);
    d=document.createElement('dialog');d.id='ndlg';
    d.innerHTML='<h3 id="nT"></h3><textarea id="nTx" maxlength="2000" placeholder="What did you do that day? (reps, how it felt, what to try next time)" aria-label="Note"></textarea><div class="btns"><button type="button" id="nX">Cancel</button><button type="button" class="pri" id="nS">Save</button></div>';
    document.body.appendChild(d);
    d.querySelector('#nX').onclick=()=>d.close();
  }
  d.querySelector('#nT').textContent=title;
  const ta=d.querySelector('#nTx');ta.value=cur||'';
  d.querySelector('#nS').onclick=()=>{const v=ta.value.trim();d.close();onSave(v)};
  d.showModal();setTimeout(()=>ta.focus(),50);
}
/* long-press (touch) or right-click (desktop) on elements matching sel calls onPress(el); the click that follows is swallowed */
function bindLongPress(root,sel,onPress){
  let tm=null,sw=false,x=0,y=0;
  const clr=()=>{clearTimeout(tm);tm=null};
  root.addEventListener('pointerdown',e=>{sw=false;clr();const b=e.target.closest(sel);if(!b||b.disabled||e.button>0)return;x=e.clientX;y=e.clientY;tm=setTimeout(()=>{tm=null;sw=true;onPress(b)},500)});
  root.addEventListener('pointermove',e=>{if(tm&&Math.hypot(e.clientX-x,e.clientY-y)>8)clr()});
  ['pointerup','pointercancel','pointerleave'].forEach(t=>root.addEventListener(t,clr));
  root.addEventListener('contextmenu',e=>{const b=e.target.closest(sel);if(!b)return;e.preventDefault();if(!sw&&!b.disabled){clr();sw=true;onPress(b)}});
  root.addEventListener('click',e=>{if(sw){sw=false;e.stopPropagation();e.preventDefault()}},true);
}

/* installable app: offline service worker (manifest is manifest.webmanifest) */
if(location.protocol.startsWith('http'))navigator.serviceWorker?.register('sw.js').catch(()=>{});
