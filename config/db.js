// config/db.js
import mongoose from "mongoose";

export async function connectDB(uri) {
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: Number.parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || "10000", 10),
      connectTimeoutMS: Number.parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS || "10000", 10),
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error (full):", err);
    throw err;
  }
}
