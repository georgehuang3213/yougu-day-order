// Vercel Serverless API for 優穀日 Order System
let orders = [
  {
    id: "YG-1001",
    customerName: "陳小姐",
    phone: "0912345678",
    pickupDate: "2026-10-02",
    pickupTime: "08:30",
    paymentMethod: "LINE Pay Money",
    needBag: false,
    discountCode: "折價20元",
    discountAmount: 20,
    items: [
      {
        id: "blueberry_bowl",
        name: "招牌自製藍莓燕麥優格碗",
        price: 130,
        qty: 1,
        options: ["100%無加糖鮮奶優格", "招牌自製藍莓果醬", "乾濕分離燕麥脆粒"]
      },
      {
        id: "extra_granola",
        name: "加購特製手作燕麥脆粒(袋裝)",
        price: 35,
        qty: 1,
        options: ["低溫烘焙香脆堅果"]
      }
    ],
    subtotal: 165,
    total: 145,
    note: "請附木湯匙，謝謝！",
    status: "new", // new, preparing, ready, completed, cancelled
    createdAt: new Date().toISOString()
  }
];

export default function handler(req, res) {
  // 允許 CORS
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // GET: 取得所有訂單
  if (req.method === "GET") {
    return res.status(200).json({
      success: true,
      count: orders.length,
      orders: orders
    });
  }

  // POST: 顧客提交新訂單
  if (req.method === "POST") {
    const data = req.body;
    if (!data || !data.customerName || !data.items || data.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "請提供完整的顧客資訊與訂單項目"
      });
    }

    const orderSeq = (orders.length + 1).toString().padStart(3, "0");
    const todayStr = new Date().toISOString().slice(5, 10).replace("-", "");
    const orderId = `YG-${todayStr}-${orderSeq}`;

    const newOrder = {
      id: orderId,
      customerName: data.customerName,
      phone: data.phone || "",
      pickupDate: data.pickupDate || "",
      pickupTime: data.pickupTime || "",
      paymentMethod: data.paymentMethod || "現金付款",
      needBag: !!data.needBag,
      discountCode: data.discountCode || "",
      discountAmount: Number(data.discountAmount) || 0,
      items: data.items,
      subtotal: Number(data.subtotal) || 0,
      total: Number(data.total) || 0,
      note: data.note || "",
      status: "new",
      createdAt: new Date().toISOString()
    };

    orders.unshift(newOrder); // 最新的排在最前面

    return res.status(201).json({
      success: true,
      message: "訂單建立成功！",
      order: newOrder
    });
  }

  // PUT / PATCH: 店家更新訂單狀態 (new -> preparing -> ready -> completed -> cancelled)
  if (req.method === "PUT" || req.method === "PATCH") {
    const { id, status } = req.body;
    const orderIndex = orders.findIndex(o => o.id === id);

    if (orderIndex === -1) {
      return res.status(404).json({ success: false, message: "找不到指定訂單" });
    }

    orders[orderIndex].status = status;
    orders[orderIndex].updatedAt = new Date().toISOString();

    return res.status(200).json({
      success: true,
      message: `訂單狀態已更新為：${status}`,
      order: orders[orderIndex]
    });
  }

  return res.status(405).json({ success: false, message: "Method Not Allowed" });
}
