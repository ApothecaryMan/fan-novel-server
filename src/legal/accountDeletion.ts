import { APP_NAME, CONTACT_EMAIL, EFFECTIVE_DATE, renderLegalPage } from './renderLegalPage.js';

const ar = `<h1>حذف الحساب والبيانات — ${APP_NAME}</h1>
<p class="meta">تاريخ السريان: ${EFFECTIVE_DATE}</p>

<h2>كيفية حذف حسابك من داخل التطبيق</h2>
<ol>
<li>افتح صفحة «الحساب».</li>
<li>افتح قائمة الخيارات (⋮).</li>
<li>اختر «حذف الحساب».</li>
<li>أكّد الحذف في النافذة المنبثقة.</li>
</ol>
<p>يُحذف حسابك فورًا ولا يمكن التراجع عن ذلك.</p>

<h2>إذا لم يكن التطبيق مثبتًا لديك</h2>
<p>أرسل بريدًا إلكترونيًا من عنوان Gmail المرتبط بحسابك إلى <a href="mailto:${CONTACT_EMAIL}" lang="en" dir="ltr">${CONTACT_EMAIL}</a> بعنوان الموضوع التالي:</p>
<p lang="en" dir="ltr"><strong>Account deletion</strong></p>
<p>سنعالج طلبك خلال 30 يومًا.</p>

<h2>ما الذي يُحذف</h2>
<ul>
<li>بريدك الإلكتروني وربط حساب Google وبياناتك الشخصية (الاسم، النبذة، الزخارف، هدف القراءة الأسبوعي).</li>
<li>صور ملفك الشخصي (الأفاتار والبانر) من التخزين.</li>
<li>بيانات القراءة: الجلسات والتقدّم والمكتبة والإحصاءات والإنجازات والتصنيفات.</li>
<li>العناصر المجهّزة وطلبات الأدوار.</li>
<li>تنتهي مزايا Pro (يعود الاشتراك إلى المجاني) وتُسحَب مفاتيح API الخاصة بك.</li>
</ul>

<h2>ما الذي يُحتفَظ به</h2>
<ul>
<li>تبقى تعليقاتك السابقة ظاهرة تحت اسم مجهول «مستخدم محذوف» دون أي رابط لحسابك.</li>
<li>يُحتفَظ بسجلّ النقاط والمشتريات والمخزون لأغراض المحاسبة ومنع الاحتيال دون أي بيانات تحدّد هويتك.</li>
</ul>
<p>التفاصيل الكاملة في <a href="/privacy">سياسة الخصوصية</a>. للاستفسار: <a href="mailto:${CONTACT_EMAIL}" lang="en" dir="ltr">${CONTACT_EMAIL}</a></p>`;

const en = `<h1>Delete Your ${APP_NAME} Account and Data</h1>
<p class="meta">Effective date: ${EFFECTIVE_DATE}</p>

<h2>How to delete your account in the app</h2>
<ol>
<li>Open the Account page.</li>
<li>Open the options menu (⋮).</li>
<li>Choose “Delete account”.</li>
<li>Confirm the deletion in the dialog.</li>
</ol>
<p>Your account is deleted immediately and this cannot be undone.</p>

<h2>If you do not have the app installed</h2>
<p>Send an email from the Gmail address linked to your account to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> with the following subject line:</p>
<p><strong>Account deletion</strong></p>
<p>We will process your request within 30 days.</p>

<h2>What is deleted</h2>
<ul>
<li>Your email, Google account link and personal data (name, bio, decorations, weekly reading goal).</li>
<li>Your profile media (avatar and banner) from storage.</li>
<li>Your reading data: sessions, progress, library, statistics, achievements and categories.</li>
<li>Equipped items and role requests.</li>
<li>Your Pro entitlement ends (plan returns to free) and your API keys are revoked.</li>
</ul>

<h2>What is kept</h2>
<ul>
<li>Your past comments stay visible under the anonymous name “Deleted user” with no link to your account.</li>
<li>The points/purchase ledger and inventory are kept for accounting and fraud prevention without any data identifying you.</li>
</ul>
<p>Full details are in the <a href="/privacy">Privacy Policy</a>. Questions: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`;

export function accountDeletionPage(): string {
  return renderLegalPage(`حذف الحساب | Account Deletion`, ar, en);
}
