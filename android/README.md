# Android সংযোগ (menufire অ্যাপ)

অ্যাপে নতুন কোড লাগে না — `patch10`/`menufire_full` এর ক্লায়েন্ট ইতিমধ্যে এই সার্ভারের প্রোটোকল বলে।

1. `app/src/main/assets/server.txt` ফাইলে শুধু একটি লাইন লিখুন:
   `wss://আপনার-সার্ভার.onrender.com`
2. `assets/firebase.json` = আপনার `google-services.json` (ইতিমধ্যে আছে)।
3. অ্যাপ লগইন করলে Firebase ID token সার্ভারে `hello <uid> <name> <idToken>` হিসেবে যায়; সার্ভার Admin SDK দিয়ে যাচাই করে।

`NetClient.java` এ `wss://` (TLS + SNI) আছে। ভয়েস/ভিডিও কলের জন্য `VOICE.md` দেখুন।
