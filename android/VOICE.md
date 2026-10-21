# ভয়েস/ভিডিও কল (WebRTC)

**সার্ভারের অংশ তৈরি ও পরীক্ষিত**: `sockets/voice.js` শুধু SDP/ICE বার্তা রিলে করে (এক ম্যাচের খেলোয়াড়দের মধ্যে)।
**আসল অডিও/ভিডিও সার্ভারের ভেতর দিয়ে যায় না।** এগুলো খেলোয়াড়ের ফোন থেকে ফোনে (P2P) যায়; সরাসরি যোগাযোগ না হলে TURN সার্ভার লাগে।

- STUN: ফ্রি (ডিফল্ট `stun:stun.l.google.com:19302`)।
- TURN: **আলাদা সার্ভিস**, Render ফ্রি প্ল্যানে চলে না। Metered, Twilio বা নিজের coturn ভিডিও/ভয়েস ভালো করতে লাগবে। পেলে `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` সেট করুন।
- ৪–৮ জনের ভিডিও P2P মেশে ভারী; BR ৫০ জনে ভয়েস কল বাস্তবসম্মত নয় (স্কোয়াড ৪ জনে ঠিক আছে)। বড় দলে SFU (LiveKit ইত্যাদি) লাগে।

## প্রোটোকল (গেমের WebSocket-এই)
```
rtc config                  -> rtc config <base64 JSON iceServers>
rtc join / rtc leave        -> অন্যরা পায়: rtc peer_join <id> / rtc peer_leave <id>
rtc offer|answer|ice <toId> <base64>  -> গ্রাহক পায়: rtc offer|answer|ice <fromId> <base64>
rtc mute <0|1>              -> অন্যরা পায়: rtc mute <id> <0|1>
```

## অ্যান্ড্রয়েড দিক (এখনো লেখা হয়নি, পরীক্ষিতও নয়)
1. `app/build.gradle` এ: `implementation 'io.github.webrtc-sdk:android:125.6422.07'` (সংস্করণ নিজে যাচাই করুন)।
2. `RECORD_AUDIO` (এবং ভিডিওর জন্য `CAMERA`) permission ম্যানিফেস্টে ও রানটাইমে চাইতে হবে।
3. `PeerConnectionFactory` → `rtc config` থেকে ICE servers → প্রতি সঙ্গীর জন্য `PeerConnection`; offer/answer/ice উপরের বার্তা দিয়ে আদান-প্রদান।
এই অংশটা পরের প্যাচে করা যায়; এখন শুধু সার্ভার প্রস্তুত।
