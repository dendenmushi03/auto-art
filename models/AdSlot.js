// models/AdSlot.js
import mongoose from "mongoose";

const adSlotSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, index: true, unique: true },

    // この広告権を得た「購入作品」
    soldArtworkId: { type: mongoose.Schema.Types.ObjectId, ref: "Artwork", required: true },

    // 実際に広告が表示される「次作品」
    assignedArtworkId: { type: mongoose.Schema.Types.ObjectId, ref: "Artwork", default: null },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    status: { type: String, enum: ["pending", "active", "expired"], default: "pending" },

    // 入力内容（XSS回避のため “HTML” は許可しない設計）
    ad: {
      title: { type: String, default: "" },
      linkUrl: { type: String, default: "" },
      body: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

export const AdSlot = mongoose.model("AdSlot", adSlotSchema);
