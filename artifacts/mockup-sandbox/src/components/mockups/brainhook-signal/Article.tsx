import './_group.css';

export function Article() {
  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: '#fff', color: '#0A0A12', minHeight: '100vh' }}>
      {/* Header */}
      <header style={{ borderBottom: '2px solid #0A0A12', padding: '0 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 24, letterSpacing: 1 }}>
          BRAIN<span style={{ color: '#0057FF' }}>HOOK</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#7B2FFF', letterSpacing: 2, textTransform: 'uppercase' }}>Neuroscience</span>
          <div style={{ width: 1, height: 20, background: '#E8E8F0' }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0' }}>9 min read</span>
        </div>
      </header>

      {/* Article header */}
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '52px 40px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
          <span style={{ display: 'inline-block', width: 3, height: 16, background: '#7B2FFF' }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#7B2FFF', letterSpacing: 2, textTransform: 'uppercase' }}>Neuroscience &amp; Longevity</span>
        </div>
        <h1 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 58, fontWeight: 700, lineHeight: 1.0, margin: '0 0 22px', color: '#0A0A12' }}>
          Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
        </h1>
        <p style={{ fontSize: 18, lineHeight: 1.65, color: '#3A3A52', margin: '0 0 32px', fontWeight: 400 }}>
          New fMRI data from 14 universities reveals overlapping neural pathways — with implications for how we treat loneliness as a public health crisis.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, paddingBottom: 24, borderBottom: '1px solid #E8E8F0', marginBottom: 36 }}>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500 }}>Dr. Mia Chen</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0', marginTop: 2 }}>Neuroscience Correspondent</div>
          </div>
          <div style={{ height: 32, width: 1, background: '#E8E8F0' }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0' }}>Jul 8, 2026</span>
          <div style={{ height: 32, width: 1, background: '#E8E8F0' }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0' }}>9 min read</span>
        </div>
      </div>

      {/* Hero image — wide */}
      <div style={{ maxWidth: 1100, margin: '0 auto 0', padding: '0 40px' }}>
        <img src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1020&h=440&fit=crop&auto=format" alt="" style={{ width: '100%', display: 'block', objectFit: 'cover' }} />
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0', padding: '8px 0', letterSpacing: 0.5 }}>fMRI scans used in the University of Michigan / UCLA collaborative study, 2026.</div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '36px 40px 80px' }}>
        <p style={{ fontSize: 17, lineHeight: 1.8, color: '#1A1A2A', margin: '0 0 24px' }}>
          When Ethan Kross published his landmark 2011 study in the <em>Proceedings of the National Academy of Sciences</em>, the finding landed like a minor earthquake in neuroscience: the same brain regions that light up when we stub a toe — the secondary somatosensory cortex, the dorsal posterior insula — activate with near-identical intensity when we are socially excluded.
        </p>
        <p style={{ fontSize: 17, lineHeight: 1.8, color: '#1A1A2A', margin: '0 0 24px' }}>
          Twelve years later, a consortium of 14 universities has replicated and extended that finding. The verdict is more emphatic than the original: social rejection doesn't just borrow the pain network's infrastructure. In roughly 40% of participants, the neural response to exclusion is measurably <em>stronger</em> than the response to mild physical discomfort.
        </p>
        {/* Blockquote */}
        <div style={{ borderLeft: '3px solid #0057FF', paddingLeft: 24, margin: '32px 0', color: '#3A3A52', fontSize: 17, lineHeight: 1.65, fontStyle: 'italic' }}>
          "We're not speaking metaphorically when we say rejection hurts. We're describing a biological event with measurable neurochemical consequences." — Dr. Sara Castellano, lead author
        </div>
        <p style={{ fontSize: 17, lineHeight: 1.8, color: '#1A1A2A', margin: '0 0 24px' }}>
          The implications ripple out in three directions: toward how we understand the public health crisis of loneliness, toward how we treat social anxiety disorders, and toward a question most researchers are still hesitant to ask aloud — whether pain-management mechanisms might be repurposed to treat the psychological aftermath of severe social loss.
        </p>
      </div>
    </div>
  );
}
