import crypto from "crypto";
import { requireAdmin } from "./_auth.js";

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";

function getR2Config() {
  const CORRECT_ACCOUNT_ID = "8487a37db0822819e2e9a080ed2d437b";
  let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || CORRECT_ACCOUNT_ID).trim().replace(/^["']|["']$/g, "");
  if (accountId.startsWith("8487a37db0822819")) {
    accountId = CORRECT_ACCOUNT_ID;
  }
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim().replace(/^["']|["']$/g, "");
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim().replace(/^["']|["']$/g, "");
  let endpoint = (process.env.R2_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");

  if (endpoint.includes("8487a37db0822819")) {
    endpoint = endpoint.replace(/8487a37db0822819[a-f0-9]{16}/i, CORRECT_ACCOUNT_ID);
  }

  if (!endpoint && accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  endpoint = endpoint.replace(/\/+$/, "");
  return { accessKeyId, secretAccessKey, endpoint };
}

function hmacSHA256(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256Hex(data) { return crypto.createHash("sha256").update(data, "utf8").digest("hex"); }
function getSigningKey(secretKey, dateStamp) {
  return hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256("AWS4" + secretKey, dateStamp), "auto"), "s3"), "aws4_request");
}

// 上傳 binary 資料（Buffer）至 R2
async function r2PutBinary(r2Config, key, buffer, mimeType) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const canonHeaders = `content-type:${mimeType}\nhost:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonRequest = ["PUT", `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");
  const sig = hmacSHA256(getSigningKey(secretAccessKey, dateStamp), stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": bodyHash,
      "content-type": mimeType,
    },
    body: buffer,
  });
}

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ success: false, message: "請提供圖片檔案資料" });

    let mimeType = "image/jpeg";
    let base64Data = image;
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (match) { mimeType = match[1]; base64Data = match[2]; }

    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimes.includes(mimeType.toLowerCase())) {
      return res.status(400).json({ success: false, message: '僅支援上傳圖片檔案 (JPG/PNG/GIF/WebP)' });
    }

    const buffer  = Buffer.from(base64Data, "base64");
    const ext     = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const key     = `menu-images/img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;

    const r2Config = getR2Config();
    if (r2Config) {
      const res2 = await r2PutBinary(r2Config, key, buffer, mimeType);
      if (!res2.ok) throw new Error(`R2 PUT 失敗: ${res2.status} ${await res2.text()}`);
      return res.status(200).json({
        success: true,
        message: "圖片上傳成功！已儲存至 Cloudflare R2",
        url: `/api/image?key=${encodeURIComponent(key)}`,
        key
      });
    } else {
      return res.status(200).json({ success: true, message: "圖片已暫存（本地備援）", url: image, key: "local-fallback" });
    }
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ success: false, message: "圖片上傳失敗", error: err.message });
  }
}
