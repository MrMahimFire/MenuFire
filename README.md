# Menu Fire — মাল্টিপ্লেয়ার সার্ভার (সম্পূর্ণ বাংলা গাইড)

Node.js সার্ভার: গেমের WebSocket (WSS), Firebase লগইন যাচাই, প্রোফাইল/কয়েন/ডায়মন্ড Firebase Realtime Database-এ সেভ, অ্যাডমিন API ও ড্যাশবোর্ড, ভয়েস-কলের সিগন্যালিং।

## ⚠️ আগে জেনে নিন (সৎ নোট)
| বিষয় | অবস্থা |
|---|---|
| Socket.IO | **ব্যবহার করিনি।** আপনার অ্যাপের ক্লায়েন্ট সাধারণ WebSocket-এ লেখা। Socket.IO নিলে অ্যাপে বাড়তি লাইব্রেরি লাগত ও চালু ক্লায়েন্ট ভাঙত। Render WSS সাপোর্ট করে, তাই সরাসরি WebSocket-ই চলছে। |
| Express | **ব্যবহার করিনি।** আমার কাজের জায়গায় npm রেজিস্ট্রি বন্ধ ছিল, তাই Express ইনস্টল করে পরীক্ষা করা যেত না। `lib/mini.js` এ ছোট Express-ধাঁচের রাউটার আছে (একই `(req,res,next)` আকার), পুরোটা পরীক্ষিত। চাইলে পরে Express-এ বদলানো সহজ। |
| `firebase-admin` | কোড লেখা হয়েছে, কিন্তু **আসল Firebase-এর সাথে এখানে চালানো যায়নি** (ইন্টারনেট/রেজিস্ট্রি নেই)। টেস্টে নকল (fake) যাচাইকারী ব্যবহার হয়েছে। প্রথম ডেপ্লয়ের পর নিচের "ডেপ্লয় যাচাই" ধাপ করুন। |
| পরীক্ষিত | `npm test` → ২৩টি টেস্ট পাস; অ্যাপের আসল Java ক্লায়েন্ট (দুটি Game) এই সার্ভারের সাথে ১v১ খেলে পাস। |
| অপরীক্ষিত | আসল Firebase, Render-এ চালানো, ফোনে `wss://` (TLS), ৫০ জনের লোড, WebRTC (অ্যাপের দিক লেখা হয়নি)। |
| TURN | আলাদা সার্ভিস, ফ্রি নয় (`android/VOICE.md`)। |

## ফিচার তালিকা (কোথায় কী)
- লগইন/প্রোফাইল: `sockets/game.js` (`hello`, `setname`) + `services/store.js` — নাম ৩–১২ অক্ষর, ইউনিক (Realtime DB transaction), একবারই বদলায়।
- রুম/ম্যাচমেকিং: BR (৫০), CS (৪v৪), ১v১; কিউ → কাউন্টডাউন → `ready` → শুরু।
- পজিশন/রোটেশন সিঙ্ক ১০Hz, join/leave ইভেন্ট, হেলথ সিঙ্ক, প্লেন/প্যারাশুট/জোন/রাউন্ড।
- **সার্ভারে যাচাই**: ড্যামেজ, রেঞ্জ, ফায়ার-রেট, টিমমেট ড্যামেজ নেই, প্যারাশুটে ড্যামেজ নেই; কয়েন/XP/স্কোর শুধু সার্ভার দেয়।
- অ্যান্টি-চিট: টেলিপোর্ট/স্পিড-হ্যাক রিজেক্ট (বারবার করলে কিক), বার্তার সীমা, রেট লিমিট, ইনপুট যাচাই।
- রিকানেকশন: ম্যাচ চলাকালীন নেট গেলে ৩০ সেকেন্ড স্লট রাখা হয়; একই টোকেন দিয়ে `hello` করলে `start…`, `rejoin` সহ ফেরত পায়। *(সার্ভার পরীক্ষিত। অ্যাপে অটো-রিকানেক্ট এখনো যুক্ত করিনি — এখন নেট গেলে "CONNECTION LOST" দেখায়।)*
- হার্টবিট: সার্ভার প্রতি ২০ সেকেন্ডে WebSocket ping, ৬০ সেকেন্ড চুপ থাকলে বিচ্ছিন্ন; ক্লায়েন্ট `ping <t>` → `pong <t>` দিয়ে লেটেন্সি মাপতে পারে।
- ম্যাচ রেজাল্ট: `matches/` এ সেভ।
- লগ: `/api/admin/logs`, সিক্রেট মাস্ক করা।

## ১. Firebase সেটআপ
1. [Firebase Console](https://console.firebase.google.com) → প্রজেক্ট `menufire-bd`।
2. **Authentication → Sign-in method**: Anonymous, Email/Password, Google চালু করুন। (গেস্ট এরর এখানেই ঠিক হয়।)
3. **Realtime Database** আছে (URL: `https://menufire-bd-default-rtdb.firebaseio.com`)। Rules-এ `database.rules.json` এর মতো সব বন্ধ রাখুন (`.read:false, .write:false`)। সার্ভার Admin SDK দিয়ে ঢোকে, rules এড়িয়ে যায়; অ্যাপ সরাসরি ডেটাবেস ছোঁয় না।
4. **Project settings → Service accounts → Generate new private key** → একটি JSON ফাইল নামবে। **এটা কাউকে দেবেন না, GitHub এ দেবেন না, অ্যাপে রাখবেন না।**
5. ফাইলটিকে base64 করুন: Linux/Termux: `base64 -w0 serviceAccount.json` — আউটপুট `FIREBASE_SERVICE_ACCOUNT_B64` এ বসবে।
6. **Project settings → General → Web API Key** → `FIREBASE_WEB_API_KEY` (শুধু অ্যাডমিন পেজের লগইনে লাগে)।
7. আপনার নিজের UID (অ্যাপে Email/Password দিয়ে নিজের অ্যাকাউন্ট খুলে Authentication → Users থেকে দেখুন) → `ADMIN_UIDS`।

## ২. GitHub এ আপলোড
1. github.com → New repository → নাম `menufire-server` → **Private** রাখুন।
2. এই ফোল্ডারের সব ফাইল আপলোড করুন (`node_modules`, `.env`, service-account JSON **নয়** — `.gitignore` এগুলো আটকায়)। ওয়েবে: "Add file → Upload files"।
3. Commit করুন।

## ৩. Render এ ডেপ্লয়
1. [render.com](https://render.com) → New → **Web Service** → GitHub রিপো সংযুক্ত করুন।
2. Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Plan **Free**। (`render.yaml` থাকায় Blueprint ও চলবে।)
3. Advanced → Health Check Path: `/health`।
4. Environment Variables (`.env.example` দেখুন): `NODE_ENV=production`, `AUTH_MODE=firebase`, `FIREBASE_SERVICE_ACCOUNT_B64`, `FIREBASE_DATABASE_URL`, `FIREBASE_WEB_API_KEY`, `ADMIN_UIDS`। `PORT` Render নিজে দেয়।
5. Deploy। শেষ হলে URL পাবেন: `https://xxxx.onrender.com`।

### Render ফ্রি প্ল্যানের সীমা (render.com/docs/free থেকে যাচাই করা)
- ১৫ মিনিট কোনো ট্রাফিক না থাকলে সার্ভার ঘুমায়; জাগাতে প্রায় ১ মিনিট লাগে (প্রথম খেলোয়াড় অপেক্ষা করবে)। চালু WebSocket বার্তা সার্ভার জাগিয়ে রাখে।
- মাসে ৭৫০ ঘণ্টা; শেষ হলে মাস শেষ পর্যন্ত বন্ধ।
- ফাইল সিস্টেম **মুছে যায়** — তাই ডেটা Firebase-এ রাখা হয়েছে, সার্ভারের ফাইলে নয়।
- যেকোনো সময় রিস্টার্ট হতে পারে → চলমান ম্যাচ হারিয়ে যায় (প্রোফাইল ঠিক থাকে)।
- একটিই ইনস্ট্যান্স; ফ্রি মেশিন ছোট, ৫০ জনের BR তে ভারী হতে পারে।
- সব সময় সক্রিয় থাকবে বা ট্রাফিক সীমাহীন — এমন নয়। সিরিয়াস লঞ্চে paid plan লাগবে।

### ডেপ্লয় যাচাই
1. ব্রাউজারে `https://xxxx.onrender.com/health` → `{"ok":true,...,"db":"rtdb","auth":"firebase"}` দেখা উচিত (`db` অবশ্যই `rtdb`)।
2. Render Logs এ `Menu Fire server on …` আছে, কোনো `config:` এরর নেই।
3. `https://xxxx.onrender.com/admin/` খুলে অ্যাডমিন ইমেইল/পাসওয়ার্ডে ঢুকুন।
4. অ্যাপে `server.txt` = `wss://xxxx.onrender.com`, নতুন বিল্ড → গেস্ট লগইন → নাম দিন → Firebase Console এ `players/` এ ডেটা দেখুন।

## ৪. অ্যান্ড্রয়েড সংযোগ
`android/README.md` দেখুন (শুধু `server.txt` বদলাতে হয়)।

## ৫. Admin API
সব রিকোয়েস্টে `Authorization: Bearer <Firebase ID token>`। রোল সার্ভারে যাচাই হয় (`ADMIN_UIDS`, টোকেনের `admin:true` claim, অথবা ডেটাবেসে `admins/<uid> = true`)। ক্লায়েন্টের পাঠানো কোনো "isAdmin" গ্রাহ্য নয়।

| Method | পাথ | কাজ |
|---|---|---|
| GET | `/api/admin/overview` | সার্ভার হেলথ, মেমরি, অনলাইন, কনফিগ |
| GET | `/api/admin/players/online` | অনলাইন প্লেয়ার |
| GET | `/api/admin/rooms` | কিউ ও চলমান ম্যাচ |
| GET | `/api/admin/matches/recent?n=20` | শেষ ম্যাচের ফলাফল |
| GET | `/api/admin/players/:uid` | প্রোফাইল + ব্যান অবস্থা |
| POST | `/api/admin/players/:uid/ban` `{reason}` | ব্যান + কিক |
| POST | `/api/admin/players/:uid/unban` | আনব্যান |
| POST | `/api/admin/players/:uid/kick` | কিক |
| GET/PUT | `/api/admin/config` | `maintenance`(bool), `motd`, `minBR`, `minCS` |
| GET | `/api/admin/logs?level=error&n=100` | লগ |

অ্যাডমিন পেজ: `/admin/`। অন্য পাবলিক: `/health`, `/api/public-config`। অ্যাডমিন API রেট-লিমিটেড (৬০/মিনিট/IP)।

## ৬. পরীক্ষা চালানো
```
npm install      # firebase-admin আনে (টেস্টে লাগে না, শুধু প্রোডাকশনে)
npm test         # ২৩টি টেস্ট, ~৩০ সেকেন্ড, Node 18+ (WebSocket গ্লোবাল লাগে: Node 22 ভালো)
```
টেস্ট যা দেখে: সার্ভার চালু, `/health`, env যাচাই, প্রোডাকশনে ভুল কনফিগে বন্ধ হওয়া, অনুমোদন (WS ও অ্যাডমিন: 401/403/200), রুম তৈরি/জয়েন, পজিশন/শট/ড্যামেজ, ম্যাচ রেজাল্ট ও পুরস্কার সেভ, ভুল ইনপুট/ফ্লাড, রিকানেকশন, অ্যান্টি-চিট, CS/BR নিয়ম, ভয়েস সিগন্যালিং, ডেপ্লয় স্মোক (আসল প্রসেস চালিয়ে)।
**আসল Firebase দিয়ে কোনো টেস্ট নেই** — এটা আপনাকে ডেপ্লয়ের পর যাচাই করতে হবে।

লোকাল চালাতে: `AUTH_MODE=dev npm run dev` (লগইন যাচাই ছাড়া, **শুধু নিজের পিসিতে**, প্রোডাকশনে নিষিদ্ধ)।

## ৭. প্রোটোকল সংক্ষেপে
ক্লায়েন্ট→সার্ভার: `hello uid name idToken`, `setname N`, `queue MODE squad`, `ready`, `pos x y z yaw pitch weapon air`, `shot…`, `hit victim weapon head dist pellets`, `drop`, `ping t`, `leave`, `rtc …`
সার্ভার→ক্লায়েন্ট: `welcome id`, `profile…`, `lobby…`, `start…`, `p…`, `snap…`, `dmg…`, `kill…`, `end…`, `reward xp coins`, `pong t`, `err কারণ` (`auth|banned|maintenance|replaced|cheat|name_*`)।

## ফাইল কাঠামো
```
server.js           শুরু, ওয়্যারিং
config/             env পড়া ও যাচাই, weapons.json
services/           firebase (Admin SDK), store (RTDB/ফাইল/মেমরি), logger
middleware/         auth (অ্যাডমিন রোল), rateLimit
routes/             health, admin
sockets/            game (লজিক), ws (ফ্রেম), voice (WebRTC সিগন্যাল)
lib/mini.js         ছোট HTTP রাউটার
public/admin.html   ড্যাশবোর্ড
tests/              node --test
android/            অ্যান্ড্রয়েড নির্দেশনা, ভয়েস গাইড
```
