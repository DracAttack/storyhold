import './_group.css';

export function Article() {
  return (
    <div className="ink-root">

      {/* ── Glass Element 1: Navbar ── */}
      <header className="ink-header">
        <div className="ink-logo">Brain<span>Hook</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 12, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>← Neuroscience</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>9 min read</span>
        </div>
        <button className="ink-subscribe">Subscribe</button>
      </header>

      {/* ── Hero — flat surface, gradient scrim ── */}
      <div className="ink-article-hero">
        <img
          className="ink-article-hero-img"
          src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1280&q=80"
          alt=""
        />
        <div className="ink-article-hero-scrim" />
        <div className="ink-article-hero-text">
          <div className="ink-article-eyebrow">
            <span className="ink-article-eyebrow-bar" />
            <span className="ink-article-eyebrow-label">Neuroscience &amp; Longevity</span>
          </div>
          <h1 className="ink-article-h1">
            Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
          </h1>
        </div>
      </div>

      {/* ── Body — flat, solid bg ── */}
      <div className="ink-article-body-wrap">
        <p className="ink-article-dek">
          New fMRI data from 14 universities reveals overlapping neural pathways — with profound implications for how we treat loneliness as a public health crisis.
        </p>

        <div className="ink-article-byline-row">
          <div>
            <div className="ink-article-byline-name">Dr. Mia Chen</div>
            <div className="ink-article-byline-role">Neuroscience Correspondent</div>
          </div>
          <div className="ink-article-byline-sep" />
          <span className="ink-article-byline-meta">Jul 8, 2026</span>
          <div className="ink-article-byline-sep" />
          <span className="ink-article-byline-meta">9 min read</span>
        </div>

        <p className="ink-body-p">
          When Ethan Kross published his landmark 2011 study in the <em>Proceedings of the National Academy of Sciences</em>, the finding landed like a minor earthquake in neuroscience: the same brain regions that light up when we stub a toe — the secondary somatosensory cortex, the dorsal posterior insula — activate with near-identical intensity when we are socially excluded.
        </p>
        <p className="ink-body-p">
          Twelve years later, a consortium of 14 universities has replicated and extended that finding with fMRI datasets totaling 2,300 participants across four continents. The verdict is more emphatic: social rejection doesn't just borrow the pain network's infrastructure. In roughly 40% of participants, the neural response to exclusion is measurably <em>stronger</em> than the response to mild physical discomfort.
        </p>

        <div className="ink-blockquote">
          "We're not speaking metaphorically when we say rejection hurts. We're describing a biological event." — Dr. Sara Castellano
        </div>

        <p className="ink-body-p">
          The implications ripple in three directions: toward the public health crisis of loneliness, toward treatment of social anxiety disorders, and toward a question most researchers are still hesitant to ask aloud — whether pain-management mechanisms might be repurposed for the psychological aftermath of severe social loss.
        </p>
      </div>

    </div>
  );
}
