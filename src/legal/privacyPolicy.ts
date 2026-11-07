import { ANDROID_PACKAGE, APP_NAME, CONTACT_EMAIL, EFFECTIVE_DATE, PUBLISHER, renderLegalPage } from './renderLegalPage.js';

const ar = `<h1>سياسة الخصوصية — ${APP_NAME}</h1>
<p class="meta">تاريخ السريان: ${EFFECTIVE_DATE} · التطبيق: ${APP_NAME} (حزمة أندرويد <span lang="en" dir="ltr">${ANDROID_PACKAGE}</span>) · الناشر: ${PUBLISHER}</p>

<h2>١. تسجيل الدخول عبر Google</h2>
<p>عند تسجيل الدخول بحساب Google نتحقق من رمز الدخول ونحتفظ بمعرّف حساب Google الخاص بك وبريدك الإلكتروني، إضافة إلى الاسم وصورة الملف الشخصي اللذين تقدّمهما عند التسجيل. لا يُعرض بريدك الإلكتروني علنًا أبدًا.</p>

<h2>٢. بيانات الملف الشخصي التي تضبطها بنفسك</h2>
<p>اسم المستخدم، واسم العرض، والنبذة، وصورتا الأفاتار والبانر اللتين ترفعهما (تُخزَّن في Cloudflare R2)، وزخارف الملف الشخصي، وهدف القراءة الأسبوعي. يكون اسم المستخدم واسم العرض والنبذة والأفاتار والبانر والزخارف مرئية للجميع على ملفك الشخصي وتعليقاتك. أما بريدك الإلكتروني وهدف القراءة الأسبوعي فيبقيان خاصّين بك ولا يظهران للآخرين.</p>

<h2>٣. نشاط القراءة المتزامن مع الخادم</h2>
<p>نزامن جلسات القراءة والتقدّم والمكتبة والإحصاءات والإنجازات مع الخادم، ونستخدمها لتوفير المزامنة بين أجهزتك والإحصاءات والمستويات ولوحة المتصدرين.</p>

<h2>٤. التعليقات والإعجابات</h2>
<p>التعليقات والإعجابات عامة: يمكن لأي مستخدم رؤيتها مع اسمك وصورتك.</p>

<h2>٥. النقاط والعملات والمتجر</h2>
<p>النقاط والعملات سجلّ داخلي داخل التطبيق. تُعالَج المشتريات والاشتراكات المدفوعة عبر Google Play: نستلم رمز الشراء وتفاصيل الطلب (مثل معرّف المنتج) للتحقق من الشراء وإضافة رصيدك، ولا نستلم أبدًا تفاصيل بطاقتك البنكية.</p>

<h2>٦. الإشعارات</h2>
<p>لا نجمع أي رمز دفع (push token) للجهاز على الخادم؛ التذكيرات داخل التطبيق تعمل محليًا على جهازك فقط.</p>

<h2>٧. مصادر خارجية</h2>
<p>يمكن للتطبيق قراءة روايات من مواقع ويب خارجية تختارها بنفسك. تذهب هذه الطلبات مباشرة من جهازك إلى تلك المواقع، وتبقى ملفات تعريف الارتباط (cookies) أو بيانات تسجيل الدخول الخاصة بتلك المواقع على جهازك. نحن لا نتحكم في تلك المواقع ولا تغطيها هذه السياسة.</p>

<h2>٨. ما لا نفعله</h2>
<ul>
<li>لا إعلانات في التطبيق.</li>
<li>لا نبيع بياناتك الشخصية.</li>
<li>لا نستخدم أي حزمة تحليلات أو تتبّع خارجية، ولا أي أداة لتتبّع الأعطال تجمع بياناتك.</li>
</ul>

<h2>٩. الجهات التي تعالج البيانات</h2>
<ul>
<li>Google: تسجيل الدخول والفوترة عبر Google Play.</li>
<li>Cloudflare: استضافة الخادم وتخزين الصور.</li>
<li>Neon: قاعدة بيانات التطبيق.</li>
</ul>
<p>تُشفَّر البيانات أثناء النقل عبر HTTPS.</p>

<h2>١٠. الاحتفاظ بالبيانات وحذف الحساب</h2>
<p>عند حذف حسابك من داخل التطبيق (صفحة الحساب ← قائمة الخيارات ← «حذف الحساب» ← تأكيد) نحذف فورًا: بريدك الإلكتروني وربط حساب Google وبياناتك الشخصية، وصور ملفك الشخصي من التخزين، وبيانات القراءة (الجلسات والمكتبة والروايات والإحصاءات والإنجازات والتصنيفات)، والعناصر المجهّزة، وطلبات الأدوار، وتُلغى مزايا Pro (يعود الاشتراك إلى المجاني مع تسجيل حدث إلغاء)، وتُسحَب مفاتيح API الخاصة بك.</p>
<p>ما يُحتفَظ به: تبقى تعليقاتك السابقة ظاهرة لكن تحت اسم مجهول «مستخدم محذوف» دون أي رابط لحسابك، ويُحتفَظ بسجلّ النقاط والمشتريات والمخزون لأغراض المحاسبة ومنع الاحتيال دون أي بيانات تحدّد هويتك.</p>

<h2>١١. الأطفال</h2>
<p>التطبيق غير موجّه للأطفال دون سن 13 عامًا، ولا نجمع عن قصد بيانات منهم.</p>

<h2>١٢. تغييرات السياسة</h2>
<p>قد نحدّث هذه السياسة من وقت لآخر؛ سننشر النسخة المحدّثة هنا مع تاريخ سريان جديد.</p>

<h2>١٣. تواصل معنا</h2>
<p>لأي سؤال أو طلب متعلق بالخصوصية راسلنا على: <a href="mailto:${CONTACT_EMAIL}" lang="en" dir="ltr">${CONTACT_EMAIL}</a></p>`;

const en = `<h1>${APP_NAME} Privacy Policy</h1>
<p class="meta">Effective date: ${EFFECTIVE_DATE} · App: ${APP_NAME} (Android package ${ANDROID_PACKAGE}) · Publisher: ${PUBLISHER}</p>

<h2>1. Google Sign-In</h2>
<p>When you sign in with Google, we verify your sign-in token and keep your Google account ID and email address, plus the name and profile photo you provide at sign-up. Your email is never shown publicly.</p>

<h2>2. Profile data you set</h2>
<p>Username, display name, bio, the avatar/banner images you upload (stored in Cloudflare R2), profile decorations, and your weekly reading goal. Your username, display name, bio, avatar, banner and decorations are public on your profile and comments. Your email address and weekly reading goal stay private to you.</p>

<h2>3. Reading activity synced to the server</h2>
<p>We sync reading sessions, progress, library, statistics and achievements to the server, and use them to provide cross-device sync, statistics, levels and the leaderboard.</p>

<h2>4. Comments and likes</h2>
<p>Comments and likes are public: anyone can see them together with your name and photo.</p>

<h2>5. Points, coins and the store</h2>
<p>Points and coins are an in-app ledger. Paid purchases and subscriptions are processed by Google Play: we receive the purchase token and order details (such as the product ID) to verify the purchase and credit your balance, and we never receive your card details.</p>

<h2>6. Notifications</h2>
<p>We do not collect any device push token on the server; in-app reminders work locally on your device only.</p>

<h2>7. Third-party sources</h2>
<p>The app can read novels from third-party websites you choose yourself. Those requests go directly from your device to those sites, and any cookies or logins for those sites stay on your device. We do not control those sites and this policy does not cover them.</p>

<h2>8. What we do not do</h2>
<ul>
<li>No advertising in the app.</li>
<li>We do not sell your personal data.</li>
<li>We use no third-party analytics or tracking SDK, and no crash-reporting tool that collects your data.</li>
</ul>

<h2>9. Processors</h2>
<ul>
<li>Google: sign-in and Google Play billing.</li>
<li>Cloudflare: server hosting and image storage.</li>
<li>Neon: the app database.</li>
</ul>
<p>Data is encrypted in transit (HTTPS).</p>

<h2>10. Retention and account deletion</h2>
<p>When you delete your account in the app (Account page → options menu → “Delete account” → confirm), we immediately delete: your email, Google account link and personal data; your profile media from storage; your reading data (sessions, library, novels, statistics, achievements, categories); equipped items; role requests; your Pro entitlement ends (plan returns to free with a recorded cancellation event); and your API keys are revoked.</p>
<p>What is kept: your past comments stay visible under the anonymous name “Deleted user” with no link to your account, and the points/purchase ledger and inventory are kept for accounting and fraud prevention without any data identifying you.</p>

<h2>11. Children</h2>
<p>The app is not directed to children under 13, and we do not knowingly collect data from them.</p>

<h2>12. Policy changes</h2>
<p>We may update this policy from time to time; we will publish the updated version here with a new effective date.</p>

<h2>13. Contact us</h2>
<p>For any privacy question or request, email us at: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`;

export function privacyPage(): string {
  return renderLegalPage(`سياسة الخصوصية | Privacy Policy`, ar, en);
}
