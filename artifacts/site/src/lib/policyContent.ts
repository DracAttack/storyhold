/**
 * Single source of truth for the trust/policy page copy (Privacy, Terms,
 * Editorial Policy, Corrections, Contact) and the shared Editorial &
 * Informational Disclaimer.
 *
 * This copy used to live twice — once as JSX in `src/pages/*.tsx` and once as
 * hardcoded HTML strings in `server/index.ts` — and the two versions had
 * already drifted (the corrections page's Contact section differed between
 * what readers saw and what crawlers saw). Both renderers now consume THIS
 * module:
 *
 *  - React pages render `bodyHtml` via `dangerouslySetInnerHTML` inside the
 *    shared <PolicyPage> shell.
 *  - The production meta server (`server/index.ts`) imports the same docs and
 *    wraps `bodyHtml` in its mirrored policy-shell markup.
 *
 * The HTML here is trusted, hand-authored markup (headings, paragraphs,
 * lists, links) — never user input — which is why rendering it raw on both
 * sides is safe. Edit policy copy HERE and only here; both the visible page
 * and the crawler-rendered page update together.
 */

export interface PolicyDoc {
  eyebrow: string;
  title: string;
  intro: string;
  /** Human-readable last-updated label, e.g. "June 2026". Empty = no line. */
  updated?: string;
  /** Trusted, hand-authored body HTML (h2/p/ul/li/a/strong only). */
  bodyHtml: string;
}

/**
 * The "Editorial and Informational Disclaimer" appended to the Contact,
 * Corrections, and Editorial Policy pages (and rendered on About via the
 * <EditorialDisclaimer> component).
 */
export const EDITORIAL_DISCLAIMER_HTML: string = [
  `<h2>Editorial and Informational Disclaimer</h2>`,
  `<p>BrainHook publishes editorial, educational, and opinion-based content based on research, source review, and editorial interpretation. Our articles are intended to inform, explain, question, and explore. They should not be treated as professional advice, diagnosis, instruction, or authority in any medical, psychological, legal, financial, safety, or emergency matter.</p>`,
  `<p>Content on BrainHook may discuss health, mental health, relationships, politics, science, history, crime, technology, finance, and other sensitive subjects. This content is for general informational and editorial purposes only. It is not a substitute for advice from a qualified doctor, mental health professional, attorney, financial advisor, safety expert, or other appropriate professional.</p>`,
  `<p>BrainHook does not diagnose individuals, provide treatment plans, offer legal or financial instructions, or make personalized recommendations. Readers are responsible for how they interpret and use the information on this site.</p>`,
  `<p>When articles discuss research, public events, historical records, allegations, disputed claims, or emerging science, we aim to distinguish evidence, interpretation, uncertainty, and opinion as clearly as possible. Errors can happen. If you believe something is inaccurate, incomplete, outdated, or unfairly presented, please contact us through our corrections process.</p>`,
].join("");

export const PRIVACY_POLICY: PolicyDoc = {
  eyebrow: "Your Privacy",
  title: "Privacy Policy",
  intro:
    "We respect your privacy and collect only what we need to run BrainHook. This page explains what we gather, why, and the choices you have.",
  updated: "July 10, 2026",
  bodyHtml: [
    `<p>This Privacy Policy describes how BrainHook ("we", "us", or "our") collects, uses, and shares information when you visit our website, read our articles, or subscribe to our newsletter. By using BrainHook, you agree to the practices described here.</p>`,
    `<p><strong>Effective date:</strong> July 10, 2026.</p>`,
    `<h2>Information we collect</h2>`,
    `<ul><li><strong>Newsletter data.</strong> When you subscribe, we store the email address you provide so we can send you our newsletter. You can unsubscribe at any time using the link in any email or our <a href="/unsubscribe">unsubscribe page</a>.</li><li><strong>Usage data.</strong> Like most websites, our servers and analytics tools may automatically record information such as your browser type, device, approximate location (derived from IP address), referring pages, and the pages you view. This helps us understand what readers find valuable.</li><li><strong>Cookies and similar technologies.</strong> We and our partners use cookies, web beacons, and similar technologies to operate the site, remember preferences, measure traffic, and serve relevant advertising. See "Cookies" below.</li></ul>`,
    `<h2>How we use your information</h2>`,
    `<ul><li>To deliver our newsletter and respond to your inquiries.</li><li>To operate, maintain, and improve the website and our editorial coverage.</li><li>To measure and analyze traffic and engagement.</li><li>To display advertising that helps fund our research.</li><li>To detect, prevent, and address fraud, abuse, or technical issues.</li></ul>`,
    `<h2>Service providers we use</h2>`,
    `<p>We rely on a small number of trusted providers to run BrainHook. Each processes data only to provide its service to us:</p>`,
    `<ul><li><strong>Google AdSense</strong> (Google LLC) — serves advertising and delivers our certified consent message.</li><li><strong>Google Analytics 4</strong> (Google LLC) — measures aggregate site traffic and engagement.</li><li><strong>Resend</strong> (Resend, Inc.) — delivers our newsletter and any email you request; we share only the email address you provide, so the messages can be sent.</li></ul>`,
    `<h2>Cookies</h2>`,
    `<p>Cookies are small text files stored on your device; web beacons are small markers embedded in pages or emails. We use essential cookies that make the site work, analytics cookies that help us understand usage, and advertising cookies set by our advertising partners. You can control or delete cookies through your browser settings; disabling some cookies may affect how the site functions.</p>`,
    `<h2>Third-party advertising and analytics</h2>`,
    `<p>We work with third-party vendors to display advertising and measure performance. These vendors may collect information about your visits to this and other websites — including cookies, device and browser identifiers, and IP address — in order to provide measurement services and serve ads.</p>`,
    `<ul><li><strong>Google AdSense and advertising partners.</strong> Third-party vendors, including Google, use cookies to serve ads based on your prior visits to BrainHook and other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visits across the web. You can opt out of personalized advertising by visiting <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener noreferrer">Google Ads Settings</a>, and you can opt out of third-party vendor cookies for personalized advertising at <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">aboutads.info/choices</a>.</li><li><strong>Analytics.</strong> We use Google Analytics 4 to understand aggregate traffic patterns. It processes usage data on our behalf, and in the EEA, UK, and Switzerland it runs without storage-based identifiers until you consent.</li></ul>`,
    `<p>For more information on how Google handles data in its advertising products, see <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer">How Google uses information from sites that use its services</a>.</p>`,
    `<h2>Personalized, non-personalized, and limited ads</h2>`,
    `<p>Depending on your consent and where you are, the ads you see fall into one of three categories:</p>`,
    `<ul><li><strong>Personalized ads</strong> use cookies and similar identifiers to tailor advertising to your interests based on your activity across sites. They run only where you have not opted out — and, in the EEA, UK, and Switzerland, only after you consent.</li><li><strong>Non-personalized ads</strong> are shown based on the current page and coarse signals such as approximate location, without building a profile of you. You may still see these after opting out of personalization.</li><li><strong>Limited ads</strong> serve without storing or reading cookies or identifiers on your device — for example, before an EEA, UK, or Switzerland visitor has made a consent choice.</li></ul>`,
    `<h2>How long we keep your information</h2>`,
    `<p>We keep information only as long as we reasonably need it:</p>`,
    `<ul><li><strong>Newsletter email address</strong> — until you unsubscribe, after which it is removed from active mailing lists (we may retain a minimal suppression record so we don't email you again).</li><li><strong>Analytics data</strong> — user- and event-level data in Google Analytics is retained for up to 14 months; aggregate, non-identifying statistics may be kept longer.</li><li><strong>Advertising cookies</strong> — retained for the periods set by Google and its partners under their own policies.</li><li><strong>Server and security logs</strong> — kept for a limited period to operate and protect the site, then discarded or reduced to aggregates.</li></ul>`,
    `<h2>Consent for visitors in the EEA, UK, and Switzerland</h2>`,
    `<p>If you visit from the European Economic Area, the United Kingdom, or Switzerland, we ask for your consent before advertising cookies are used, via a consent message on pages that carry advertising. You can decline, and you can change your choice later using the "Manage privacy choices" control described below. Until you consent, storage-based advertising and analytics identifiers default to off in these regions.</p>`,
    `<h2>Managing your privacy choices</h2>`,
    `<p>You can review or withdraw your consent for advertising and analytics cookies at any time using the <strong>"Manage privacy choices"</strong> control at the bottom of this page and in the site footer, which reopens the consent message. You can also opt out of personalized advertising through <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener noreferrer">Google Ads Settings</a> and <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">aboutads.info/choices</a>, and control or delete cookies through your browser settings.</p>`,
    `<h2>Sharing your information</h2>`,
    `<p>We do not sell your personal information. We share information only with the service providers listed above who help us operate the site (email delivery, hosting, analytics, and advertising partners), or when required by law.</p>`,
    `<h2>Your choices and rights</h2>`,
    `<ul><li>Unsubscribe from our newsletter at any time.</li><li>Reopen the consent message with "Manage privacy choices" to review or withdraw consent.</li><li>Control cookies through your browser settings.</li><li>Opt out of personalized advertising via the links above.</li><li>Depending on where you live, you may have the right to access, correct, or delete your personal data. To make a request, contact us at <a href="mailto:editor@brainhook.net">editor@brainhook.net</a>.</li></ul>`,
    `<h2>Children's privacy</h2>`,
    `<p>BrainHook is not directed to children under 13, and we do not knowingly collect personal information from them.</p>`,
    `<h2>Changes to this policy</h2>`,
    `<p>We may update this Privacy Policy from time to time. When we do, we'll revise the "Last updated" and effective date above. Significant changes will be reflected on this page.</p>`,
    `<h2>Contact</h2>`,
    `<p>Questions about this policy? Email <a href="mailto:editor@brainhook.net">editor@brainhook.net</a> or visit our <a href="/contact">Contact page</a>.</p>`,
  ].join(""),
};

export const TERMS_OF_USE: PolicyDoc = {
  eyebrow: "The Fine Print",
  title: "Terms of Use",
  intro:
    "These terms govern your use of BrainHook. By accessing the site, you agree to them — so it's worth a read.",
  updated: "June 2026",
  bodyHtml: [
    `<p>Welcome to BrainHook. These Terms of Use ("Terms") form a binding agreement between you and BrainHook ("we", "us", or "our") and govern your access to and use of our website, content, and newsletter. If you do not agree to these Terms, please do not use the site.</p>`,
    `<h2>Use of the site</h2>`,
    `<p>You may read, share, and link to our content for personal, non-commercial purposes. You agree not to misuse the site — including by attempting to disrupt it, access it through automated means at scale, scrape content without permission, or use it for any unlawful purpose.</p>`,
    `<h2>Intellectual property</h2>`,
    `<p>All content on BrainHook — including articles, images, logos, and design — is owned by BrainHook or its licensors and is protected by copyright and other laws. You may quote brief excerpts with attribution and a link, but you may not republish, redistribute, or create derivative works from our content without prior written permission.</p>`,
    `<h2>Editorial content and AI assistance</h2>`,
    `<p>BrainHook uses AI-assisted tools as part of its editorial process, with human review. Our content is intended for general information and education. It is not professional, medical, legal, or financial advice. See our <a href="/editorial-policy">Editorial Policy &amp; AI Disclosure</a> for details on how our content is produced.</p>`,
    `<h2>Newsletter</h2>`,
    `<p>By subscribing, you consent to receive email from us. You can unsubscribe at any time via the link in any email. Your subscription is also governed by our <a href="/privacy">Privacy Policy</a>.</p>`,
    `<h2>Third-party links and advertising</h2>`,
    `<p>The site contains links to third-party websites and displays third-party advertising. We are not responsible for the content, products, or practices of third parties. Your interactions with advertisers or linked sites are solely between you and that third party.</p>`,
    `<h2>Disclaimers</h2>`,
    `<p>The site and its content are provided "as is" and "as available" without warranties of any kind, whether express or implied, including warranties of accuracy, merchantability, or fitness for a particular purpose. We do not warrant that the site will be uninterrupted, error-free, or secure.</p>`,
    `<h2>Limitation of liability</h2>`,
    `<p>To the fullest extent permitted by law, BrainHook and its contributors will not be liable for any indirect, incidental, consequential, or punitive damages arising from your use of, or inability to use, the site or its content.</p>`,
    `<h2>Changes to these terms</h2>`,
    `<p>We may update these Terms from time to time. Continued use of the site after changes take effect constitutes acceptance of the revised Terms. We'll update the "Last updated" date above when we make changes.</p>`,
    `<h2>Contact</h2>`,
    `<p>Questions about these Terms? Reach us via our <a href="/contact">Contact page</a>.</p>`,
  ].join(""),
};

export const EDITORIAL_POLICY: PolicyDoc = {
  eyebrow: "How We Work",
  title: "Editorial Policy & AI Disclosure",
  intro:
    "We believe in being honest about how our research is made. Here's our process — and where AI fits in.",
  updated: "June 2026",
  bodyHtml: [
    `<p>BrainHook combines modern AI-assisted tools with human editorial judgment. We're transparent about this because trust is earned through honesty, not by hiding how the work gets done. This page explains our standards and the role technology plays in our newsroom.</p>`,
    `<h2>Our use of AI</h2>`,
    `<p>BrainHook uses AI-assisted systems to help research topics, organize information, and produce initial drafts of articles. AI accelerates the early stages of writing — but it does not have the final word. Every piece is shaped by editorial direction, reviewed against our standards, and published under the oversight of our editorial team.</p>`,
    `<p>We use AI as a tool, the way a newsroom uses research assistants and production software — not as an unsupervised author. This is AI-assisted, editorially reviewed research, not automatically published, unchecked output.</p>`,
    `<h2>Human editorial review</h2>`,
    `<p>Before anything reaches readers, our editorial process evaluates each article for accuracy, clarity, tone, and value. We check that headlines reflect the substance of the story, that claims are reasonable and supported, and that the writing respects the reader's intelligence. Articles that don't meet our bar are revised or held back.</p>`,
    `<h2>Sourcing and accuracy</h2>`,
    `<p>We aim to ground our coverage in credible research and reporting. Where we describe studies, findings, or events, we work to represent them faithfully and in context. AI-generated text can contain errors or "hallucinations," which is precisely why human review and source awareness are central to our process. When we get something wrong, we fix it — see our <a href="/corrections">Corrections Policy</a>.</p>`,
    `<h2>Reporting, opinion, and speculation</h2>`,
    `<p>Not everything we publish is the same kind of writing, and we try to be clear about which is which. Some pieces are reporting — grounded in research, data, and verifiable events. Others are essays, analysis, or informed opinion that interpret what the evidence might mean. And some explore open questions where the honest answer is "we don't fully know yet." When an article ventures into speculation or interpretation, we aim to flag it as such rather than dressing it up as settled fact.</p>`,
    `<h2>Imagery</h2>`,
    `<p>Some illustrations and hero images on BrainHook are AI-generated to accompany our stories. These images are intended to be illustrative rather than documentary, and we avoid using synthetic imagery in ways that could mislead readers about real people or events.</p>`,
    `<h2>Independence and corrections</h2>`,
    `<p>Our editorial decisions are made independently of advertisers and commercial partners. Advertising helps fund our work, but it does not dictate our coverage. If we make a mistake, we correct it transparently and promptly.</p>`,
    `<h2>Our standards in short</h2>`,
    `<ul><li>Substance over sensation — headlines must deliver on their promise.</li><li>AI assists; humans decide. Nothing publishes without editorial oversight.</li><li>Accuracy matters — we represent research and events faithfully.</li><li>Transparency about how our work, including AI tooling, is produced.</li><li>We correct errors openly.</li></ul>`,
    `<h2>Automated source discovery and research tools</h2>`,
    `<p>Our editorial process uses automated tools — including software sometimes referred to as web crawlers or bots — to discover, gather, and organize research sources from publicly accessible pages across the internet. These tools identify potentially relevant studies, articles, government documents, and reports, which are then surfaced for editorial review before informing our content.</p>`,
    `<p>Because our discovery and categorization process is AI-assisted, errors can occasionally occur. A document may be classified under the wrong topic, linked to the wrong subject area, or associated with content where it is not an ideal fit. We work to minimize these errors through editorial review, but we cannot guarantee that every source is categorized perfectly. If you believe a source has been miscategorized, surfaced in the wrong context, or otherwise appears in a way that seems incorrect, please let us know via our <a href="/contact">Contact page</a> or at <a href="mailto:editor@brainhook.net">editor@brainhook.net</a>.</p>`,
    `<h2>Third-party linked files and downloads</h2>`,
    `<p>Some references in our articles link directly to files hosted by third parties — including academic papers, government reports, and research documents in PDF or other downloadable formats. BrainHook does not own, create, write, host, or control these files. They are provided as research references only and do not represent the views, opinions, or positions of BrainHook or its editorial team. We cannot guarantee the accuracy, safety, completeness, or continued availability of any third-party file. By following a link to a downloadable file, you do so entirely at your own risk.</p>`,
    `<p>If you are the owner or publisher of a document linked from our site and believe the link is incorrect, outdated, or should be removed, please contact us at <a href="mailto:editor@brainhook.net">editor@brainhook.net</a> and we will address it promptly.</p>`,
    `<h2>Questions</h2>`,
    `<p>We welcome scrutiny of our process. Read our <a href="/about">manifesto</a>, or reach the editorial team via our <a href="/contact">Contact page</a>.</p>`,
    EDITORIAL_DISCLAIMER_HTML,
  ].join(""),
};

export const CORRECTIONS_POLICY: PolicyDoc = {
  eyebrow: "Accuracy Matters",
  title: "Corrections Policy",
  intro:
    "We get things wrong sometimes. When we do, we want to fix them quickly and openly. Here's how that works.",
  updated: "June 2026",
  bodyHtml: [
    `<p>Accuracy is fundamental to BrainHook. We work hard to get the facts right, but no publication is perfect. When an error makes it into a published article, we believe the right response is to correct it promptly and transparently — not to quietly bury it.</p>`,
    `<h2>How to report an error</h2>`,
    `<p>If you spot a factual mistake — a misstated statistic, a misattributed quote, an incorrect date, or a misrepresented study — please let us know. Email <a href="mailto:editor@brainhook.net">editor@brainhook.net</a> and include:</p>`,
    `<ul><li>The article title and link.</li><li>The specific passage or claim you believe is incorrect.</li><li>What you believe the correct information is, and any sources that support it.</li></ul>`,
    `<h2>How we evaluate requests</h2>`,
    `<p>We review every good-faith correction request. Our editorial team verifies the claim against reliable sources before making changes. We distinguish between genuine factual errors (which we correct) and differences of interpretation or opinion (which we may address through clarification or additional context where warranted).</p>`,
    `<h2>How we make corrections</h2>`,
    `<ul><li><strong>Factual errors</strong> are corrected in the article as soon as they're verified.</li><li><strong>Significant corrections</strong> — those that materially change the meaning or conclusions of a piece — are noted transparently so readers understand what changed.</li><li><strong>Minor fixes</strong> such as typos or formatting may be updated without a separate note.</li></ul>`,
    `<h2>Timeliness</h2>`,
    `<p>We aim to acknowledge correction requests within a few business days and to act on verified errors as quickly as possible. Serious factual problems are prioritized.</p>`,
    `<h2>Our commitment</h2>`,
    `<p>Correcting our mistakes openly is part of how we earn reader trust. It also reflects our broader editorial standards, including the human review built into our <a href="/editorial-policy">Editorial Policy &amp; AI Disclosure</a>.</p>`,
    `<h2>Contact</h2>`,
    `<p>Corrections are handled by our responsible editor, Damien Lynn, on behalf of Brainhook Media (Phoenix, Arizona, USA). Report an error at <a href="mailto:editor@brainhook.net">editor@brainhook.net</a>, or reach us through our <a href="/contact">Contact page</a>.</p>`,
    EDITORIAL_DISCLAIMER_HTML,
  ].join(""),
};

export const CONTACT_PAGE: PolicyDoc = {
  eyebrow: "Get in Touch",
  title: "Contact BrainHook",
  intro:
    "We read every message. Whether you've spotted an error, have a story tip, or just want to share feedback, here's how to reach us.",
  bodyHtml: [
    `<p>BrainHook is an independent publication, published by Brainhook Media in Phoenix, Arizona, USA. The responsible editor is Damien Lynn. The fastest way to reach the editorial team is by email — we aim to respond to all genuine inquiries within a few business days.</p>`,
    `<h2>Email us</h2>`,
    `<p>For anything at all, write to <a href="mailto:editor@brainhook.net">editor@brainhook.net</a>. To help us route your message quickly, please include the relevant details:</p>`,
    `<ul><li><strong>Story tips &amp; feedback</strong> — what you'd like us to cover, or your thoughts on our coverage.</li><li><strong>Corrections</strong> — the article title, the specific passage in question, and any supporting sources. See our <a href="/corrections">Corrections Policy</a> for how we handle these requests.</li><li><strong>Privacy &amp; data</strong> — questions about your data or newsletter subscription, covered in our <a href="/privacy">Privacy Policy</a>.</li><li><strong>Press</strong> — your outlet and deadline so we can get back to you in time.</li></ul>`,
    `<p class="text-muted-foreground">We don't currently offer a contact form — please use the email above and we'll make sure your message reaches the right person.</p>`,
    EDITORIAL_DISCLAIMER_HTML,
  ].join(""),
};
