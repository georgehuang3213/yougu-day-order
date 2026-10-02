import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function getR2Client() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

  if (!accessKeyId || !secretAccessKey || !endpoint) return null;

  return new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "when_required",
    responseChecksumValidation: "when_required",
  });
}

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ success: false, message: "請提供圖片檔案資料" });
    }

    // 解析 Base64 格式：data:image/jpeg;base64,...
    let mimeType = "image/jpeg";
    let base64Data = image;
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    }

    const buffer = Buffer.from(base64Data, "base64");
    const ext = mimeType.split("/")[1] || "jpg";
    const cleanExt = ext === "jpeg" ? "jpg" : ext;
    const key = `menu-images/img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${cleanExt}`;

    const r2Client = getR2Client();
    if (r2Client) {
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      });
      await r2Client.send(command);
      const url = `/api/image?key=${encodeURIComponent(key)}`;
      return res.status(200).json({
        success: true,
        message: "圖片上傳成功！已儲存至 Cloudflare R2",
        url: url,
        key: key
      });
    } else {
      // 離線/未設定 R2 時返回 Data URI 作為備援
      return res.status(200).json({
        success: true,
        message: "圖片已暫存（本地備援）",
        url: image,
        key: "local-fallback"
      });
    }
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ success: false, message: "圖片上傳失敗", error: err.message });
  }
}
