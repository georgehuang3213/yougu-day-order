import crypto from "crypto";

// 管理員帳密：請在 Vercel 設定 ADMIN_USERNAME / ADMIN_PASSWORD（未設定時使用暫時預設值）
const ADMIN_USERNAME = () => (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const ADMIN_PASSWORD = () => process.env.ADMIN_PASSWORD || "yougu888";
const SECRET = () => process.env.SESSION_SECRET || `yougu-session::${ADMIN_PASSWORD()}`;
const TTL_MS = 12 * 60 * 60 * 1000; // 12 小時

function hmac(data) {
  return crypto.createHmac("sha256", SECRET()).update(data).digest("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function checkCredentials(username, password) {
  const u = safeEqual((username || "").trim().toLowerCase(), ADMIN_USERNAME());
  const p = safeEqual(password || "", ADMIN_PASSWORD());
  return u && p;
}

export function issueToken() {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${hmac(String(exp))}`;
}

export function isAuthed(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(exp));
}

// 未登入時回應 401 並回傳 false
export function requireAdmin(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ success: false, message: "未授權，請先登入後台" });
  return false;
}
