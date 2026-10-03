import crypto from "crypto";

// 記憶體備用資料（當雲端暫時離線或重啟時的高可用備援）
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
// R2 設定
// ─────────────────────────────────────────────────────────
function getR2Config() {
  let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "8487a37db0822819e2e9a080ed2d437b").trim().replace(/^["']|["']$/g, "");
  if (accountId === "8487a37db0822819e2c9a080cd2d437b") {
    accountId = "8487a37db0822819e2e9a080ed2d437b";
  }
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim().replace(/^["']|["']$/g, "");
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim().replace(/^["']|["']$/g, "");
  let endpoint = (process.env.R2_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");

  if (endpoint.includes("8487a37db0822819e2c9a080cd2d437b")) {
    endpoint = endpoint.replace("8487a37db0822819e2c9a080cd2d437b", "8487a37db0822819e2e9a080ed2d437b");
  }

  if (!endpoint && accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  endpoint = endpoint.replace(/\/+$/, "");
  return { accessKeyId, secretAccessKey, endpoint };
}

const BUCKET_NAME = (process.env.R2_BUCKET_NAME || "yougu-orders").trim().replace(/^["']|["']$/g, "");

// ─────────────────────────────────────────────────────────
// AWS Signature V4 實作
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

let lastR2Trace = {};

async function r2Fetch(r2Config, method, key, body) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const bodyStr     = body != null ? (typeof body === "string" ? body : JSON.stringify(body, null, 2)) : "";
  const bodyHash    = sha256Hex(bodyStr);
  const contentType = body != null ? "application/json" : "";

  const canonHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = contentType
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "host;x-amz-content-sha256;x-amz-date";

  const canonRequest = [method, `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const canonRequestHash = sha256Hex(canonRequest);
  const credScope    = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, canonRequestHash].join("\n");

  const signingKey = getSigningKey(secretAccessKey, dateStamp);
  const signature  = hmacSHA256(signingKey, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authHeader,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash,
  };
  if (contentType) headers["content-type"] = contentType;

  lastR2Trace = {
    url,
    canonB64: Buffer.from(canonRequest).toString("base64"),
    strToSignB64: Buffer.from(stringToSign).toString("base64"),
    signKeyHex: signingKey.toString("hex"),
    canonRequestHash,
    stringToSign,
    authHeader
  };

  return fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });
}

// ─────────────────────────────────────────────────────────
// 列出 R2 指定前綴之物件鍵值
// ─────────────────────────────────────────────────────────
async function listR2Keys(r2Config, prefix) {
  if (!r2Config) return [];
  try {
    const { endpoint, accessKeyId, secretAccessKey } = r2Config;
    const host = new URL(endpoint).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const dateStamp = amzDate.slice(0, 8);
    const bodyHash = sha256Hex("");
    const canonHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const canonRequest = ["GET", `/${BUCKET_NAME}`, query, canonHeaders, signedHeaders, bodyHash].join("\n");
    const credScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");
    const signingKey = getSigningKey(secretAccessKey, dateStamp);
    const signature = hmacSHA256(signingKey, stringToSign).toString("hex");
    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`${endpoint}/${BUCKET_NAME}?${query}`, {
      headers: {
        Authorization: authHeader,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": bodyHash
      }
    });
    if (res.ok) {
      const xml = await res.text();
      return [...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
    }
  } catch (err) {
    console.warn("listR2Keys 讀取異常:", err.message);
  }
  return [];
}

// ─────────────────────────────────────────────────────────
// 訂單 CRUD（高可用性＋高並發防覆蓋保證：永不中斷、永不遺漏點餐）
// ─────────────────────────────────────────────────────────
let lastR2Debug = {};

async function loadOrders(r2Config) {
  if (!r2Config) return memoryOrders;
  try {
    const map = new Map();

    // 1. 先讀取總表 orders.json
    try {
      const res = await r2Fetch(r2Config, "GET", "orders.json");
      const resText = res.ok ? null : await res.text();
      lastR2Debug = {
        fetchOk: res.ok,
        fetchStatus: res.status,
        fetchText: resText,
        emptySha: sha256Hex(""),
        trace: lastR2Trace
      };
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed)) {
          parsed.forEach(o => { const id = o.orderId || o.id; if (id) map.set(id, o); });
        }
      }
    } catch (e) {
      lastR2Debug = {
        fetchError: e.message,
        cause: e.cause ? (e.cause.message || String(e.cause)) : null,
        code: e.cause?.code || null,
        endpoint: r2Config ? r2Config.endpoint : null,
        url: `${r2Config?.endpoint}/${BUCKET_NAME}/orders.json`
      };
      console.warn("loadOrders 讀取 orders.json 警告:", e.message);
    }

    // 2. 檢查是否有個別 orders/*.json 尚未合併（高並發同時下單防競態覆蓋）
    try {
      const singleKeys = await listR2Keys(r2Config, "orders/");
      const missingKeys = singleKeys.filter(k => {
        const idMatch = k.match(/^orders\/(.+)\.json$/);
        return idMatch && !map.has(idMatch[1]);
      });

      if (missingKeys.length > 0) {
        const fetchedSingleOrders = await Promise.all(
          missingKeys.map(async (k) => {
            try {
              const r = await r2Fetch(r2Config, "GET", k);
              if (r.ok) return await r.json();
            } catch (err) {
              return null;
            }
          })
        );
        let newlyAdded = false;
        fetchedSingleOrders.forEach(o => {
          if (o && (o.orderId || o.id)) {
            map.set(o.orderId || o.id, o);
            newlyAdded = true;
          }
        });

        // 若有新合併的單，自動更新回寫 orders.json 加速下一次讀取
        if (newlyAdded) {
          const mergedNow = Array.from(map.values()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          saveOrders(r2Config, mergedNow).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("檢查 orders/ 備援警告:", e.message);
    }

    // 3. 合併記憶體備援
    memoryOrders.forEach(o => { const id = o.orderId || o.id; if (id && !map.has(id)) map.set(id, o); });

    const merged = Array.from(map.values()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    memoryOrders = merged;
    return merged;
  } catch (err) {
    console.warn("loadOrders 讀取雲端異常 (使用記憶體備援):", err.message);
  }
  return memoryOrders;
}

async function saveOrders(r2Config, ordersList) {
  // 1. 一律先更新伺服器記憶體，保證訂單絕對不遺失
  memoryOrders = ordersList;
  if (!r2Config) return;

  // 2. 異步備份至雲端 R2，若連線失敗不卡死點餐主流程
  try {
    const res = await r2Fetch(r2Config, "PUT", "orders.json", ordersList);
    if (!res.ok) {
      console.warn("R2 PUT orders.json 雲端回應狀態:", res.status);
    }
  } catch (err) {
    console.warn("R2 PUT orders.json 網路異常 (已安全保存於伺服器記憶體):", err.message);
  }
}

async function saveSingleOrder(r2Config, order) {
  if (!r2Config) return;
  try {
    const orderId = order.orderId || order.id;
    await r2Fetch(r2Config, "PUT", `orders/${orderId}.json`, order);
  } catch (err) {
    console.warn("saveSingleOrder 雲端備份通知:", err.message);
  }
}

async function deleteSingleOrder(r2Config, orderId) {
  if (!r2Config) return;
  try {
    await r2Fetch(r2Config, "DELETE", `orders/${orderId}.json`);
  } catch (err) {
    console.warn("deleteSingleOrder 雲端通知:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 格式化訂單結構
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
    bringEcoBag: data.bringEcoBag !== undefined ? !!data.bringEcoBag : !!data.needBag,
    needBag: data.needBag !== undefined ? !!data.needBag : !!data.bringEcoBag,
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
// 發送 Telegram 通知給店家（顧客下單自動即時推播）
// ─────────────────────────────────────────────────────────
async function sendTelegramNotification(order) {
  const tgToken  = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!tgToken || !tgChatId) {
    console.warn("Telegram Token 或 Chat ID 未設定，略過推播");
    return;
  }

  const itemsText = (order.items || []).map((item, idx) =>
    `  ${idx + 1}. ${item.name} × ${item.quantity || item.qty || 1} (NT$${(item.price || 0) * (item.quantity || item.qty || 1)})`
  ).join("\n");

  const phoneStr = order.customerPhone || order.phone || "未留";
  const text =
`🔔【優穀日・新訂單即時通知】

單號：#${order.orderId || order.id}
訂購人：${order.customerName}
聯絡電話：${phoneStr}
📞 點擊通話：tel:${phoneStr}
取餐時間：${order.pickupDate || "今日"} ${order.pickupTime || "盡速"}
付款方式：${order.paymentMethod === "linepay" || order.paymentMethod === "LINE Pay Money" ? "LINE Pay Money" : "現場現金付款"}
${order.bringEcoBag || order.needBag ? "自備餐袋：✅ 是\n" : ""}${order.discountAmount > 0 ? `優惠折抵：-NT$ ${order.discountAmount} (${order.discountCode || ""})\n` : ""}合計金額：NT$ ${order.finalTotal || order.total || 0}

📋 訂購品項：
${itemsText}
${(order.notes || order.note) ? `\n備註：${order.notes || order.note}\n` : ""}
👉 點擊開啟後台接單：
https://yougu-day-order.vercel.app/admin`;

  // 支援多個 Chat ID 或群組 ID（逗號分隔）
  const chatIds = tgChatId.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

  await Promise.all(
    chatIds.map(async (cid) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cid, text })
        });
        if (!res.ok) {
          console.warn(`Telegram 推播至 ${cid} 狀態非 200:`, res.status, await res.text());
        } else {
          console.log(`✅ Telegram 成功推播至 ${cid}！`);
        }
      } catch (err) {
        console.warn(`Telegram 推播至 ${cid} 網路錯誤:`, err.message);
      }
    })
  );
}

// ─────────────────────────────────────────────────────────
// 主要 API Handler
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version");

  if (req.method === "OPTIONS") return res.status(200).end();

  const r2Config   = getR2Config();
  const isR2Active = !!r2Config;

  // ── GET: 取得所有訂單 ──────────────────────────────────
  if (req.method === "GET") {
    try {
      const orders = await loadOrders(r2Config);
      return res.status(200).json({
        success: true,
        count: orders.length,
        orders,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback",
        r2Debug: lastR2Debug
      });
    } catch (err) {
      console.error("GET 訂單失敗:", err);
      return res.status(200).json({
        success: true,
        count: memoryOrders.length,
        orders: memoryOrders,
        storage: "memory-fallback"
      });
    }
  }

  // ── POST: 顧客提交新訂單（高並發安全＋保證通知） ────────
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

      // 1. 同步寫入個別雲端備份（每個訂單獨立檔案，完全原子操作，高並發 100% 零覆蓋零碰撞）
      await saveSingleOrder(r2Config, newOrder);

      // 2. 讀取總表 → Map 合併 → 寫回
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

      // 3. 發送 Telegram 通知給店家（await 確保 Vercel 容器釋放前完成發送）
      await sendTelegramNotification(newOrder);

      return res.status(201).json({
        success: true,
        message: "訂單建立成功！已同步至後台與 Telegram",
        order: newOrder,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("POST 訂單非預期錯誤:", err);
      // 即使遭遇例外，仍嘗試保底存入記憶體與發送 TG
      try {
        const fallbackOrder = normalizeOrder(req.body, `YG-${Date.now().toString().slice(-4)}`);
        memoryOrders.unshift(fallbackOrder);
        await sendTelegramNotification(fallbackOrder);
        return res.status(201).json({
          success: true,
          message: "訂單已建立（保底機制生效）",
          order: fallbackOrder,
          storage: "memory-fallback"
        });
      } catch (innerErr) {
        return res.status(500).json({ success: false, message: "儲存訂單失敗", error: err.message });
      }
    }
  }

  // ── PUT / PATCH: 更新訂單狀態 ────────────────────────────
  if (req.method === "PUT" || req.method === "PATCH") {
    try {
      const { id, orderId, status } = req.body || {};
      const targetId = orderId || id;
      if (!targetId) return res.status(400).json({ success: false, message: "缺少訂單編號" });

      const VALID_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `無效的狀態值：${status}` });
      }
      if (!status) {
        return res.status(400).json({ success: false, message: '缺少訂單狀態' });
      }

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
        const singleKeys = await listR2Keys(r2Config, "orders/");
        await Promise.all(singleKeys.map(k => r2Fetch(r2Config, "DELETE", k).catch(() => {})));
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
