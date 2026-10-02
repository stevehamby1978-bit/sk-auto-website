/* Shared Garavex V2 navigation. */
(()=>{
 const links=[['v2-search.html','Search'],['v2-dashboard.html','Operations'],['v2-alerts.html','Attention'],['v2-daily-plan.html','Daily Plan'],['v2-handoff.html','Handoff'],['v2-tasks.html','Tasks'],['v2-customer-requests.html','Customer Contact'],['v2-status-board.html','Shop Board'],['v2-promises.html','Promises'],['v2-blockers.html','Blockers'],['v2-checkin.html','Check In'],['v2-keys.html','Key Board'],['v2-loaners.html','Loaners'],['v2-dispatch.html','Dispatch'],['v2-technician.html','Technician'],['v2-workflow-summary.html','RO Summary'],['v2-notes.html','RO Notes'],['v2-timeline.html','RO Timeline'],['v2-dvi.html','Inspections'],['v2-roadtests.html','Road Tests'],['v2-quality.html','Final QC'],['v2-completion-check.html','Completion Check'],['v2-ready-board.html','Ready Board'],['v2-delivery.html','Delivery'],['v2-warranty.html','Warranty'],['v2-customer-history.html','Customer History'],['v2-comebacks.html','Comebacks'],['v2-deferred.html','Deferred'],['v2-followups.html','Follow-ups'],['v2-vin.html','VIN Intake'],['v2-inventory.html','Inventory'],['v2-parts-requests.html','Parts Requests'],['v2-parts.html','Purchasing'],['v2-owner.html','Owner'],['v2-reports.html','Reports'],['v2-activity.html','Activity'],['v2-team.html','Team'],['v2-audit.html','Audit'],['v2-health.html','Readiness'],['v2-release-tests.html','Isolation Tests'],['v2-settings.html','Setup']];
 const current=location.pathname.split('/').pop();
 const shell=document.createElement('div');shell.style.cssText='position:sticky;top:0;z-index:999;background:#0b0f12;border-bottom:1px solid #29323a;font:13px Arial,sans-serif';
 const top=document.createElement('div');top.style.cssText='display:flex;align-items:center;gap:10px;padding:9px 14px';
 const brand=document.createElement('a');brand.href='v2-dashboard.html';brand.textContent='G  GARAVEX V2';brand.style.cssText='font-weight:800;color:#fff;text-decoration:none;white-space:nowrap';top.appendChild(brand);
 const badge=document.createElement('span');badge.textContent='FULL V2';badge.style.cssText='background:#e53228;color:white;border-radius:999px;padding:4px 8px;font-weight:800;font-size:10px';top.appendChild(badge);
 const toggle=document.createElement('button');toggle.type='button';toggle.textContent='☰ All V2 Modules';toggle.style.cssText='margin-left:auto;background:#252d34;color:#fff;border:1px solid #39434c;border-radius:7px;padding:8px 11px;font-weight:700;cursor:pointer';top.appendChild(toggle);
 const logout=document.createElement('button');logout.type='button';logout.textContent='Log Out';logout.style.cssText='background:#e53228;color:#fff;border:1px solid #e53228;border-radius:7px;padding:8px 11px;font-weight:800;cursor:pointer;white-space:nowrap';top.appendChild(logout);shell.appendChild(top);
 const nav=document.createElement('nav');nav.setAttribute('aria-label','Garavex V2');nav.style.cssText='display:flex;gap:6px;align-items:center;overflow:auto;padding:0 14px 10px;white-space:nowrap';
 links.slice(0,12).forEach(([href,label])=>{const a=document.createElement('a');a.href=href;a.textContent=label;a.style.cssText=`color:${current===href?'#fff':'#9aa5ad'};text-decoration:none;padding:8px 10px;border-radius:6px;background:${current===href?'#252d34':'transparent'}`;nav.appendChild(a)});shell.appendChild(nav);
 const panel=document.createElement('div');panel.style.cssText='display:none;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;padding:10px 14px 14px;border-top:1px solid #202830;max-height:55vh;overflow:auto';
 links.forEach(([href,label])=>{const a=document.createElement('a');a.href=href;a.textContent=label;a.style.cssText=`color:${current===href?'#fff':'#c2c9cf'};text-decoration:none;padding:10px;border-radius:6px;background:${current===href?'#252d34':'#11171c'};border:1px solid #273039`;panel.appendChild(a)});shell.appendChild(panel);
 toggle.addEventListener('click',()=>{const open=panel.style.display==='grid';panel.style.display=open?'none':'grid';toggle.textContent=open?'☰ All V2 Modules':'✕ Close Modules'});
 logout.addEventListener('click',async()=>{
   if(logout.disabled)return;
   logout.disabled=true;logout.textContent='Logging Out…';
   try{
     const response=await fetch('/api/logout',{method:'POST',credentials:'same-origin'});
     if(!response.ok)throw new Error('Logout failed');
     location.replace('/login.html');
   }catch(err){
     console.error('Garavex V2 logout error:',err);
     logout.disabled=false;logout.textContent='Log Out';
     alert('Unable to log out. Please try again.');
   }
 });
 document.body.insertBefore(shell,document.body.firstChild);
})();
