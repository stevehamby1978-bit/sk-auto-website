/* Garavex V2 VIN decoding service.
 * Uses the public NHTSA vPIC API; no API key required.
 */
function installVinApi(app, { requireLogin }) {
  if (!app || !requireLogin) throw new Error('V2 VIN service requires app and login middleware.');

  app.get('/api/v2/vin/:vin', requireLogin, async (req, res) => {
    const vin = String(req.params.vin || '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'Enter a valid 17-character VIN.' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`VIN service returned ${response.status}`);
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (!type.includes('application/json')) throw new Error('VIN service returned a non-JSON response');
      const data = await response.json();
      const r = Array.isArray(data?.Results) ? data.Results[0] : null;
      if (!r) return res.status(404).json({ error: 'VIN could not be decoded.' });

      const errorCode = String(r.ErrorCode || '').trim();
      const decodedVin = String(r.VIN || vin).trim().toUpperCase();
      const hasVehicleData = Boolean(r.ModelYear || r.Make || r.Model);
      if (!hasVehicleData || (decodedVin && decodedVin !== vin)) {
        return res.status(422).json({ error: 'VIN was not recognized as a valid vehicle VIN.' });
      }

      res.set('Cache-Control', 'private, max-age=86400');
      return res.json({
        vin,
        year: r.ModelYear || '',
        make: r.Make || '',
        model: r.Model || '',
        trim: r.Trim || r.Series || '',
        engine: [r.DisplacementL && `${r.DisplacementL}L`, r.EngineCylinders && `${r.EngineCylinders} cyl`, r.EngineConfiguration, r.FuelTypePrimary].filter(Boolean).join(' '),
        body: r.BodyClass || '',
        drive: r.DriveType || '',
        transmission: r.TransmissionStyle || '',
        plant: [r.PlantCity, r.PlantState, r.PlantCountry].filter(Boolean).join(', '),
        decode_warning: errorCode && errorCode !== '0' ? String(r.ErrorText || '').trim().slice(0, 500) : ''
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      console.error('V2 VIN decode error:', timedOut ? 'request timed out' : err);
      return res.status(502).json({ error: timedOut ? 'VIN decoding service timed out. Please try again.' : 'VIN decoding service is temporarily unavailable.' });
    } finally {
      clearTimeout(timeout);
    }
  });
}
module.exports = { installVinApi };
