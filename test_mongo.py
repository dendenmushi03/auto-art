import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

uri = os.getenv("MONGODB_URI")
if not uri:
    raise SystemExit("❌ MONGODB_URI が .env に設定されていません")

client = MongoClient(uri)
db = client["auto_art"]

db.command("ping")

print("✅ MongoDB 接続OK（ping成功）")
