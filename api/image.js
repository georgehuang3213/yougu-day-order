import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

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

export default async function handler(req, res) {
  const { key } = req.query || {};
  if (!key) {
    return res.status(400).send("Missing image key");
  }

  const r2Client = getR2Client();
  if (!r2Client) {
    return res.status(404).send("Storage not configured");
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });
    const response = await r2Client.send(command);

    res.setHeader("Content-Type", response.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (typeof response.Body.pipe === "function") {
      response.Body.pipe(res);
    } else {
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      res.end(Buffer.concat(chunks));
    }
  } catch (err) {
    console.warn("Get image error:", err.message);
    return res.status(404).send("Image not found");
  }
}
