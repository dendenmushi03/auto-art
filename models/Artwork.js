// models/Artwork.js
import mongoose from "mongoose";

const artworkSchema = new mongoose.Schema({
  title: String,
  imageUrl: String,      // /generated/xxx.png 形式
  prompt: String,
  price: Number,
  currency: { type: String, default: "jpy" },
  status: {
    type: String,
    enum: ["for_sale", "sold", "burned"],
    default: "for_sale",
  },

  // Stripe
  stripeProductId: String,
  stripePriceId: String,

  // Time
  createdAt: { type: Date, default: Date.now },
  expiresAt: Date,
  soldAt: Date,
  unlistedAt: { type: Date, default: null },
  unlistedReason: { type: String, default: "" },

  // --- Ads (NEW) ---
  adSlotAssigned: { type: Boolean, default: false },
  adSlotId: { type: mongoose.Schema.Types.ObjectId, ref: "AdSlot", default: null },
});

export const Artwork = mongoose.model("Artwork", artworkSchema);
