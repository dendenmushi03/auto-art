// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { exec } from "child_process";
import Stripe from "stripe";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import { fileURLToPath } from "url";

import { connectDB } from "./config/db.js";
import { Artwork } from "./models/Artwork.js";
import { AdSlot } from "./models/AdSlot.js";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const generatedDir = path.join(publicDir, "generated");
const legacyGeneratedDir = path.join(__dirname, "generated");

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
let serverInstance = null;
let isShuttingDown = false;
let isBooting = false;

const BOOT_RETRY_DELAY_MS = Math.max(
  1000,
  Number.parseInt(process.env.BOOT_RETRY_DELAY_MS || "10000", 10) || 10000
);

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function safeShutdown(reason, err) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.error(`[fatal] ${reason}`);
  if (err) {
    console.error("[fatal] details:", err);
  }

  if (autoGenerateTimer) {
    clearInterval(autoGenerateTimer);
    autoGenerateTimer = null;
  }

  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }

  try {
    await mongoose.connection.close(false);
  } catch (closeErr) {
    console.error("[fatal] mongo close error:", closeErr);
  }

  process.exit(1);
}

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
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(publicDir, "app.html")));

// 静的配信（/public 配下を公開）
app.use(express.static(publicDir));

// /generated を明示的に公開（画像）
app.use("/generated", express.static(generatedDir));
// 旧保存先 generated/ も後方互換で公開
app.use("/generated", express.static(legacyGeneratedDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "auto-art", nodeEnv, isProduction });
});

// ---- DB ----
mongoose.connection.on("error", (err) => {
  console.error("[db] connection error:", err);
});
mongoose.connection.on("disconnected", () => {
  console.error("[db] disconnected");
});

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
  fs.mkdirSync(generatedDir, { recursive: true });

  return new Promise((resolve, reject) => {
    exec(`${PYTHON_CMD} generate_art.py`, { cwd: __dirname }, (err, stdout, stderr) => {
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

function getImageCandidatePaths(imageUrl) {
  if (!imageUrl) return [];

  const normalizedImageUrl = String(imageUrl).replace(/\\/g, "/");
  const relativePath = normalizedImageUrl.startsWith("/")
    ? normalizedImageUrl.slice(1)
    : normalizedImageUrl;

  return [
    path.join(publicDir, relativePath),
    path.join(__dirname, relativePath),
  ];
}

function resolveExistingImagePath(imageUrl) {
  const candidates = getImageCandidatePaths(imageUrl);
  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    exists: Boolean(existingPath),
    path: existingPath || candidates[0] || null,
    candidates,
  };
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
async function cleanupExpired(nowUtc) {
  const expiringArtworks = await Artwork.find({
    status: "for_sale",
    expiresAt: { $lte: nowUtc },
  })
    .select("_id adSlotId")
    .lean();

  const expiringArtworkIds = expiringArtworks.map((a) => a._id);
  const linkedAdSlotIds = expiringArtworks.map((a) => a.adSlotId).filter(Boolean);

  console.log(
    `[cleanup] start nowUtc=${nowUtc.toISOString()} expiringArtworks=${expiringArtworkIds.length} linkedAdSlots=${linkedAdSlotIds.length}`
  );

  // 期限切れ artwork を burned
  if (expiringArtworkIds.length > 0) {
    const artworkUpdateResult = await Artwork.updateMany(
      { _id: { $in: expiringArtworkIds } },
      {
        $set: {
          status: "burned",
          unlistedAt: nowUtc,
          unlistedReason: "expired_listing_utc",
        },
      }
    );
    console.log(
      `[cleanup] burned artworks count=${artworkUpdateResult.modifiedCount} ids=${expiringArtworkIds.join(",")}`
    );
  }

  // burned化された作品に紐づく active AdSlot も期限切れにする（整合性担保）
  if (linkedAdSlotIds.length > 0) {
    const adSlotUpdateResult = await AdSlot.updateMany(
      { _id: { $in: linkedAdSlotIds }, status: "active" },
      { $set: { status: "expired", endsAt: nowUtc } }
    );
    console.log(
      `[cleanup] expired linked ad slots count=${adSlotUpdateResult.modifiedCount} ids=${linkedAdSlotIds.join(",")}`
    );
  }

  // 期限切れ AdSlot を expired
  const expiredSlotsResult = await AdSlot.updateMany(
    { status: "active", endsAt: { $lte: nowUtc } },
    { $set: { status: "expired" } }
  );
  console.log(`[cleanup] expired active ad slots count=${expiredSlotsResult.modifiedCount}`);
  console.log("[cleanup] end");
}

async function generateNewArtwork({ force = false } = {}) {
  const nowUtc = new Date();

  console.log(`[generate] start force=${force} nowUtc=${nowUtc.toISOString()}`);

  // まず期限切れ掃除
  await cleanupExpired(nowUtc);

  // force=false のときは「現在販売中」があるなら生成しない
  if (!force) {
    const activeForSale = await Artwork.findOne({
      status: "for_sale",
      createdAt: { $lte: nowUtc },
      expiresAt: { $gt: nowUtc },
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
  const expiresAt = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);

  const doc = await Artwork.create({
    title: "Abstract Artwork",
    prompt: "Python generative abstract art",
    imageUrl,
    price,
    currency: "jpy",
    status: "for_sale",
    stripeProductId: product.id,
    stripePriceId: stripePrice.id,
    createdAt: nowUtc,
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

  console.log(`[generate] created artworkId=${doc._id.toString()} imageUrl=${imageUrl} price=${price} expiresAt=${expiresAt.toISOString()}`);
  console.log("[generate] end");
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
  const nowUtc = new Date();

  if (!isDbConnected()) {
    console.error("[/api/current] db unavailable", {
      readyState: mongoose.connection.readyState,
      nowUtc: nowUtc.toISOString(),
    });
    return res.status(503).json({
      artwork: null,
      ad: null,
      error: "database_unavailable",
      message: "現在データベースに接続できません。しばらくしてから再試行してください。",
    });
  }

  try {
    // for_sale かつ販売期間内（UTC基準）
    let artwork = await Artwork.findOne({
      status: "for_sale",
      createdAt: { $lte: nowUtc },
      expiresAt: { $gt: nowUtc },
    })
      .sort({ createdAt: -1 })
      .populate("adSlotId") // Artwork側でref設定必須
      .lean();

    if (!artwork) {
      return res.json({
        artwork: null,
        ad: null,
        message: "現在公開中の作品はありません。次の出品をお待ちください。",
      });
    }

    const imageCheck = resolveExistingImagePath(artwork.imageUrl);
    if (!imageCheck.exists) {
      console.error("[/api/current] artwork image file missing. keeping listing unchanged.", {
        artworkId: artwork._id?.toString?.() || artwork._id,
        imageUrl: artwork.imageUrl,
        candidates: imageCheck.candidates,
      });

      return res.status(503).json({
        artwork: null,
        ad: null,
        error: "artwork_image_missing",
        message: "現在の販売画像を取得できません。しばらくしてから再試行してください。",
      });
    }

    let ad = null;
    if (artwork?.adSlotId) {
      const slot = artwork.adSlotId;
      const inTime =
        slot.status === "active" &&
        slot.startsAt &&
        slot.endsAt &&
        nowUtc >= new Date(slot.startsAt) &&
        nowUtc <= new Date(slot.endsAt);

      if (inTime && slot.ad) {
        ad = slot.ad;
      }
    }

    return res.json({ artwork, ad });
  } catch (err) {
    console.error("[/api/current] failed:", err);
    return res.status(500).json({
      artwork: null,
      ad: null,
      error: "current_fetch_failed",
      message: "現在作品情報の取得に失敗しました。時間をおいて再試行してください。",
    });
  }
});


app.get("/api/debug/current-file", async (req, res) => {
  try {
    const nowUtc = new Date();
    const artwork = await Artwork.findOne({
      status: "for_sale",
      createdAt: { $lte: nowUtc },
      expiresAt: { $gt: nowUtc },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!artwork?.imageUrl) {
      return res.json({ exists: false, path: null, imageUrl: null, reason: "no_current_artwork" });
    }

    const imageCheck = resolveExistingImagePath(artwork.imageUrl);

    return res.json({
      exists: imageCheck.exists,
      path: imageCheck.path,
      candidates: imageCheck.candidates,
      imageUrl: artwork.imageUrl,
    });

  } catch (err) {
    console.error("[/api/debug/current-file] failed:", err);
    return res.status(500).json({ error: "debug_current_file_failed", message: err.message });
  }
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

async function boot() {
  if (isBooting || serverInstance) {
    return;
  }

  isBooting = true;

  try {
    await connectDB(process.env.MONGODB_URI);
    serverInstance = app.listen(port, () => {
      console.log("Server started on port", port);
      console.log(`[boot] PORT=${port} NODE_ENV=${nodeEnv} isProduction=${isProduction} hasDevSecret=${hasDevSecret}`);
      startAutoGenerateLoopIfEnabled();
    });
  } catch (err) {
    console.error(`[boot] failed. retrying in ${BOOT_RETRY_DELAY_MS}ms`);
    console.error("[boot] details:", err);

    setTimeout(() => {
      boot();
    }, BOOT_RETRY_DELAY_MS);
  } finally {
    isBooting = false;
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[runtime] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  safeShutdown("uncaughtException", err);
});

boot();
