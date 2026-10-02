import crypto from "crypto";

// 預設菜單項目
const DEFAULT_MENU = [
  { id: "blueberry_bowl", name: "招牌自製藍莓燕麥優格碗", category: "bowls", price: 130, desc: "100% 無加糖鮮奶優格 ‧ 招牌手工自製藍莓果醬 ‧ 乾濕分離特製酥脆燕麥粒", image: "images/blueberry_bowl.jpg", tag: "人氣招牌", available: true },
  { id: "banana_peanut_bowl", name: "濃醇香蕉花生醬燕麥優格碗", category: "bowls", price: 120, desc: "新鮮香蕉切片 ‧ 純天然無糖花生醬 ‧ 無加糖鮮奶優格 ‧ 酥脆燕麥堅果", image: "images/hero.jpg", tag: "運動首選", available: true },
  { id: "mango_coconut_bowl", name: "盛夏芒果椰片奇亞籽優格碗", category: "bowls", price: 140, desc: "鮮切當季芒果 ‧ 香烤椰子脆片 ‧ 超級食物奇亞籽 ‧ 酥脆燕麥粒", image: "images/hero.jpg", tag: "清爽果香", available: true },
  { id: "honey_nuts_bowl", name: "純粹蜂蜜堅果燕麥優格碗", category: "bowls", price: 110, desc: "天然純蜂蜜 ‧ 低溫烘焙綜合核桃杏仁 ‧ 100%無加糖鮮奶優格 ‧ 酥脆燕麥", image: "images/hero.jpg", tag: "經典純淨", available: true },
  { id: "extra_granola", name: "加購特製手作燕麥脆粒 (袋裝 40g)", category: "addons", price: 35, desc: "手工慢烤燕麥、核桃與南瓜籽，乾濕分離獨立包裝，每一口都極致酥脆！", image: "images/hero.jpg", tag: "必備加購", available: true },
  { id: "extra_blueberry_jam", name: "加購自製手工藍莓果醬罐 (35g)", category: "addons", price: 30, desc: "天然新鮮藍莓慢火細熬，減糖健康無添加膠體，滿滿抗氧化花青素！", image: "images/blueberry_bowl.jpg", tag: "手工鮮作", available: true }
];

let memoryMenu = [...DEFAULT_MENU];

// ─── R2 fetch 工具（AWS Sig V4，無 SDK）─────────────────
function getR2Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  return { accessKeyId, secretAccessKey, endpoint };
}

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";
const MENU_KEY = "menu.json";

function hmacSHA256(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256Hex(data) { return crypto.createHash("sha256").update(data, "utf8").digest("hex"); }
function getSigningKey(secretKey, dateStamp) {
  return hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256("AWS4" + secretKey, dateStamp), "auto"), "s3"), "aws4_request");
}

async function r2Fetch(r2Config, method, key, body) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const bodyStr  = body != null ? (typeof body === "string" ? body : JSON.stringify(body, null, 2)) : "";
  const bodyHash = sha256Hex(bodyStr);
  const ct = body != null ? "application/json" : "";
  const canonHeaders = ct
    ? `content-type:${ct}\nhost:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = ct ? "content-type;host;x-amz-content-sha256;x-amz-date" : "host;x-amz-content-sha256;x-amz-date";
  const canonRequest = [method, `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");
  const sig = hmacSHA256(getSigningKey(secretAccessKey, dateStamp), stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  const headers = { Authorization: authHeader, "x-amz-date": amzDate, "x-amz-content-sha256": bodyHash };
  if (ct) headers["content-type"] = ct;
  return fetch(url, { method, headers, body: bodyStr || undefined });
}

async function loadMenu(r2Config) {
  if (!r2Config) return memoryMenu;
  try {
    const res = await r2Fetch(r2Config, "GET", MENU_KEY);
    if (res.status === 404) { await saveMenu(r2Config, DEFAULT_MENU); return DEFAULT_MENU; }
    if (!res.ok) { console.warn("R2 GET menu 失敗:", res.status); return memoryMenu; }
    const parsed = await res.json();
    if (Array.isArray(parsed) && parsed.length > 0) { memoryMenu = parsed; return parsed; }
  } catch (err) {
    console.warn("loadMenu 錯誤:", err.message);
  }
  return memoryMenu;
}

async function saveMenu(r2Config, menu) {
  memoryMenu = menu;
  if (!r2Config) return;
  try {
    const res = await r2Fetch(r2Config, "PUT", MENU_KEY, menu);
    if (!res.ok) console.error("R2 PUT menu.json 失敗:", res.status, await res.text());
  } catch (err) {
    console.error("saveMenu 錯誤:", err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST,PUT,DELETE");
  res.setHeader("Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version");
  if (req.method === "OPTIONS") return res.status(200).end();

  const r2Config = getR2Config();
  const isR2Active = !!r2Config;

  if (req.method === "GET") {
    try {
      const menu = await loadMenu(r2Config);
      return res.status(200).json({ success: true, menu, storage: isR2Active ? "cloudflare-r2" : "memory-fallback" });
    } catch (err) {
      return res.status(500).json({ success: false, message: "讀取菜單失敗", error: err.message });
    }
  }

  if (req.method === "PUT" || req.method === "POST") {
    try {
      const body = req.body;
      const newMenu = Array.isArray(body) ? body : (body && body.menu);
      if (!Array.isArray(newMenu)) return res.status(400).json({ success: false, message: "無效的菜單格式，請提供陣列" });
      await saveMenu(r2Config, newMenu);
      return res.status(200).json({ success: true, message: "菜單已成功更新並同步至雲端！", menu: newMenu, storage: isR2Active ? "cloudflare-r2" : "memory-fallback" });
    } catch (err) {
      return res.status(500).json({ success: false, message: "更新菜單失敗", error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      await saveMenu(r2Config, DEFAULT_MENU);
      return res.status(200).json({ success: true, message: "已恢復原廠預設菜單！", menu: DEFAULT_MENU });
    } catch (err) {
      return res.status(500).json({ success: false, message: "重置菜單失敗", error: err.message });
    }
  }

  return res.status(405).json({ success: false, message: "Method not allowed" });
}
