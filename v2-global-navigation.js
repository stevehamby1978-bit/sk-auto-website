(() => {
  'use strict';

  const path = String(window.location.pathname || '').toLowerCase();
  const publicPages = new Set(['/', '/index.html', '/login.html', '/register.html', '/estimate.html', '/invoice.html', '/receipt.html', '/repair-authorization.html']);
  if (publicPages.has(path) || path.startsWith('/marketing/')) return;

  function addStyles() {
    if (document.getElementById('garavexGlobalDashboardStyle')) return;
    const style=document.createElement('style');style.id='garavexGlobalDashboardStyle';style.textContent=`
      #garavexGlobalDashboardBtn{position:fixed;top:14px;right:18px;z-index:2147483646;display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:8px 14px;border:1px solid rgba(255,255,255,.28);border-radius:8px;background:#0879a8;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);font:700 13px/1.1 Arial,Helvetica,sans-serif;text-decoration:none;cursor:pointer}
      #garavexGlobalDashboardBtn:hover{filter:brightness(1.12)}
      #garavexReopenRepairBtn{background:#d97706!important;color:#fff!important;margin-left:10px!important;display:inline-block!important}
      @media(max-width:700px){#garavexGlobalDashboardBtn{top:8px;right:8px;padding:8px 10px}}
    `;document.head.appendChild(style);
  }

  function installDashboardButton(){if(!document.body||document.getElementById('garavexGlobalDashboardBtn')||path==='/dashboard.html'||path==='/v2-dashboard.html')return;const link=document.createElement('a');link.id='garavexGlobalDashboardBtn';link.href='/dashboard.html';link.innerHTML='<span aria-hidden="true">⌂</span><span>Dashboard</span>';document.body.appendChild(link)}

  function installRepairOrderControls(){
    if(path!=='/repair-order.html')return;
    const orderId=Number(new URLSearchParams(location.search).get('id'));if(!Number.isInteger(orderId)||orderId<=0)return;
    const statusEl=document.getElementById('status'),select=document.getElementById('statusSelect'),updateBtn=document.getElementById('updateStatusBtn'),completeBtn=document.getElementById('completeRepairBtn');
    if(!statusEl)return;
    const current=String(statusEl.textContent||'').trim().toLowerCase().replace(/\s+/g,'_');

    if(select){
      const options=[['waiting','Waiting'],['in_progress','In Progress'],['cancelled','Cancelled']];
      select.innerHTML='<option value="">Change Status</option>'+options.map(([v,t])=>`<option value="${v}">${t}</option>`).join('');
      if(current==='completed')select.disabled=true;
    }
    if(updateBtn){
      updateBtn.style.display=current==='completed'?'none':'';
      updateBtn.onclick=async()=>{
        const next=String(select?.value||'');if(!next)return alert('Choose a status first.');
        updateBtn.disabled=true;const old=updateBtn.textContent;updateBtn.textContent='Updating...';
        try{const r=await fetch(`/api/repair-orders/${orderId}/status`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({status:next})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Unable to update repair order status.');location.reload()}catch(e){alert(e.message||'Unable to update repair order status.');updateBtn.disabled=false;updateBtn.textContent=old}
      };
    }

    if(current==='completed'&&!document.getElementById('garavexReopenRepairBtn')){
      const btn=document.createElement('button');btn.id='garavexReopenRepairBtn';btn.type='button';btn.className='btn btn-amber';btn.textContent='↻ Reopen Repair Order';
      const host=completeBtn?.parentElement||document.querySelector('.completion-box')||document.querySelector('.actions');if(host)host.appendChild(btn);else document.getElementById('repairOrder')?.prepend(btn);
      if(completeBtn)completeBtn.style.display='none';
      btn.onclick=async()=>{if(!confirm('Reopen this repair order and return it to In Progress?'))return;btn.disabled=true;btn.textContent='Reopening...';try{const r=await fetch(`/api/repair-orders/${orderId}/reopen`,{method:'PATCH',credentials:'same-origin',headers:{'Accept':'application/json'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Unable to reopen repair order.');alert('Repair order reopened.');location.reload()}catch(e){alert(e.message||'Unable to reopen repair order.');btn.disabled=false;btn.textContent='↻ Reopen Repair Order'}};
    }
  }

  function install(){addStyles();installDashboardButton();let tries=0;const timer=setInterval(()=>{installRepairOrderControls();if(++tries>=40)clearInterval(timer)},250)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
