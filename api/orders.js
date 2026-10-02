import crypto from "crypto";

// 記憶體備用資料（當未設定 Cloudflare R2 環境變數時的展示資料）
let memoryOrders = [
  {
    id: "YG-1001",
    orderId: "YG-1001",
    customerName: "陳小姐",
    phone: "0912345678",
    customerPhone: "0912345678",
    pickupDate: new Date().toISOString().slice(0, 10),
    pickupTime: "08:30",
    paymentMethod: "linepay",
    needBag: false,
    bringEcoBag: false,
    discountCode: "折價20元",
    couponApplied: "折價20元",
    discountAmount: 20,
    items: [{ id: "yogurt-mango", name: "芒果優格碗", price: 165, qty: 1, quantity: 1, options: [] }],
    subtotal: 165,
    total: 145,
    finalTotal: 145,
    totalAmount: 145,
    note: "請附木湯匙，謝謝！",
    notes: "請附木湯匙，謝謝！",
    status: "new",
    createdAt: new Date().toISOString()
  }
];

// ─────────────────────────────────────────────────────────
// R2 設定（純用環境變數，不依賴 AWS SDK）
// ─────────────────────────────────────────────────────────
function getR2Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);

  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  return { accessKeyId, secretAccessKey, endpoint };
}

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "yougu-orders";

// ─────────────────────────────────────────────────────────
// AWS Signature V4 實作（使用 Node.js crypto，無外部依賴）
// ─────────────────────────────────────────────────────────
function hmacSHA256(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function getSigningKey(secretKey, dateStamp) {
  const kDate    = hmacSHA256("AWS4" + secretKey, dateStamp);
  const kRegion  = hmacSHA256(kDate, "auto");
  const kService = hmacSHA256(kRegion, "s3");
  return hmacSHA256(kService, "aws4_request");
}

// 通用 R2 HTTP 請求（fetch + AWS Sig V4，完全不用 AWS SDK）
async function r2Fetch(r2Config, method, key, body) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const bodyStr    = body != null ? (typeof body === "string" ? body : JSON.stringify(body, null, 2)) : "";
  const bodyHash   = sha256Hex(bodyStr);
  const contentType = body != null ? "application/json" : "";

  // Canonical headers（必須排序）
  const canonHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = contentType
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "host;x-amz-content-sha256;x-amz-date";

  const canonRequest = [method, `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const credScope    = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");

  const signingKey = getSigningKey(secretAccessKey, dateStamp);
  const signature  = hmacSHA256(signingKey, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authHeader,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash,
  };
  if (contentType) headers["content-type"] = contentType;

  return fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });
}

// ─────────────────────────────────────────────────────────
// 訂單 CRUD（R2 或記憶體備用）
// ─────────────────────────────────────────────────────────
async function loadOrders(r2Config) {
  if (!r2Config) return memoryOrders;
  try {
    const res = await r2Fetch(r2Config, "GET", "orders.json");
    if (res.status === 404 || res.status === 403) return [];
    if (!res.ok) { console.error("R2 GET 失敗:", res.status); return memoryOrders; }
    const parsed = await res.json();
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("loadOrders 錯誤:", err.message);
    return memoryOrders;
  }
}

async function saveOrders(r2Config, ordersList) {
  if (!r2Config) { memoryOrders = ordersList; return; }
  const res = await r2Fetch(r2Config, "PUT", "orders.json", ordersList);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`R2 PUT orders.json 失敗: ${res.status} ${txt}`);
  }
}

async function saveSingleOrder(r2Config, order) {
  if (!r2Config) return;
  try {
    const orderId = order.orderId || order.id;
    const res = await r2Fetch(r2Config, "PUT", `orders/${orderId}.json`, order);
    if (!res.ok) console.warn("備份單筆訂單失敗:", res.status);
  } catch (err) {
    console.warn("saveSingleOrder 錯誤:", err.message);
  }
}

async function deleteSingleOrder(r2Config, orderId) {
  if (!r2Config) return;
  try {
    await r2Fetch(r2Config, "DELETE", `orders/${orderId}.json`);
  } catch (err) {
    console.warn("刪除單筆訂單備份失敗:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 格式化訂單結構（相容前後台與各種欄位別名）
// ─────────────────────────────────────────────────────────
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
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────
// 發送 Telegram 通知給店家
// ─────────────────────────────────────────────────────────
async function sendLineNotificationToStore(order) {
  const tgToken  = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChatId) return;

  const itemsText = (order.items || []).map((item, idx) =>
    `  ${idx + 1}. ${item.name} × ${item.quantity || item.qty || 1} (NT$${(item.price || 0) * (item.quantity || item.qty || 1)})`
  ).join("\n");

  const text =
`🔔【優穀日・新訂單即時通知】

單號：#${order.orderId || order.id}
訂購人：${order.customerName}
電話：${order.customerPhone || order.phone || "未留"}
取餐時間：${order.pickupDate || "今日"} ${order.pickupTime || "盡速"}
付款方式：${order.paymentMethod === "linepay" ? "LINE Pay Money" : "現場現金付款"}
${order.bringEcoBag || order.needBag ? "自備餐袋：✅ 是\n" : ""}${order.discountAmount > 0 ? `優惠折抵：-NT$ ${order.discountAmount} (${order.discountCode || ""})\n` : ""}合計金額：NT$ ${order.finalTotal || order.total || 0}

📋 訂購品項：
${itemsText}
${(order.notes || order.note) ? `\n備註：${order.notes || order.note}\n` : ""}
👉 點擊開啟後台接單：
https://yougu-day-order.vercel.app/admin`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChatId, text })
    });
    if (!res.ok) console.warn("Telegram 推播失敗:", res.status, await res.text());
  } catch (err) {
    console.warn("Telegram 推播網路錯誤:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 主要 API Handler
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version");

  if (req.method === "OPTIONS") return res.status(200).end();

  const r2Config  = getR2Config();
  const isR2Active = !!r2Config;

  // ── GET: 取得所有訂單 ──────────────────────────────────
  if (req.method === "GET") {
    try {
      const orders = await loadOrders(r2Config);
      return res.status(200).json({
        success: true, count: orders.length, orders,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("GET 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "讀取訂單失敗", error: err.message });
    }
  }

  // ── POST: 顧客提交新訂單（高並發安全） ──────────────────
  if (req.method === "POST") {
    try {
      const data = req.body;
      if (!data || !data.customerName || !data.items || data.items.length === 0) {
        return res.status(400).json({ success: false, message: "請提供完整的顧客資訊與訂單項目" });
      }

      // 生成防碰撞唯一訂單編號
      const now        = new Date();
      const todayStr   = now.toISOString().slice(5, 10).replace("-", "");
      const timeMs     = now.getTime().toString().slice(-4);
      const randSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
      const generatedId = `YG-${todayStr}-${timeMs}${randSuffix}`;

      const newOrder = normalizeOrder(data, generatedId);

      // 1. 先寫個別備份（不影響主流程失敗）
      await saveSingleOrder(r2Config, newOrder);

      // 2. 讀取總表 → Map 合併 → 寫回（防多人同時覆蓋）
      const currentOrders = await loadOrders(r2Config);
      const orderMap = new Map();
      orderMap.set(newOrder.orderId, newOrder);
      currentOrders.forEach(o => {
        const id = o.orderId || o.id;
        if (id && !orderMap.has(id)) orderMap.set(id, o);
      });
      const mergedOrders = Array.from(orderMap.values())
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      await saveOrders(r2Config, mergedOrders);

      // 3. 非同步通知店家（不阻礙回應）
      sendLineNotificationToStore(newOrder).catch(e => console.warn("Telegram push error:", e));

      return res.status(201).json({
        success: true,
        message: "訂單建立成功！已同步至 Cloudflare R2",
        order: newOrder,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("POST 訂單失敗:", err);
      return res.status(500).json({
        success: false, message: "儲存訂單失敗",
        error: err.message,
        cause: err.cause?.message || err.cause?.code || String(err.cause || "")
      });
    }
  }

  // ── PUT / PATCH: 更新訂單狀態 ────────────────────────────
  if (req.method === "PUT" || req.method === "PATCH") {
    try {
      const { id, orderId, status } = req.body || {};
      const targetId = orderId || id;
      if (!targetId) return res.status(400).json({ success: false, message: "缺少訂單編號" });

      const orders = await loadOrders(r2Config);
      const orderIndex = orders.findIndex(o => o.orderId === targetId || o.id === targetId);
      if (orderIndex === -1) return res.status(404).json({ success: false, message: `找不到訂單 #${targetId}` });

      orders[orderIndex].status    = status;
      orders[orderIndex].updatedAt = new Date().toISOString();

      await saveOrders(r2Config, orders);
      await saveSingleOrder(r2Config, orders[orderIndex]);

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

  // ── DELETE: 刪除訂單 ─────────────────────────────────────
  if (req.method === "DELETE") {
    try {
      const parsedUrl = new URL(req.url || "", "http://localhost");
      const isClearAll = req.query?.all === "true" || parsedUrl.searchParams.get("all") === "true";
      const targetId   = req.query?.id || parsedUrl.searchParams.get("id") ||
        parsedUrl.searchParams.get("orderId") || req.body?.orderId || req.body?.id;

      if (isClearAll) {
        await saveOrders(r2Config, []);
        return res.status(200).json({
          success: true, message: "已成功清空所有訂單",
          storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
        });
      }

      if (!targetId) return res.status(400).json({ success: false, message: "缺少欲刪除的訂單編號" });

      const orders   = await loadOrders(r2Config);
      const filtered = orders.filter(o => o.orderId !== targetId && o.id !== targetId);

      await saveOrders(r2Config, filtered);
      await deleteSingleOrder(r2Config, targetId);

      return res.status(200).json({
        success: true, message: `訂單 #${targetId} 已成功刪除`,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("DELETE 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "刪除訂單失敗", error: err.message });
    }
  }

  return res.status(405).json({ success: false, message: "Method Not Allowed" });
}
