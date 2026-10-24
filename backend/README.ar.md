# تشغيل مسار فيديوهات العملاء

الواجهة الحالية React وRTL. الباك الجديد Fastify مستقل، ويقرأ صفحات المنتجات العامة بمتصفح منفصل بلا حساب أمازون أو كوكيز مستخدم. الحد الحالي حسب المواصفات: أول 20 منتجًا، ترتيب بعدد التقييمات، فحص 10 منتجات بالتتابع، والتوقف عند 12 فيديو مختلفًا. الآراء السلبية والإيجابية مقبولة.

## تشغيل محلي

1. من جذر المشروع: `npm ci` ثم `npm --prefix backend ci`.
2. داخل `backend`: انسخ `.env.example` إلى `.env` واضبط الإعدادات؛ لا تضع مفاتيح في الفرونت.
3. نفّذ `npx playwright install chromium` من مجلد `backend` ثم `npm start`.
4. في إعدادات الواجهة اجعل `VITE_REVIEWS_API_URL=http://127.0.0.1:4320` ثم شغّل `npm run dev:frontend` من الجذر.
5. افتح `http://127.0.0.1:5173` واستخدم كود الدخول الحالي. جميع الأكواد الـ16 محفوظة كـdigests على الباك.

يتم تفعيل الواجهة الجديدة عند وجود `VITE_REVIEWS_API_URL`. بدون هذا المتغير يظل التطبيق السابق متاحًا حفاظًا على مساراته الحالية.

## الإعدادات

- `SOURCE=public|provider|auto`. auto يبدأ بالصفحة العامة ويجرّب الـProvider عند النتيجة الفارغة أو خطأ المصدر. المفتاح المجهول من المحادثة غير مستخدم.
- `PROXY_URL_US`, `PROXY_URL_EG`, `PROXY_URL_SA`, `PROXY_URL_AE`: بروكسي residential ثابت في بلد المتجر. `PROXY_URL` بديل لأمريكا فقط. يمكن تقديم بدائل مفصولة بفاصلة؛ تعاد المحاولة مرتين عند الحظر/التحقق وبمهلة متزايدة. لا تُحل CAPTCHA ولا تُستخدم جلسة حساب.
- `REQUIRE_PROXY=true` يمنع التشغيل دون إعداد بروكسي البلد. false يسمح بالاختبار المباشر؛ جودة residential وبلده مسؤولية مزود البروكسي ولا يستطيع التطبيق إثباتهما.
- `FRONTEND_ORIGINS`: قائمة عناوين الواجهة المسموح بها. أضف رابط الإنتاج/المعاينة المطلوب صراحة.
- `SESSION_SECRET`: سر ثابت طويل لاستمرار جلسات الأكواد بعد إعادة التشغيل. `ADMIN_KEY`: مفتاح تشخيص منفصل. لا يُرسلان للفرونت.
- `TRUST_PROXY=true` عند وجود reverse proxy واحد موثوق من منصة الاستضافة فقط، لاحتساب حدود الطلبات حسب IP العميل.
- `SUPABASE_URL` و`SUPABASE_SERVICE_KEY`: الكاش فقط. نفّذ `supabase.sql` في مشروعك. الجداول محمية بـRLS وممنوعة عن anon/authenticated؛ service-role في الباك فقط. بدون هذه الإعدادات يعمل كاش مؤقت في الذاكرة ويعلن `/health` ذلك.
- كاش المنتج 24 ساعة، النتيجة الفارغة المؤكدة 6 ساعات، والبحث ساعة. لا يتم حفظ ملفات الفيديو أو مشاريع المستخدمين. الحظر أو فشل قراءة الصفحة لا يُحفظان كعدم وجود فيديوهات.

## الـProvider

الخيار الافتراضي `PROVIDER_KIND=gateway` يحتاج `PROVIDER_API_URL` لخدمة HTTPS تتبع العقد التالي، و`PROVIDER_API_KEY`. الطلب POST، والمفتاح في Authorization Bearer:

```json
{"operation":"reviews","marketplace":"amazon.com","asin":"B012345678","media_reviews_only":true,"customer_reviews_only":true}
```

استجابة الريفيوهات: `{ "videos": [{"url":"https://m.media-amazon.com/...mp4","customerReview":true,"sourceAsin":"B012345678","title":"..."}] }`.

استدعاء البحث يرسل `{ "operation":"search", "query":"...", "marketplace":"amazon.com" }`، والاستجابة `{ "products": [{"asin":"...","title":"...","ratingsCount":1200,"rating":4.2}] }`.

`PROVIDER_KIND=unwrangle` يدعم API الرسمي الموثّق مع `PROVIDER_API_URL=https://data.unwrangle.com/api/getter/` لأمريكا. يطلب media_reviews_only بلا cookie. توثيق المزود نفسه يعتبر مسار المراجعات best-effort وقد لا يوفر أكثر من المراجعات العامة دون حساب؛ لم يُختبر بمفتاح حي، ولا يضمن العدد المطلوب. الدول الأخرى تحتاج gateway يدعمها فعلًا.

## النشر

الباك: اختر Railway أو Fly.io، واجعل root directory هو `backend` وابنِ Dockerfile. ملف `fly.toml` قالب قابل للتعديل؛ تحقق من توافر الاسم قبل الإنشاء. اضبط متغيرات الباك من لوحة الاستضافة. اختبر `GET /health` بعد النشر.

الواجهة: على Vercel أو Lovable ضع `VITE_REVIEWS_API_URL` بعنوان HTTPS الفعلي للباك وأعد البناء. لا تضع localhost في نسخة عامة. أضف عنوان الواجهة إلى `FRONTEND_ORIGINS` في الباك. يبقى البحث والمتصفح وmedia proxy خارج Vercel.

**لم يتم إنشاء استضافة مدفوعة أو تفعيل اشتراك.** Docker جاهز؛ التشغيل العام يحتاج حساب استضافة مُعدّ وعنوان باك فعليًا. لا يوجد ادعاء بأن Railway/Fly أو بروكسي residential أو Provider متاحون بلا تكلفة. إذا لم تُوفّر خدماتك إعدادات مجانية قائمة، يظل التشغيل المحلي هو المسار المتاح.

## API والتحقق

- `GET /api/search?q=...&marketplace=amazon.com&id=UUID`: Bearer جلسة الكود، وNDJSON. كل حدث يحمل id، وآخر سطر `{done:true,id,count}`. حد 10 عمليات بحث/دقيقة لكل IP.
- `GET /api/media?u=...&ticket=...`: روابط موقّعة قصيرة العمر، Range وHLS وallowlist ورفض redirects/DNS الداخلي. الملف يمر بالبث دون تخزين.
- `GET /api/debug/:asin?marketplace=amazon.com`: header `X-Admin-Key`؛ آخر status/count/error/duration/source. بدون المفتاح يعيد 403.
- `npm --prefix backend test` ثم `npm --prefix backend run check`، ومن الجذر `npm run lint` و`npm run build`.
- محددات DOM في `src/selectors.amazon.ts`، فُحصت على amazon.com في 24 أكتوبر 2026. تخطيطات مصر والسعودية والإمارات تحتاج تحققًا حيًا مستقلًا؛ لا يُعتبر غياب القسم إثباتًا بغياب الفيديوهات.

استخدام أمازون بالـscraping قد يخالف شروطها، والمصدر قابل للتبديل بـSOURCE.

توثيق Unwrangle: https://docs.unwrangle.com/amazon-product-reviews-api/ و https://docs.unwrangle.com/amazon-product-search-api/.
