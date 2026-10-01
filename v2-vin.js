/* Garavex V2 VIN decoding service. Uses the public NHTSA vPIC API. */
const { loadCurrentEmployee, permissionMiddleware } = require('./v2-permissions');
function installVinApi(app, db, { requireLogin }) {
  if (!app || !db || !requireLogin) throw new Error('V2 VIN service requires app, db and login middleware.');
  const requireRepairOrders=permissionMiddleware('repair_orders',db);
  const validId=v=>Number.isInteger(v)&&v>0;
  const noStore=res=>{res.set('Cache-Control','no-store, private, max-age=0');res.set('Pragma','no-cache');res.set('Expires','0');res.set('X-Content-Type-Options','nosniff');};
  app.get('/api/v2/vin/:vin', requireLogin, requireRepairOrders, async (req,res)=>{
    noStore(res);
    const sessionEmployee=req.v2Employee||loadCurrentEmployee(db,req.session?.employee),shopId=Number(sessionEmployee?.shop_id||0),employeeId=Number(sessionEmployee?.id||0);
    if(!sessionEmployee||!validId(shopId)||!validId(employeeId))return res.status(401).json({error:'Employee session is no longer valid for this shop.'});
    req.v2Employee=sessionEmployee;req.v2ShopId=shopId;
    const vin=String(req.params.vin||'').trim().toUpperCase();
    if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))return res.status(400).json({error:'Enter a valid 17-character VIN.'});
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`,{signal:controller.signal,redirect:'error',headers:{Accept:'application/json','User-Agent':'Garavex-V2/2.0'}});
      if(!response.ok)throw new Error(`VIN service returned ${response.status}`);
      const type=String(response.headers.get('content-type')||'').toLowerCase();if(!type.includes('application/json'))throw new Error('VIN service returned a non-JSON response');
      const length=Number(response.headers.get('content-length')||0);if(Number.isFinite(length)&&length>1000000)throw new Error('VIN service response exceeded size limit');
      const text=await response.text();if(Buffer.byteLength(text,'utf8')>1000000)throw new Error('VIN service response exceeded size limit');
      let data;try{data=JSON.parse(text);}catch{throw new Error('VIN service returned invalid JSON');}
      const current=loadCurrentEmployee(db,req.session?.employee);if(!current||Number(current.id)!==employeeId||Number(current.shop_id)!==shopId)return res.status(401).json({error:'Employee session changed while VIN decoding was in progress.'});
      const r=Array.isArray(data?.Results)?data.Results[0]:null;if(!r)return res.status(404).json({error:'VIN could not be decoded.'});
      const errorCode=String(r.ErrorCode||'').trim(),decodedVin=String(r.VIN||vin).trim().toUpperCase(),hasVehicleData=Boolean(r.ModelYear||r.Make||r.Model);
      if(!hasVehicleData||(decodedVin&&decodedVin!==vin))return res.status(422).json({error:'VIN was not recognized as a valid vehicle VIN.'});
      const safe=(v,max=200)=>String(v||'').trim().slice(0,max);
      return res.json({vin,year:safe(r.ModelYear,4),make:safe(r.Make),model:safe(r.Model),trim:safe(r.Trim||r.Series),engine:[r.DisplacementL&&`${safe(r.DisplacementL,20)}L`,r.EngineCylinders&&`${safe(r.EngineCylinders,20)} cyl`,safe(r.EngineConfiguration),safe(r.FuelTypePrimary)].filter(Boolean).join(' ').slice(0,300),body:safe(r.BodyClass),drive:safe(r.DriveType),transmission:safe(r.TransmissionStyle),plant:[safe(r.PlantCity),safe(r.PlantState),safe(r.PlantCountry)].filter(Boolean).join(', ').slice(0,300),decode_warning:errorCode&&errorCode!=='0'?safe(r.ErrorText,500):''});
    }catch(err){const timedOut=err?.name==='AbortError';console.error('V2 VIN decode error:',timedOut?'request timed out':err?.message||err);return res.status(502).json({error:timedOut?'VIN decoding service timed out. Please try again.':'VIN decoding service is temporarily unavailable.'});}finally{clearTimeout(timeout);}
  });
}
module.exports={installVinApi};
