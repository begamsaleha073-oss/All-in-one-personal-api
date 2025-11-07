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
    const input = method === "POST" ? (req.body || {}) : (req.query || {});

    const number = (input.number || input.mobile || "").toString().trim();
    const aadhaarInput = (input.aadhaar || input.id || "").toString().trim();

    const ALLAPI_KEY = process.env.ALLAPI_KEY || "DEMOKEY";
    const RATION_KEY = process.env.RATION_KEY || "paidchx";

    if (!number && !aadhaarInput) {
      return res.status(400).json({
        success: false,
        message: "कृपया `number` (mobile) या `aadhaar` (id) भेजें।",
        example: { number: "9016178226" }
      });
    }

    const resultData = {
      numspy: null,
      ration: [],
      aadhar: []
    };

    let idsToProcess = [];

    // 🔹 Step 1: NumSpy API
    if (number && !aadhaarInput) {
      const numspyUrl = `https://numspy.vercel.app/api/search?number=${encodeURIComponent(number)}`;
      const rNumspy = await fetchWithTimeout(numspyUrl);
      
      if (rNumspy.ok && rNumspy.data && Array.isArray(rNumspy.data.data)) {
        resultData.numspy = rNumspy.data.data.map(d => ({
          name: d.name,
          fname: d.fname,
          address: d.address,
          alt: d.alt,
          circle: d.circle,
          id: d.id
        }));
        idsToProcess = uniqStrings(rNumspy.data.data.map(d => d.id).filter(Boolean));
      }
    }

    // 🔹 Step 2: अगर aadhaar manually दिया गया है तो उसे भी जोड़ें
    if (aadhaarInput) {
      idsToProcess = uniqStrings([...idsToProcess, aadhaarInput]);
    }

    if (!idsToProcess.length) {
      return res.status(200).json({
        success: false,
        message: "कोई Aadhaar ID नहीं मिली।",
        data: resultData
      });
    }

    // 🔹 Step 3: Ration और Aadhar APIs call करें
    for (const idVal of idsToProcess) {
      const rationUrl = `https://happy-ration-info.vercel.app/fetch?key=${encodeURIComponent(RATION_KEY)}&aadhaar=${encodeURIComponent(idVal)}`;
      const allApiUrl = `https://allapiinone.vercel.app/?key=${encodeURIComponent(ALLAPI_KEY)}&type=id_number&term=${encodeURIComponent(idVal)}`;

      const [rRation, rAll] = await Promise.all([
        fetchWithTimeout(rationUrl),
        fetchWithTimeout(allApiUrl)
      ]);

      if (rRation.ok && rRation.data) {
        resultData.ration.push({ id: idVal, data: rRation.data });
      }
      if (rAll.ok && rAll.data) {
        resultData.aadhar.push({ id: idVal, data: rAll.data });
      }
    }

    // 🔹 Step 4: Final JSON return (URLs hidden)
    const anyGood = resultData.numspy || resultData.ration.length || resultData.aadhar.length;

    return res.status(200).json({
      success: Boolean(anyGood),
      message: anyGood
        ? "तीनों API से डेटा प्राप्त हुआ।"
        : "कोई डेटा नहीं मिला।",
      data: resultData
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Server error: " + e.message
    });
  }
}
