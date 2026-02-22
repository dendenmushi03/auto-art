// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { exec } from "child_process";
import Stripe from "stripe";
import crypto from "crypto";
import path from "path";

import { connectDB } from "./config/db.js";
import { Artwork } from "./models/Artwork.js";
import { AdSlot } from "./models/AdSlot.js";

dotenv.config();

const app = express();
const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const hasDevSecret = !!process.env.DEV_SECRET;

// ---- 必須ENVチェック（起動時に即気づける）----
const REQUIRED_ENVS = [
  "MONGODB_URI",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "FRONTEND_URL",
  "CRON_SECRET",
];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.warn(`[WARN] Missing env: ${k}`);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const AUTO_GENERATE = String(process.env.AUTO_GENERATE || "").toLowerCase() === "true";
const AUTO_GENERATE_INTERVAL_SEC = Math.max(
  5,
  Number.parseInt(process.env.AUTO_GENERATE_INTERVAL_SEC || "60", 10) || 60
);

let isGeneratingArtwork = false;
let autoGenerateTimer = null;

// ======================================================
// 1) Stripe Webhook（raw body 必須）
// ======================================================
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is missing");
    return res.status(500).send("Webhook secret not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const artworkId = session.metadata?.artworkId;
      const adToken = session.metadata?.adToken; // ← 選択肢1：Checkout metadata token

      if (!artworkId) {
        console.warn("[webhook] missing artworkId in metadata");
        return res.json({ received: true });
      }

      // 作品を sold に
      await Artwork.findByIdAndUpdate(artworkId, {
        status: "sold",
        soldAt: new Date(),
      });

      // AdSlot を作成（Webhookはリトライされるので二重作成防止）
      if (adToken) {
        const tokenHash = crypto.createHash("sha256").update(adToken).digest("hex");

        // soldArtworkId をキーに冪等化（すでにあれば作らない）
        const existing = await AdSlot.findOne({ soldArtworkId: artworkId });
        if (!existing) {

await AdSlot.create({
  tokenHash,
  soldArtworkId: artworkId,
  status: "pending",
  ad: { title: "", linkUrl: "", body: "" },
});

        }
      }

      console.log("[webhook] sold artwork:", artworkId);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[webhook] handler error:", err);
    // webhookはStripe側がリトライする可能性があるので 500 を返す
    return res.status(500).send("Webhook handler failed");
  }
});

// ======================================================
// 2) 通常ルート用ミドルウェア
// ======================================================
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "public", "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(process.cwd(), "public", "app.html")));
app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "auto-art", nodeEnv, isProduction });
});

// ---- DB ----
connectDB(process.env.MONGODB_URI);

// ======================================================
// 3) ユーティリティ
// ======================================================
function getRandomPrice() {
  const min = 500;
  const max = 10000;
  const step = 100;
  const steps = Math.floor((max - min) / step) + 1;
  const n = Math.floor(Math.random() * steps);
  return min + n * step;
}

const PYTHON_CMD = process.env.PYTHON_CMD || "python";

function generateArtWithPython() {
  return new Promise((resolve, reject) => {
    exec(`${PYTHON_CMD} generate_art.py`, (err, stdout, stderr) => {
      if (err) {
        console.error("Python error:", err, stderr);
        return reject(err);
      }
      const relPath = String(stdout || "").trim(); // generated/xxx.png
      if (!relPath || !relPath.startsWith("generated/")) {
        if (stderr) {
          console.error("Python stderr:", stderr);
        }
        return reject(new Error(`Invalid python output: "${relPath}"`));
      }
      resolve(relPath);
    });
  });
}

// URLバリデーション（購入者入力広告）
function normalizeUrl(url) {
  if (!url) return "";
  const s = String(url).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
if (u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

// ======================================================
// 4) 新作生成ロジック（3時間スロット制 + AdSlot割当）
// ======================================================
async function cleanupExpired(now) {
  const expiringArtworks = await Artwork.find({
    status: "for_sale",
    expiresAt: { $lte: now },
  })
    .select("_id adSlotId")
    .lean();

  const expiringArtworkIds = expiringArtworks.map((a) => a._id);
  const linkedAdSlotIds = expiringArtworks.map((a) => a.adSlotId).filter(Boolean);

  // 期限切れ artwork を burned
  if (expiringArtworkIds.length > 0) {
    await Artwork.updateMany(
      { _id: { $in: expiringArtworkIds } },
      { $set: { status: "burned" } }
    );
  }

  // burned化された作品に紐づく active AdSlot も期限切れにする（整合性担保）
  if (linkedAdSlotIds.length > 0) {
    await AdSlot.updateMany(
      { _id: { $in: linkedAdSlotIds }, status: "active" },
      { $set: { status: "expired", endsAt: now } }
    );
  }

  // 期限切れ AdSlot を expired
  await AdSlot.updateMany(
    { status: "active", endsAt: { $lte: now } },
    { $set: { status: "expired" } }
  );
}

async function generateNewArtwork({ force = false } = {}) {
  const now = new Date();

  // まず期限切れ掃除
  await cleanupExpired(now);

  // force=false のときは「現在販売中」があるなら生成しない
  if (!force) {
    const activeForSale = await Artwork.findOne({
      status: "for_sale",
      createdAt: { $lte: now },
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (activeForSale) {
      console.log("まだ販売期間内のため、新作生成はスキップ");
      return null;
    }
  }

  // 1) Pythonで生成
  const relPath = await generateArtWithPython();
  const imageUrl = "/" + relPath.replace(/\\/g, "/");

  // 2) 価格
  const price = getRandomPrice();

  // 3) Stripe product/price
  const product = await stripe.products.create({
    name: "Auto Abstract Art",
    metadata: { service: "auto_art" },
  });

  const stripePrice = await stripe.prices.create({
    product: product.id,
    unit_amount: price, // JPYは最小単位が円
    currency: "jpy",
  });

  // 4) DB保存
  const expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const doc = await Artwork.create({
    title: "Abstract Artwork",
    prompt: "Python generative abstract art",
    imageUrl,
    price,
    currency: "jpy",
    status: "for_sale",
    stripeProductId: product.id,
    stripePriceId: stripePrice.id,
    createdAt: now,
    expiresAt,

    // 広告枠
    adSlotAssigned: false,
    adSlotId: null,
  });

  // 5) pending AdSlot があれば “次作品” として割当
  const slot = await AdSlot.findOne({ status: "pending" }).sort({ createdAt: 1 });
  if (slot) {
    doc.adSlotAssigned = true;
    doc.adSlotId = slot._id;
    await doc.save();

    slot.assignedArtworkId = doc._id;
    slot.startsAt = doc.createdAt;
    slot.endsAt = doc.expiresAt;
    slot.status = "active";
    await slot.save();

    console.log("[ad] slot assigned:", slot._id.toString(), "-> artwork", doc._id.toString());
  }

  console.log("新作生成:", doc._id.toString(), imageUrl, price);
  return doc;
}

async function generateNewArtworkWithLock(source, { force = false } = {}) {
  if (isGeneratingArtwork) {
    console.log(`[generate] skip (${source}): generation is already running`);
    return null;
  }

  isGeneratingArtwork = true;
  try {
    return await generateNewArtwork({ force });
  } finally {
    isGeneratingArtwork = false;
  }
}

async function runAutoGenerateCheck(source) {
  try {
    await generateNewArtworkWithLock(source);
  } catch (err) {
    console.error(`[auto-generate] ${source} error:`, err.message);
  }
}

function startAutoGenerateLoopIfEnabled() {
  if (!AUTO_GENERATE) {
    return;
  }

  if (isProduction) {
    console.log("[auto-generate] NODE_ENV=production; in-process scheduler is disabled");
    return;
  }

  console.log(
    `[auto-generate] enabled (interval=${AUTO_GENERATE_INTERVAL_SEC}s). Initial check will run now.`
  );

  // 起動時に「販売中が無い」場合は即作成
  runAutoGenerateCheck("startup");

  // 以降は定期チェック（3時間ロールオーバー後にのみ生成）
  autoGenerateTimer = setInterval(() => {
    runAutoGenerateCheck("interval");
  }, AUTO_GENERATE_INTERVAL_SEC * 1000);
}

// ======================================================
// 5) API：現在販売中の作品 + 表示する広告
// ======================================================
app.get("/api/current", async (req, res) => {
  const now = new Date();

  // for_sale かつ販売期間内
  const artwork = await Artwork.findOne({
    status: "for_sale",
    createdAt: { $lte: now },
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .populate("adSlotId") // Artwork側でref設定必須
    .lean();

  let ad = null;
  if (artwork?.adSlotId) {
    const slot = artwork.adSlotId;
    const inTime =
      slot.status === "active" &&
      slot.startsAt &&
      slot.endsAt &&
      now >= new Date(slot.startsAt) &&
      now <= new Date(slot.endsAt);

    if (inTime && slot.ad) {
      ad = slot.ad;
    }
  }

  res.json({ artwork, ad });
});

// ======================================================
// 6) API：Stripe Checkout Session 作成（adToken付与）
// ======================================================
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { artworkId } = req.body;

    const artwork = await Artwork.findById(artworkId);
    if (!artwork || artwork.status !== "for_sale") {
      return res.status(400).json({ error: "この作品は購入できません" });
    }

    // 選択肢1：tokenをCheckout metadataに入れる
    const adToken = crypto.randomBytes(32).toString("hex");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: artwork.stripePriceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      metadata: {
        artworkId: artwork._id.toString(),
        adToken,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ error: "failed to create checkout session" });
  }
});

// ======================================================
// 7) API：success.html用 “広告編集リンク” を返す（session_idから復元）
// ======================================================
app.get("/api/ad-edit-link", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // paid のみ
    if (session.payment_status !== "paid") {
      return res.status(403).json({ error: "payment not completed" });
    }

    const token = session.metadata?.adToken;
    if (!token) return res.status(404).json({ error: "token not found" });

    res.json({
      editUrl: `${process.env.FRONTEND_URL}/ad-edit.html?token=${token}`,
    });
  } catch (err) {
    console.error("ad-edit-link error:", err);
    res.status(500).json({ error: "failed to get ad edit link" });
  }
});

// ===== API：広告枠の状態/内容を取得（ad-edit.html が使う）=====
app.get("/api/ad/me", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "missing token" });

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const slot = await AdSlot.findOne({ tokenHash }).lean();

    if (!slot) return res.status(403).json({ error: "invalid token" });

    // 必要最低限だけ返す（安全）
    return res.json({
      status: slot.status,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      assignedArtworkId: slot.assignedArtworkId,
      ad: slot.ad || { title: "", linkUrl: "", body: "" },
      updatedAt: slot.updatedAt,
    });
  } catch (err) {
    console.error("ad/me error:", err);
    return res.status(500).json({ error: "failed to fetch ad slot" });
  }
});


// ======================================================
// 8) API：購入者が広告を登録/更新（token認証）
// ======================================================
app.post("/api/ad/submit", async (req, res) => {
  try {
    const { token, title, linkUrl, body } = req.body;
    if (!token) return res.status(400).json({ error: "missing token" });

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");

    const slot = await AdSlot.findOne({ tokenHash });
    if (!slot) return res.status(403).json({ error: "invalid token" });
    if (slot.status === "expired") return res.status(403).json({ error: "ad slot expired" });

    const safeTitle = String(title || "").trim().slice(0, 60);
    const safeBody = String(body || "").trim().slice(0, 200);
    const safeUrl = normalizeUrl(linkUrl);

    slot.ad = {
      title: safeTitle,
      linkUrl: safeUrl,
      body: safeBody,
    };

    await slot.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("ad/submit error:", err);
    res.status(500).json({ error: "failed to submit ad" });
  }
});

// ======================================================
// 9) cron（本番運用: 外部cronから3時間ごとに叩く）
// ローカル開発は AUTO_GENERATE=true で in-process の定期チェックを有効化できる
// ======================================================
app.post("/cron/run", async (req, res) => {
  if (!isProduction) {
    return res.status(400).json({ error: "cron is production-only; use /dev/generate-now in local" });
  }

  const key = req.headers["x-cron-key"];
  if (key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const doc = await generateNewArtworkWithLock("cron");
    res.json({ ok: true, created: !!doc, artworkId: doc?._id });
  } catch (err) {
    console.error("cron error:", err);
    res.status(500).json({ error: "cron failed", message: err.message });
  }
});

if (!isProduction) {
  app.post("/dev/generate-now", async (req, res) => {
    const devSecret = process.env.DEV_SECRET;
    if (!devSecret) {
      return res
        .status(500)
        .json({ error: "DEV_SECRET is not configured. Set DEV_SECRET in .env and restart Node." });
    }

    const key = req.headers["x-dev-key"];
    if (!key) {
      return res.status(403).json({ error: "missing x-dev-key header" });
    }
    if (key !== devSecret) {
      return res.status(403).json({ error: "invalid x-dev-key" });
    }

    try {
      const doc = await generateNewArtworkWithLock("dev-force", { force: true });
      return res.json({ ok: true, created: !!doc, artworkId: doc?._id });
    } catch (err) {
      console.error("dev generate error:", err);
      return res.status(500).json({ error: "failed to generate now", message: err.message });
    }
  });
}

// ======================================================
// 10) 起動
// ======================================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
  console.log(`[boot] PORT=${port} NODE_ENV=${nodeEnv} isProduction=${isProduction} hasDevSecret=${hasDevSecret}`);
  startAutoGenerateLoopIfEnabled();
});
