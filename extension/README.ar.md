# جلب مجاني من متصفح المستخدم

هذه إضافة Manifest V3 بدون خدمة مدفوعة أو مفتاح API. المصدر هو صفحات أمازون العامة عبر اتصال كل مستخدم. تثبيت مرة واحدة على Chrome/Edge للكمبيوتر، ثم إعادة تحميل Creative Radaar. راجع `public/extension-install.html` للتعليمات.

الصلاحيات محددة بأربعة متاجر أمازون. content script يعمل فقط على `creative-raadar.vercel.app` وlocalhost:5173. لا cookies أو tabs أو storage permissions. جميع الطلبات `credentials: omit`، و`redirect: error` لمنع الانتقال لتسجيل الدخول. لا تقرأ حساب المستخدم. لا تحفظ نتائج. لا تتصل بخدمة Provider. يمنع العامل إرسال عنوان URL عشوائي؛ يقبل بحثًا أو ASIN فقط. حدود 25 ثانية/8MB للصفحة وتأخير 1.8 ثانية بين الطلبات. إلغاء البحث يوقف الطلب الجاري؛ كل بحث يحمل معرفًا مستقلًا.

يعرض حتى 50 فيديو من أول 20 منتجًا، مرتبة بعدد التقييمات، مع اشتراط دليل customer ومطابقة ASIN. الرقم سقف وليس ضمانًا. الحظر والتحقق البشري قد يحدثان أيضًا على اتصال المستخدم. لا يتم حلهما تلقائيًا. بيانات HTML ترجع للواجهة المحلية داخل المتصفح فقط؛ خدمة Railway الحالية تظل مسؤولة عن أكواد الدخول وبث الوسائط عند التشغيل والتنزيل.

حزمة ZIP تُبنى قبل نشر الواجهة بواسطة `npm run build:extension`. لا يتم تثبيت الإضافة أو منحها صلاحيات تلقائيًا. لم تُنشر في Chrome Web Store لأن حساب النشر له متطلبات منفصلة.

مراجع: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests وhttps://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world
