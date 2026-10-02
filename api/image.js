import crypto from "crypto";

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";

function getR2Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  return { accessKeyId, secretAccessKey, endpoint };
}

function hmacSHA256(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256Hex(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function getSigningKey(secretKey, dateStamp) {
  return hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256("AWS4" + secretKey, dateStamp), "auto"), "s3"), "aws4_request");
}

async function r2GetBinary(r2Config, key) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // empty body
  const canonHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonRequest = ["GET", `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");
  const sig = hmacSHA256(getSigningKey(secretAccessKey, dateStamp), stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader, "x-amz-date": amzDate, "x-amz-content-sha256": bodyHash },
  });
}

export default async function handler(req, res) {
  const { key } = req.query || {};
  if (!key) return res.status(400).send("Missing image key");

  const r2Config = getR2Config();
  if (!r2Config) return res.status(404).send("Storage not configured");

  try {
    const r2Res = await r2GetBinary(r2Config, key);
    if (!r2Res.ok) return res.status(404).send("Image not found");

    const contentType = r2Res.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const arrayBuffer = await r2Res.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    console.warn("Get image error:", err.message);
    return res.status(404).send("Image not found");
  }
}
