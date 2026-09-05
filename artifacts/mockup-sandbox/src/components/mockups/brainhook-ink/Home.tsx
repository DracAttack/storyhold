import './_group.css';

const LEAD_CARD = {
  cat: 'Astronomy',
  title: 'Astronomers Detect a Rogue Planet Carrying Its Own Magnetic Field',
  dek: 'An Earth-sized object drifting between star systems is generating a magnetic signature strong enough to produce visible auroras — with no parent star in sight.',
  author: 'P. Nakamura',
  read: '11 min',
  img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=800&q=80',
};

const HORIZONTAL = [
  {
    cat: 'Psychology',
    title: 'The Dunning-Kruger Effect Is More Complicated Than You Think',
    author: 'J. Kowalski', read: '7 min',
    img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&q=80',
  },
  {
    cat: 'Neuroscience',
    title: 'Sleep Deprivation Rewires Your Brain\'s Threat Detection System',
    author: 'Dr. Mia Chen', read: '5 min',
    img: 'https://images.unsplash.com/photo-1541781774459-bb2af2f05b55?w=200&q=80',
  },
  {
    cat: 'Earth & Climate',
    title: 'Microbes in the Hadal Zone Are Eating Plastic Faster Than Expected',
    author: 'S. Abara', read: '8 min',
    img: 'https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=200&q=80',
  },
];

export function Home() {
  return (
    <div className="ink-root">

      {/* ── Glass Element 1: Navbar ── */}
      <header className="ink-header">
        <div className="ink-logo">Brain<span>Hook</span></div>
        <nav>
          <ul className="ink-nav">
            {['Psychology', 'Neuroscience', 'Astronomy', 'Earth & Climate', 'Culture'].map(c => (
              <li key={c}><a href="#">{c}</a></li>
            ))}
          </ul>
        </nav>
        <button className="ink-subscribe">Subscribe</button>
      </header>

      {/* ── Hero with signature vertical label + Glass Element 2 ── */}
      <section className="ink-hero">
        <img
          className="ink-hero-img"
          src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1400&q=80"
          alt=""
        />

        {/* Signature: vertical category spine */}
        <div className="ink-hero-spine">
          <span>Neuroscience</span>
        </div>

        {/* Glass panel — only headline + labels, no body text */}
        <div className="ink-hero-panel">
          <div className="ink-panel-eyebrow">Featured</div>
          <h1 className="ink-panel-title">
            Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
          </h1>
          <div className="ink-panel-meta">
            <span>Dr. Mia Chen</span>
            <span className="sep">·</span>
            <span>9 min read</span>
            <span className="sep">·</span>
            <span>Jul 8, 2026</span>
            <button className="ink-panel-read">Read →</button>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="ink-divider">
        <div className="ink-divider-line" />
        <span className="ink-divider-label">More Stories</span>
        <div className="ink-divider-line" />
      </div>

      {/* ── Flat card grid — no glass ── */}
      <div className="ink-grid">

        {/* Row 1: Lead card (4 cols) */}
        <div className="ink-card-lead">
          <img className="ink-card-lead-img" src={LEAD_CARD.img} alt="" />
          <div className="ink-card-lead-body">
            <div className="ink-card-cat">{LEAD_CARD.cat}</div>
            <div className="ink-card-title">{LEAD_CARD.title}</div>
            <div className="ink-card-dek">{LEAD_CARD.dek}</div>
            <div className="ink-card-meta">
              <span>{LEAD_CARD.author}</span><span>·</span><span>{LEAD_CARD.read}</span>
            </div>
          </div>
        </div>

        {/* Row 1: Amber stat card (2 cols) */}
        <div className="ink-card-stat">
          <div>
            <div className="ink-stat-number">14</div>
            <div className="ink-stat-label">universities contributed fMRI data — the largest coordinated neuroimaging effort ever conducted.</div>
          </div>
          <div className="ink-stat-source">Nature Neuroscience · Jul 2026</div>
        </div>

        {/* Row 2: Three horizontal cards */}
        {HORIZONTAL.map((c, i) => (
          <div key={i} className="ink-card-h">
            <img className="ink-card-h-img" src={c.img} alt="" />
            <div className="ink-card-h-body">
              <div className="ink-card-cat">{c.cat}</div>
              <div className="ink-card-title">{c.title}</div>
              <div className="ink-card-meta">
                <span>{c.author}</span><span>·</span><span>{c.read}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
