import './_group.css';

export function Article() {
  return (
    <div style={{ fontFamily: "'Source Serif 4', Georgia, serif", background: '#F9F8F5', color: '#141414', minHeight: '100vh' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #D8D6D0', padding: '0 56px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880', letterSpacing: 1, textTransform: 'uppercase' }}>Neuroscience &amp; Longevity</span>
        <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 800, fontSize: 26, letterSpacing: -0.8, color: '#141414' }}>
          Brain<span style={{ color: '#2B7D6E' }}>Hook</span>
        </span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880', letterSpacing: 1 }}>9 min read</span>
      </header>

      {/* Article header */}
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '56px 40px 0' }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2B7D6E', letterSpacing: 1.5, textTransform: 'uppercase', display: 'block', marginBottom: 20 }}>
          Neuroscience &amp; Longevity
        </span>
        <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 54, fontWeight: 800, lineHeight: 1.08, margin: '0 0 26px', color: '#141414', letterSpacing: -0.5 }}>
          Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
        </h1>

        {/* THE SIGNATURE ELEMENT: large italic dek as visual anchor */}
        <p style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 22,
          fontStyle: 'italic',
          fontWeight: 600,
          lineHeight: 1.58,
          color: '#4A4A44',
          margin: '0 0 36px',
          paddingBottom: 32,
          borderBottom: '1px solid #D8D6D0',
        }}>
          New fMRI data from 14 universities reveals overlapping neural pathways — with profound implications for how we treat loneliness as a public health crisis.
        </p>

        {/* Byline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 40 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', background: '#D8D6D0' }}>
            <img src="https://images.unsplash.com/photo-1494790108755-2616b612b786?w=72&h=72&fit=crop&auto=format" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 500, color: '#141414' }}>Dr. Mia Chen</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880', marginTop: 2 }}>Neuroscience Correspondent · Jul 8, 2026</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 12 }}>
            {['Share', 'Save', 'Listen'].map(a => (
              <button key={a} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, background: 'transparent', border: '1px solid #D8D6D0', color: '#888880', padding: '6px 14px', cursor: 'pointer', letterSpacing: 1, textTransform: 'uppercase' }}>{a}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Hero image — full-ish width */}
      <div style={{ maxWidth: 1060, margin: '0 auto 48px', padding: '0 40px' }}>
        <img src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=980&h=420&fit=crop&auto=format" alt="" style={{ width: '100%', display: 'block', objectFit: 'cover' }} />
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#A0A09A', paddingTop: 8, letterSpacing: 0.3 }}>
          fMRI composite, University of Michigan / UCLA collaborative study, 2026.
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 40px 80px' }}>
        <p style={{ fontSize: 18, lineHeight: 1.82, color: '#1C1C18', margin: '0 0 26px' }}>
          When Ethan Kross published his landmark 2011 study in the <em>Proceedings of the National Academy of Sciences</em>, the finding landed like a minor earthquake in neuroscience: the same brain regions that activate when we stub a toe — the secondary somatosensory cortex, the dorsal posterior insula — fire with near-identical intensity when we are socially excluded.
        </p>
        <p style={{ fontSize: 18, lineHeight: 1.82, color: '#1C1C18', margin: '0 0 26px' }}>
          Twelve years later, a consortium of 14 universities has replicated and extended that finding. In roughly 40% of participants, the neural response to exclusion is measurably <em>stronger</em> than the response to mild physical discomfort.
        </p>

        {/* Teal-accent blockquote */}
        <div style={{ borderLeft: '3px solid #2B7D6E', paddingLeft: 28, margin: '36px 0', fontFamily: "'Playfair Display', Georgia, serif", fontSize: 20, fontStyle: 'italic', lineHeight: 1.62, color: '#4A4A44' }}>
          "We're not speaking metaphorically when we say rejection hurts. We're describing a biological event with measurable neurochemical consequences."
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontStyle: 'normal', color: '#888880', marginTop: 10 }}>Dr. Sara Castellano, lead author</div>
        </div>

        <p style={{ fontSize: 18, lineHeight: 1.82, color: '#1C1C18', margin: '0 0 26px' }}>
          The implications ripple out in three directions: toward how we understand the public health crisis of loneliness, toward how we treat social anxiety disorders, and toward a question most researchers are still hesitant to ask aloud — whether the pain-management mechanisms humans evolved to cope with physical injury might be repurposed, pharmacologically, to treat the psychological aftermath of severe social loss.
        </p>
      </div>
    </div>
  );
}
