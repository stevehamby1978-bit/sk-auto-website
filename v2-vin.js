/* Garavex V2 VIN decoding service.
 * Uses the public NHTSA vPIC API; no API key required.
 */
function installVinApi(app, { requireLogin }) {
  app.get('/api/v2/vin/:vin', requireLogin, async (req, res) => {
    const vin = String(req.params.vin || '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'Enter a valid 17-character VIN.' });
    try {
      const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`);
      if (!response.ok) throw new Error(`VIN service returned ${response.status}`);
      const data = await response.json(); const r = data.Results && data.Results[0];
      if (!r) return res.status(404).json({ error: 'VIN could not be decoded.' });
      res.json({ vin, year:r.ModelYear||'', make:r.Make||'', model:r.Model||'', trim:r.Trim||r.Series||'', engine:[r.DisplacementL&&`${r.DisplacementL}L`,r.EngineCylinders&&`${r.EngineCylinders} cyl`,r.EngineConfiguration,r.FuelTypePrimary].filter(Boolean).join(' '), body:r.BodyClass||'', drive:r.DriveType||'', transmission:r.TransmissionStyle||'', plant:[r.PlantCity,r.PlantState,r.PlantCountry].filter(Boolean).join(', ') });
    } catch (err) { console.error('V2 VIN decode error:', err); res.status(502).json({ error: 'VIN decoding service is temporarily unavailable.' }); }
  });
}
module.exports={installVinApi};
