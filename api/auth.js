import { checkCredentials, issueToken } from "./_auth.js";

// 記憶體防暴力破解限制器 (以 IP 為基準，5 次失敗鎖定 15 分鐘)
const failedAttempts = new Map();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  const ip = getClientIp(req);
  const now = Date.now();
  const record = failedAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (record.lockUntil > now) {
    const remainSec = Math.ceil((record.lockUntil - now) / 1000);
    return res.status(429).json({
      success: false,
      message: `密碼錯誤次數過多，後台已鎖定。請於 ${remainSec} 秒後再試。`
    });
  }

  const { username, password } = req.body || {};
  if (!checkCredentials(username, password)) {
    record.count += 1;
    if (record.count >= MAX_FAILURES) {
      record.lockUntil = now + LOCKOUT_MS;
      failedAttempts.set(ip, record);
      return res.status(429).json({
        success: false,
        message: `密碼連續錯誤達到 ${MAX_FAILURES} 次，系統已暫時鎖定 15 分鐘。`
      });
    }
    failedAttempts.set(ip, record);
    // 延遲以減緩猜測
    await new Promise(r => setTimeout(r, 800));
    const remainAttempts = MAX_FAILURES - record.count;
    return res.status(401).json({
      success: false,
      message: `帳號或密碼錯誤（剩餘嘗試次數：${remainAttempts} 次）`
    });
  }

  // 登入成功：清除該 IP 的失敗記錄
  failedAttempts.delete(ip);
  return res.status(200).json({ success: true, token: issueToken() });
}

