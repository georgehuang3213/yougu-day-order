import { checkCredentials, issueToken } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  const { username, password } = req.body || {};
  if (!checkCredentials(username, password)) {
    // 輕微延遲以減緩暴力猜測
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  }
  return res.status(200).json({ success: true, token: issueToken() });
}
