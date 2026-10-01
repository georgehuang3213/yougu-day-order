import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// 記憶體備用資料（當未設定 Cloudflare R2 環境變數時的展示資料）
let memoryOrders = [
  {
    id: "YG-1001",
    orderId: "YG-1001",
    customerName: "陳小姐",
    phone: "0912345678",
    customerPhone: "0912345678",
    pickupDate: "2026-10-02",
    pickupTime: "08:30",
    paymentMethod: "linepay",
    needBag: false,
    bringEcoBag: false,
    discountCode: "折價20元",
    couponApplied: "折價20元",
    discountAmount: 20,
    items: [
      {
        id: "blueberry_bowl",
        name: "招牌自製藍莓燕麥優格碗",
        price: 130,
        qty: 1,
        quantity: 1,
        options: ["100%無加糖鮮奶優格", "招牌自製藍莓果醬", "乾濕分離燕麥脆粒"]
      },
      {
        id: "extra_granola",
        name: "加購特製手作燕麥脆粒(袋裝)",
        price: 35,
        qty: 1,
        quantity: 1,
        options: ["低溫烘焙香脆堅果"]
      }
    ],
    subtotal: 165,
    total: 145,
    finalTotal: 145,
    totalAmount: 145,
    note: "請附木湯匙，謝謝！",
    notes: "請附木湯匙，謝謝！",
    status: "new", // new, preparing, ready, completed, cancelled
    createdAt: new Date().toISOString()
  }
];

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
  });
}

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";

async function streamToString(stream) {
  if (!stream) return "";
  if (typeof stream === "string") return stream;
  if (Buffer.isBuffer(stream)) return stream.toString("utf-8");
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

// 從 Cloudflare R2 載入所有訂單
async function loadOrders(client) {
  if (!client) {
    return memoryOrders;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: "orders.json",
    });
    const response = await client.send(command);
    const bodyStr = await streamToString(response.Body);
    if (!bodyStr) return [];
    const parsed = JSON.parse(bodyStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      // 尚無訂單檔案時，回傳空陣列
      return [];
    }
    console.error("Cloudflare R2 讀取失敗：", err);
    return memoryOrders;
  }
}

// 儲存所有訂單至 Cloudflare R2
async function saveOrders(client, ordersList) {
  if (!client) {
    memoryOrders = ordersList;
    return;
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: "orders.json",
    Body: JSON.stringify(ordersList, null, 2),
    ContentType: "application/json",
  });
  await client.send(command);
}

// 儲存單筆訂單備份至 Cloudflare R2
async function saveSingleOrder(client, order) {
  if (!client) return;
  try {
    const orderId = order.orderId || order.id;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `orders/${orderId}.json`,
      Body: JSON.stringify(order, null, 2),
      ContentType: "application/json",
    });
    await client.send(command);
  } catch (err) {
    console.warn("備份單筆訂單至 R2 發生錯誤：", err);
  }
}

// 格式化訂單結構（相容前後台與各種欄位別名）
function normalizeOrder(data, customId = null) {
  const orderId = customId || data.orderId || data.id || `YG-${Date.now().toString().slice(-4)}`;
  const subtotal = Number(data.subtotal) || 0;
  const discountAmount = Number(data.discountAmount) || 0;
  const total = Number(data.total || data.finalTotal || data.totalAmount) || Math.max(0, subtotal - discountAmount);

  const formattedItems = (data.items || []).map(item => ({
    id: item.id || "",
    name: item.name || "優格碗",
    price: Number(item.price) || 0,
    qty: Number(item.qty || item.quantity) || 1,
    quantity: Number(item.quantity || item.qty) || 1,
    options: item.options || [],
    addOns: item.addOns || (item.options ? item.options.map(opt => ({ name: opt })) : [])
  }));

  return {
    id: orderId,
    orderId: orderId,
    customerName: data.customerName || "",
    phone: data.phone || data.customerPhone || "",
    customerPhone: data.customerPhone || data.phone || "",
    pickupDate: data.pickupDate || "",
    pickupTime: data.pickupTime || "",
    paymentMethod: data.paymentMethod || "cash",
    needBag: !!(data.needBag || data.bringEcoBag),
    bringEcoBag: !!(data.bringEcoBag || data.needBag),
    discountCode: data.discountCode || data.couponApplied || "",
    couponApplied: data.couponApplied || data.discountCode || "",
    discountAmount: discountAmount,
    items: formattedItems,
    subtotal: subtotal,
    total: total,
    finalTotal: total,
    totalAmount: total,
    note: data.note || data.notes || "",
    notes: data.notes || data.note || "",
    status: data.status || "new",
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString()
  };
}

export default async function handler(req, res) {
  // 允許跨來源請求 (CORS)
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const r2Client = getR2Client();
  const isR2Active = !!r2Client;

  // GET: 取得所有訂單
  if (req.method === "GET") {
    try {
      const orders = await loadOrders(r2Client);
      return res.status(200).json({
        success: true,
        count: orders.length,
        orders: orders,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("GET 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "讀取訂單失敗", error: err.message });
    }
  }

  // POST: 顧客提交新訂單
  if (req.method === "POST") {
    try {
      const data = req.body;
      if (!data || !data.customerName || !data.items || data.items.length === 0) {
        return res.status(400).json({
          success: false,
          message: "請提供完整的顧客資訊與訂單項目"
        });
      }

      const orders = await loadOrders(r2Client);

      const orderSeq = (orders.length + 1).toString().padStart(3, "0");
      const todayStr = new Date().toISOString().slice(5, 10).replace("-", "");
      const generatedId = `YG-${todayStr}-${orderSeq}`;

      const newOrder = normalizeOrder(data, generatedId);

      orders.unshift(newOrder); // 最新訂單放最前面

      await saveOrders(r2Client, orders);
      await saveSingleOrder(r2Client, newOrder);

      return res.status(201).json({
        success: true,
        message: "訂單建立成功！已同步至 Cloudflare R2 資料庫",
        order: newOrder,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("POST 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "儲存訂單失敗", error: err.message });
    }
  }

  // PUT / PATCH: 店家更新訂單狀態 (new -> preparing -> ready -> completed -> cancelled)
  if (req.method === "PUT" || req.method === "PATCH") {
    try {
      const { id, orderId, status } = req.body || {};
      const targetId = orderId || id;

      if (!targetId) {
        return res.status(400).json({ success: false, message: "缺少訂單編號" });
      }

      const orders = await loadOrders(r2Client);
      const orderIndex = orders.findIndex(o => (o.orderId === targetId || o.id === targetId));

      if (orderIndex === -1) {
        return res.status(404).json({ success: false, message: `找不到訂單 #${targetId}` });
      }

      orders[orderIndex].status = status;
      orders[orderIndex].updatedAt = new Date().toISOString();

      await saveOrders(r2Client, orders);
      await saveSingleOrder(r2Client, orders[orderIndex]);

      return res.status(200).json({
        success: true,
        message: `訂單 #${targetId} 狀態已更新為：${status}`,
        order: orders[orderIndex],
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("PUT 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "更新訂單失敗", error: err.message });
    }
  }

  // DELETE: 刪除指定訂單
  if (req.method === "DELETE") {
    try {
      const targetId = req.query?.id || req.body?.orderId || req.body?.id;
      if (!targetId) {
        return res.status(400).json({ success: false, message: "缺少欲刪除的訂單編號" });
      }

      let orders = await loadOrders(r2Client);
      const prevLength = orders.length;
      orders = orders.filter(o => o.orderId !== targetId && o.id !== targetId);

      if (orders.length === prevLength) {
        return res.status(404).json({ success: false, message: `找不到訂單 #${targetId}` });
      }

      await saveOrders(r2Client, orders);

      // 若有 R2 連線，嘗試刪除單檔
      if (r2Client) {
        try {
          await r2Client.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `orders/${targetId}.json`
          }));
        } catch (e) {
          console.warn("刪除單筆 R2 檔案失敗:", e);
        }
      }

      return res.status(200).json({
        success: true,
        message: `訂單 #${targetId} 已成功刪除`,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("DELETE 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "刪除訂單失敗", error: err.message });
    }
  }

  return res.status(405).json({ success: false, message: "Method Not Allowed" });
}
