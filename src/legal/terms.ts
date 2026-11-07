import { ANDROID_PACKAGE, APP_NAME, CONTACT_EMAIL, EFFECTIVE_DATE, PUBLISHER, renderLegalPage } from './renderLegalPage.js';

const ar = `<h1>شروط الاستخدام — ${APP_NAME}</h1>
<p class="meta">تاريخ السريان: ${EFFECTIVE_DATE} · التطبيق: ${APP_NAME} (حزمة أندرويد <span lang="en" dir="ltr">${ANDROID_PACKAGE}</span>) · الناشر: ${PUBLISHER}</p>

<h2>١. ما هو التطبيق</h2>
<p>${APP_NAME} تطبيق قارئ للروايات. الروايات والمحتوى من المصادر الخارجية مملوكة لأصحابها، والتطبيق أداة قراءة فقط ولا يدّعي ملكيتها.</p>

<h2>٢. الاستخدام المقبول</h2>
<p>يُمنع: المحتوى غير القانوني، والمضايقة أو خطاب الكراهية، والرسائل المزعجة (spam)، وإساءة استخدام التعليقات أو أي ميزة في التطبيق. أنت مسؤول عن المحتوى الذي تنشره (تعليقاتك ونبذتك واسمك وصورك).</p>

<h2>٣. حقنا في الإشراف</h2>
<p>يحق لنا إزالة أي محتوى مخالف أو تعليق مسيء، وتقييد الميزات أو تعليق الحسابات التي تسيء الاستخدام، دون إشعار مسبق عند الضرورة.</p>

<h2>٤. المصادر الخارجية</h2>
<p>قد يعرض التطبيق محتوى من مواقع خارجية تختارها. هذا المحتوى يخص أصحابه وشروط تلك المواقع تنطبق عليه، ونحن غير مسؤولين عنه.</p>

<h2>٥. المشتريات والاشتراكات (Pro)</h2>
<p>تُدفع جميع المشتريات والاشتراكات وتُدار عبر Google Play: الشراء والإلغاء والإدارة والاسترداد تتم من حسابك في Google Play وفق سياسة Google Play. حذف حسابك في ${APP_NAME} ينهي مزايا Pro المرتبطة به.</p>

<h2>٦. الخدمة «كما هي»</h2>
<p>تُقدَّم الخدمة «كما هي» دون أي ضمانات صريحة أو ضمنية، بما في ذلك استمرارية توفرها أو خلوّها من الأخطاء.</p>

<h2>٧. تغييرات الشروط</h2>
<p>قد نحدّث هذه الشروط من وقت لآخر؛ سننشر النسخة المحدّثة هنا مع تاريخ سريان جديد، واستمرارك في استخدام التطبيق يعني قبولك لها.</p>

<h2>٨. تواصل معنا</h2>
<p>لأي سؤال أو بلاغ عن إساءة استخدام راسلنا على: <a href="mailto:${CONTACT_EMAIL}" lang="en" dir="ltr">${CONTACT_EMAIL}</a></p>`;

const en = `<h1>${APP_NAME} Terms of Use</h1>
<p class="meta">Effective date: ${EFFECTIVE_DATE} · App: ${APP_NAME} (Android package ${ANDROID_PACKAGE}) · Publisher: ${PUBLISHER}</p>

<h2>1. What the app is</h2>
<p>${APP_NAME} is a novel reader app. Novels and content from external sources belong to their owners; the app is only a reading tool and claims no ownership of that content.</p>

<h2>2. Acceptable use</h2>
<p>Prohibited: illegal content, harassment or hate speech, spam, and abuse of comments or any app feature. You are responsible for the content you post (your comments, bio, name and images).</p>

<h2>3. Our right to moderate</h2>
<p>We may remove violating content or abusive comments, and restrict features or suspend accounts that abuse the service, without prior notice where necessary.</p>

<h2>4. Third-party sources</h2>
<p>The app may display content from external sites you choose. That content belongs to its owners and those sites' terms apply to it; we are not responsible for it.</p>

<h2>5. Purchases and subscriptions (Pro)</h2>
<p>All purchases and subscriptions are billed and managed through Google Play: purchase, cancellation, management and refunds happen in your Google Play account under Google Play policy. Deleting your ${APP_NAME} account ends the Pro entitlement attached to it.</p>

<h2>6. Service “as is”</h2>
<p>The service is provided “as is” without any express or implied warranties, including continued availability or freedom from errors.</p>

<h2>7. Changes to the terms</h2>
<p>We may update these terms from time to time; we will publish the updated version here with a new effective date, and your continued use of the app means you accept them.</p>

<h2>8. Contact us</h2>
<p>For any question or abuse report, email us at: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`;

export function termsPage(): string {
  return renderLegalPage(`شروط الاستخدام | Terms of Use`, ar, en);
}
