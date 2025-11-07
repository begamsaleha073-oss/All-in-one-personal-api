const DEFAULT_TIMEOUT = 9000; 
const RETRY_COUNT = 1;

async function fetchWithTimeout(url, opts = {}, timeout = DEFAULT_TIMEOUT, retry = RETRY_COUNT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(timer);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { ok: res.ok, status: res.status, data: json };
  } catch (err) {
    clearTimeout(timer);
    if (retry > 0) {
      await new Promise(r => setTimeout(r, 300));
      return fetchWithTimeout(url, opts, timeout, retry - 1);
    }
    return { ok: false, error: err.message || String(err) };
  }
}

function uniqStrings(arr) {
  return Array.from(new Set(arr.filter(Boolean).map(String)));
}

export default async function handler(req, res) {
  try {
    const method = req.method.toUpperCase();
    const input = method === 'POST' ? (req.body || {}) : (req.query || {});

    const number = (input.number || input.mobile || '').toString().trim();
    const aadhaarInput = (input.aadhaar || input.id || '').toString().trim();

    const ALLAPI_KEY = process.env.ALLAPI_KEY || 'DEMOKEY';
    const RATION_KEY = process.env.RATION_KEY || 'paidchx';

    if (!number && !aadhaarInput) {
      return res.status(400).json({
        success: false,
        message: 'कृपया `number` (mobile) या `aadhaar` (id) भेजें।',
        example: { number: '9016178226' }
      });
    }

    const out = {
      input: { number: number || null, aadhaar: aadhaarInput || null },
      raw: { numspy: null, happy_ration_calls: [], allapiinone_calls: [] },
      ids_found: [],
      per_id: {}
    };

    let idsToProcess = [];
    if (number && !aadhaarInput) {
      const numspyUrl = `https://numspy.vercel.app/api/search?number=${encodeURIComponent(number)}`;
      const rNumspy = await fetchWithTimeout(numspyUrl);
      out.raw.numspy = { url: numspyUrl, result: rNumspy };

      if (rNumspy.ok && rNumspy.data && Array.isArray(rNumspy.data.data)) {
        const ids = rNumspy.data.data.map(d => d.id).filter(Boolean);
        idsToProcess = uniqStrings(ids);
        for (const rec of rNumspy.data.data) {
          const idVal = rec.id;
          const idKey = idVal ? String(idVal) : '__no_id__';
          if (!out.per_id[idKey]) {
            out.per_id[idKey] = { id: idVal || null, numspy_records: [], happy_ration: null, allapiinone: null };
          }
          out.per_id[idKey].numspy_records.push(rec);
        }
      } else {
        out.raw.numspy.note = 'Numspy ने कोई डेटा नहीं दिया या error आई।';
      }
    }

    if (aadhaarInput) {
      const idNormalized = String(aadhaarInput);
      idsToProcess = uniqStrings([ ...(idsToProcess || []), idNormalized ]);
      if (!out.per_id[idNormalized]) {
        out.per_id[idNormalized] = { id: idNormalized, numspy_records: [], happy_ration: null, allapiinone: null };
      }
    }

    if (!idsToProcess.length) {
      return res.status(200).json({
        success: false,
        message: 'कोई Aadhaar ID नहीं मिली।',
        result: out
      });
    }

    out.ids_found = idsToProcess;

    for (const idVal of idsToProcess) {
      const rationUrl = `https://happy-ration-info.vercel.app/fetch?key=${encodeURIComponent(RATION_KEY)}&aadhaar=${encodeURIComponent(idVal)}`;
      const rRation = await fetchWithTimeout(rationUrl);
      out.raw.happy_ration_calls.push({ id: idVal, url: rationUrl, result: rRation });
      if (!out.per_id[idVal]) out.per_id[idVal] = { id: idVal, numspy_records: [], happy_ration: null, allapiinone: null };
      out.per_id[idVal].happy_ration = rRation;

      const allApiUrl = `https://allapiinone.vercel.app/?key=${encodeURIComponent(ALLAPI_KEY)}&type=id_number&term=${encodeURIComponent(idVal)}`;
      const rAll = await fetchWithTimeout(allApiUrl);
      out.raw.allapiinone_calls.push({ id: idVal, url: allApiUrl, result: rAll });
      out.per_id[idVal].allapiinone = rAll;
    }

    const anyGood =
      out.raw.happy_ration_calls.some(c => c.result && c.result.ok) ||
      out.raw.allapiinone_calls.some(c => c.result && c.result.ok);

    return res.status(200).json({
      success: Boolean(anyGood),
      message: anyGood ? 'कम से कम एक API ने डेटा दिया।' : 'कोई API से उपयोगी डेटा नहीं मिला।',
      summary: { ids_found_count: out.ids_found.length, ids: out.ids_found },
      result: out
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Server error: ' + e.message
    });
  }
}
