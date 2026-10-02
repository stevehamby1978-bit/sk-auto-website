(() => {
  'use strict';
  const path=String(location.pathname||'').toLowerCase();
  const publicPages=new Set(['/','/index.html','/login.html','/register.html','/estimate.html','/invoice.html','/receipt.html','/repair-authorization.html']);
  if(publicPages.has(path)||path.startsWith('/marketing/'))return;

  function addStyles(){if(document.getElementById('garavexGlobalDashboardStyle'))return;const s=document.createElement('style');s.id='garavexGlobalDashboardStyle';s.textContent=`#garavexGlobalDashboardBtn{position:fixed;top:14px;right:18px;z-index:2147483646;display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:8px 14px;border:1px solid rgba(255,255,255,.28);border-radius:8px;background:#0879a8;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);font:700 13px/1.1 Arial,Helvetica,sans-serif;text-decoration:none;cursor:pointer}#garavexReopenRepairBtn{background:#d97706!important;color:#fff!important;margin-left:10px!important;display:inline-block!important;padding:12px 22px!important;font-size:16px!important}@media(max-width:700px){#garavexGlobalDashboardBtn{top:8px;right:8px;padding:8px 10px}}`;document.head.appendChild(s)}
  function dashboard(){if(!document.body||document.getElementById('garavexGlobalDashboardBtn')||path==='/dashboard.html'||path==='/v2-dashboard.html')return;const a=document.createElement('a');a.id='garavexGlobalDashboardBtn';a.href='/dashboard.html';a.innerHTML='<span>⌂</span><span>Dashboard</span>';document.body.appendChild(a)}

  async function reopen(orderId,btn){if(!confirm('Reopen this repair order and return it to In Progress? Existing invoice and payment records will remain unchanged.'))return;btn.disabled=true;btn.textContent='Reopening...';try{const r=await fetch(`/api/repair-orders/${orderId}/reopen`,{method:'PATCH',credentials:'same-origin',headers:{Accept:'application/json'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Unable to reopen repair order.');alert('Repair order reopened and returned to In Progress.');location.reload()}catch(e){alert(e.message||'Unable to reopen repair order.');btn.disabled=false;btn.textContent='↻ Reopen Repair Order'}}

  function renderFromPage(orderId){
    const status=document.getElementById('status');if(!status)return false;
    const completed=String(status.textContent||'').trim().toLowerCase()==='completed';
    const select=document.getElementById('statusSelect'),update=document.getElementById('updateStatusBtn'),complete=document.getElementById('completeRepairBtn');
    if(select)select.disabled=completed;
    if(update)update.style.display=completed?'none':'';
    let btn=document.getElementById('garavexReopenRepairBtn');
    if(completed){
      if(complete)complete.style.display='none';
      if(!btn){btn=document.createElement('button');btn.id='garavexReopenRepairBtn';btn.type='button';btn.className='btn btn-amber';btn.textContent='↻ Reopen Repair Order';const box=document.querySelector('.completion-box');if(box)box.appendChild(btn);else{const controls=document.querySelector('.status-controls');if(controls)controls.appendChild(btn);else(document.getElementById('repairOrder')||document.body).appendChild(btn)}}
      btn.onclick=()=>reopen(orderId,btn);
    }else if(btn)btn.remove();
    return true;
  }

  function repairOrderControls(){if(path!=='/repair-order.html')return;const orderId=Number(new URLSearchParams(location.search).get('id'));if(!Number.isInteger(orderId)||orderId<=0)return;let count=0;const timer=setInterval(()=>{renderFromPage(orderId);if(++count>=80)clearInterval(timer)},250);renderFromPage(orderId)}
  function install(){addStyles();dashboard();repairOrderControls()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
