import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// 預設菜單項目 (100% 依據品牌正確規格)
const DEFAULT_MENU = [
  {
    id: "blueberry_bowl",
    name: "招牌自製藍莓燕麥優格碗",
    category: "bowls",
    price: 130,
    desc: "100% 無加糖鮮奶優格 ‧ 招牌手工自製藍莓果醬 ‧ 乾濕分離特製酥脆燕麥粒",
    image: "images/blueberry_bowl.jpg",
    tag: "人氣招牌",
    available: true
  },
  {
    id: "banana_peanut_bowl",
    name: "濃醇香蕉花生醬燕麥優格碗",
    category: "bowls",
    price: 120,
    desc: "新鮮香蕉切片 ‧ 純天然無糖花生醬 ‧ 無加糖鮮奶優格 ‧ 酥脆燕麥堅果",
    image: "images/hero.jpg",
    tag: "運動首選",
    available: true
  },
  {
    id: "mango_coconut_bowl",
    name: "盛夏芒果椰片奇亞籽優格碗",
    category: "bowls",
    price: 140,
    desc: "鮮切當季芒果 ‧ 香烤椰子脆片 ‧ 超級食物奇亞籽 ‧ 酥脆燕麥粒",
    image: "images/hero.jpg",
    tag: "清爽果香",
    available: true
  },
  {
    id: "honey_nuts_bowl",
    name: "純粹蜂蜜堅果燕麥優格碗",
    category: "bowls",
    price: 110,
    desc: "天然純蜂蜜 ‧ 低溫烘焙綜合核桃杏仁 ‧ 100%無加糖鮮奶優格 ‧ 酥脆燕麥",
    image: "images/hero.jpg",
    tag: "經典純淨",
    available: true
  },
  {
    id: "extra_granola",
    name: "加購特製手作燕麥脆粒 (袋裝 40g)",
    category: "addons",
    price: 35,
    desc: "手工慢烤燕麥、核桃與南瓜籽，乾濕分離獨立包裝，每一口都極致酥脆！",
    image: "images/hero.jpg",
    tag: "必備加購",
    available: true
  },
  {
    id: "extra_blueberry_jam",
    name: "加購自製手工藍莓果醬罐 (35g)",
    category: "addons",
    price: 30,
    desc: "天然新鮮藍莓慢火細熬，減糖健康無添加膠體，滿滿抗氧化花青素！",
    image: "images/blueberry_bowl.jpg",
    tag: "手工鮮作",
    available: true
  }
];

let memoryMenu = [...DEFAULT_MENU];

function getR2Client() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    },
    requestChecksumCalculation: "when_required",
    responseChecksumValidation: "when_required",
  });
}

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";
const MENU_KEY = "menu.json";

async function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function loadMenu(r2Client) {
  if (!r2Client) return memoryMenu;
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: MENU_KEY
    });
    const response = await r2Client.send(command);
    const bodyStr = await streamToString(response.Body);
    const parsed = JSON.parse(bodyStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      memoryMenu = parsed;
      return parsed;
    }
  } catch (err) {
    if (err.name !== "NoSuchKey" && err.$metadata?.httpStatusCode !== 404) {
      console.warn("R2 讀取 menu.json 警告:", err.message);
    }
    // 初次使用或未建立時，自動儲存預設菜單到 R2
    await saveMenu(r2Client, DEFAULT_MENU);
  }
  return memoryMenu;
}

async function saveMenu(r2Client, menu) {
  memoryMenu = menu;
  if (!r2Client) return;
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: MENU_KEY,
      Body: JSON.stringify(menu, null, 2),
      ContentType: "application/json"
    });
    await r2Client.send(command);
  } catch (err) {
    console.error("R2 寫入 menu.json 失敗:", err);
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST,PUT,DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const r2Client = getR2Client();
  const isR2Active = !!r2Client;

  // GET: 取得菜單列表
  if (req.method === "GET") {
    try {
      const menu = await loadMenu(r2Client);
      return res.status(200).json({
        success: true,
        menu: menu,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "讀取菜單失敗", error: err.message });
    }
  }

  // PUT / POST: 店長更新整份菜單 (新增、編輯、下架、刪除)
  if (req.method === "PUT" || req.method === "POST") {
    try {
      const body = req.body;
      const newMenu = Array.isArray(body) ? body : (body && body.menu);
      if (!Array.isArray(newMenu)) {
        return res.status(400).json({ success: false, message: "無效的菜單格式，請提供陣列" });
      }

      await saveMenu(r2Client, newMenu);
      return res.status(200).json({
        success: true,
        message: "菜單已成功更新並同步至雲端資料庫！",
        menu: newMenu,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "更新菜單失敗", error: err.message });
    }
  }

  // DELETE: 恢復預設菜單
  if (req.method === "DELETE") {
    try {
      await saveMenu(r2Client, DEFAULT_MENU);
      return res.status(200).json({
        success: true,
        message: "已恢復原廠預設菜單！",
        menu: DEFAULT_MENU
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "重置菜單失敗", error: err.message });
    }
  }

  return res.status(405).json({ success: false, message: "Method not allowed" });
}
