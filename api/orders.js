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
    // 修正 AWS SDK v3 與 Cloudflare R2 的 SSL/checksum 相容性問題
    requestChecksumCalculation: "when_required",
    responseChecksumValidation: "when_required",
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

// 發送 Telegram 通知給店家（顧客下單後自動推播，免費無限制）
async function sendLineNotificationToStore(order) {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;

  if (!tgToken || !tgChatId) {
    return; // 未設定時自動略過
  }

  const itemsText = (order.items || []).map((item, idx) =>
    `  ${idx + 1}. ${item.name} × ${item.quantity || item.qty || 1} (NT$${(item.price || 0) * (item.quantity || item.qty || 1)})`
  ).join('\n');

  const text =
`🔔【優穀日・新訂單即時通知】

單號：#${order.orderId || order.id}
訂購人：${order.customerName}
電話：${order.customerPhone || order.phone || '未留'}
取餐時間：${order.pickupDate || '今日'} ${order.pickupTime || '盡速'}
付款方式：${order.paymentMethod === 'linepay' ? 'LINE Pay Money' : '現場現金付款'}
${order.bringEcoBag || order.needBag ? '自備餐袋：✅ 是\n' : ''}${order.discountAmount > 0 ? `優惠折抵：-NT$ ${order.discountAmount} (${order.discountCode || ''})\n` : ''}合計金額：NT$ ${order.finalTotal || order.total || 0}

📋 訂購品項：
${itemsText}
${(order.notes || order.note) ? `\n備註：${order.notes || order.note}\n` : ''}
👉 點擊開啟後台接單：
https://yougu-day-order.vercel.app/admin`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: tgChatId,
        text: text
      })
    });
    if (!response.ok) {
      const err = await response.text();
      console.warn("Telegram 推播失敗:", response.status, err);
    }
  } catch (err) {
    console.warn("Telegram 推播網路錯誤:", err);
  }
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

  // POST: 顧客提交新訂單 (支援多人同時在線下單與高並發防碰撞)
  if (req.method === "POST") {
    try {
      const data = req.body;
      if (!data || !data.customerName || !data.items || data.items.length === 0) {
        return res.status(400).json({
          success: false,
          message: "請提供完整的顧客資訊與訂單項目"
        });
      }

      // 生成高並發唯一訂單編號 (格式：YG-月日-毫秒+3位英數亂數，保證同時多人下單絕不碰撞重複)
      const now = new Date();
      const todayStr = now.toISOString().slice(5, 10).replace("-", "");
      const timeMs = now.getTime().toString().slice(-4);
      const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
      const generatedId = `YG-${todayStr}-${timeMs}${randomSuffix}`;

      const newOrder = normalizeOrder(data, generatedId);

      // 1. 先將單筆訂單獨立寫入 Cloudflare R2 (獨立檔案 orders/{id}.json，高並發安全隔離)
      await saveSingleOrder(r2Client, newOrder);

      // 2. 讀取最新總表並進行 Map 鍵值聯集合併，防止多人同時寫入時互相覆蓋
      const currentOrders = await loadOrders(r2Client);
      const orderMap = new Map();
      // 將新訂單優先放入
      orderMap.set(newOrder.orderId || newOrder.id, newOrder);
      // 合併所有既有訂單
      currentOrders.forEach(o => {
        const id = o.orderId || o.id;
        if (id && !orderMap.has(id)) {
          orderMap.set(id, o);
        }
      });

      const mergedOrders = Array.from(orderMap.values());
      // 依建立時間排序，最新訂單排在最前
      mergedOrders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      await saveOrders(r2Client, mergedOrders);

      // 3. 非同步發送 LINE 通知給店家（不阻礙顧客結帳回應）
      sendLineNotificationToStore(newOrder).catch(e => console.warn("LINE push error:", e));

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

  // DELETE: 刪除指定訂單或清空全部訂單
  if (req.method === "DELETE") {
    try {
      const parsedUrl = new URL(req.url || "", "http://localhost");
      const isClearAll = req.query?.all === "true" || parsedUrl.searchParams.get("all") === "true";
      const targetId = req.query?.id || parsedUrl.searchParams.get("id") || parsedUrl.searchParams.get("orderId") || req.body?.orderId || req.body?.id;

      if (isClearAll) {
        // 清空所有訂單
        await saveOrders(r2Client, []);
        return res.status(200).json({
          success: true,
          message: "已成功清空所有雲端與本機訂單資料",
          storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
        });
      }

      if (!targetId) {
        return res.status(400).json({ success: false, message: "缺少欲刪除的訂單編號" });
      }

      let orders = await loadOrders(r2Client);
      const filtered = orders.filter(o => o.orderId !== targetId && o.id !== targetId);

      await saveOrders(r2Client, filtered);

      // 若有 R2 連線，嘗試刪除單筆檔案備份
      if (r2Client) {
        try {
          await r2Client.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `orders/${targetId}.json`
          }));
        } catch (e) {
          console.warn("刪除單筆 R2 檔案備份失敗:", e);
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
