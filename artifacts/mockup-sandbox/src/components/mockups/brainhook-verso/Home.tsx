import "./_group.css";

const LEAD = {
  cat: "Neuroscience",
  title: "Your Brain Treats Social Rejection the Same Way It Processes Physical Pain",
  dek: "New fMRI data from 14 universities reveals overlapping neural pathways — with implications for how we treat loneliness as a public health crisis.",
  author: "Dr. Mia Chen",
  read: "9 min read",
  img: "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=1200&q=80",
};

const LEAD_CARD = {
  cat: "Astronomy",
  title: "Astronomers Detect a Rogue Planet With Its Own Magnetic Field",
  dek: "An Earth-sized object drifting between star systems is generating a magnetic signature strong enough to produce visible auroras — with no parent star in sight.",
  author: "Dr. James Ortiz",
  read: "11 min",
  img: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=800&q=80",
};

const HORIZONTAL = [
  {
    cat: "Psychology",
    title: "The Nocebo Effect Is Real, and It's Making People Sick",
    author: "Elena Vasquez",
    read: "7 min",
    img: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&q=80",
  },
  {
    cat: "Earth & Climate",
    title: "Antarctica Is Melting From Below — We've Been Measuring the Wrong Thing",
    author: "Dr. Hana Watanabe",
    read: "8 min",
    img: "https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=200&q=80",
  },
  {
    cat: "Culture & Media",
    title: "Why Every Algorithm Eventually Becomes Conservative",
    author: "Marcus Webb",
    read: "6 min",
    img: "https://images.unsplash.com/photo-1432888622747-4eb9a8efeb07?w=200&q=80",
  },
];

export default function VersoHome() {
  return (
    <div className="verso-root">
      {/* ── Glass Element 1: Navbar ── */}
      <header className="verso-header">
        <nav className="verso-nav-left">
          <a href="#">Psychology</a>
          <a href="#">Neuroscience</a>
          <a href="#">Astronomy</a>
        </nav>
        <div className="verso-logo-center">Brain<span>Hook</span></div>
        <nav className="verso-nav-right">
          <a href="#">Earth &amp; Climate</a>
          <a href="#">Culture</a>
          <button className="verso-subscribe-btn">Subscribe</button>
        </nav>
      </header>

      <div className="verso-issue-bar">
        <span className="accent">Real Research.</span>
        <span>July 2026 · Vol. 3</span>
        <span>Est. 2024</span>
      </div>

      {/* ── Hero with Glass Element 2: Floating panel ── */}
      <div className="verso-hero">
        <img className="verso-hero-img" src={LEAD.img} alt="" />
        <div className="verso-hero-scrim" />

        {/* Glass panel — no body text, only headline + labels */}
        <div className="verso-hero-panel">
          <div className="verso-hero-cat">{LEAD.cat}</div>
          <div className="verso-hero-title">{LEAD.title}</div>
          <div className="verso-hero-meta">
            <span>{LEAD.author}</span>
            <span className="sep">·</span>
            <span>{LEAD.read}</span>
            <button className="verso-read-btn">Read →</button>
          </div>
        </div>
      </div>

      {/* ── Flat card grid — no glass ── */}
      <div className="verso-section-label">Latest stories</div>

      <div className="verso-grid">
        {/* Row 1: Lead card (4 cols) + Stat card (2 cols) */}
        <div className="verso-card-lead">
          <img className="verso-card-lead-img" src={LEAD_CARD.img} alt="" />
          <div className="verso-card-lead-body">
            <div className="verso-card-cat">{LEAD_CARD.cat}</div>
            <div className="verso-card-title">{LEAD_CARD.title}</div>
            <div className="verso-card-dek">{LEAD_CARD.dek}</div>
            <div className="verso-card-meta">
              <span>{LEAD_CARD.author}</span>
              <span>{LEAD_CARD.read}</span>
            </div>
          </div>
        </div>

        <div className="verso-card-stat">
          <div>
            <div className="verso-stat-number">14</div>
            <div className="verso-stat-label">universities contributed fMRI data to the social-pain study — the largest coordinated neuroimaging effort to date.</div>
          </div>
          <div className="verso-stat-source">Nature Neuroscience · Jul 2026</div>
        </div>

        {/* Row 2: Three horizontal cards */}
        {HORIZONTAL.map((c, i) => (
          <div key={i} className="verso-card-h">
            <img className="verso-card-h-img" src={c.img} alt="" />
            <div className="verso-card-h-body">
              <div className="verso-card-cat">{c.cat}</div>
              <div className="verso-card-title">{c.title}</div>
              <div className="verso-card-meta">
                <span>{c.author}</span>
                <span>{c.read}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
