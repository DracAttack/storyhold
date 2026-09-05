import './_group.css';

const CATS = ['Psychology', 'Neuroscience', 'Astronomy', 'Earth & Climate', 'Culture & Media', 'Gross Science'];
const CAT_COLORS: Record<string, string> = {
  Neuroscience: '#7B2FFF', Psychology: '#0057FF', Astronomy: '#00A86B',
  'Earth & Climate': '#00BCD4', 'Culture & Media': '#FF6B35', 'Gross Science': '#E91E63',
};

const HERO = {
  category: 'Neuroscience',
  headline: 'Your Brain Treats Social Rejection the Same Way It Processes Physical Pain',
  dek: 'New fMRI data from 14 universities reveals overlapping neural pathways — with implications for how we treat loneliness as a public health crisis.',
  author: 'Dr. Mia Chen', readTime: '9 min',
};

const ARTICLES = [
  { category: 'Psychology', headline: "The Dunning-Kruger Effect Is More Complicated Than You Think", dek: "Psychologists revisit the famous bias — and find it only holds in certain conditions.", author: 'J. Kowalski', readTime: '7 min', img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=480&h=320&fit=crop&auto=format' },
  { category: 'Astronomy', headline: 'Astronomers Detect a Rogue Planet Carrying Its Own Moon System', dek: 'A free-floating world 200 light-years away challenges planet formation models.', author: 'P. Nakamura', readTime: '6 min', img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=480&h=320&fit=crop&auto=format' },
  { category: 'Earth & Climate', headline: "Deep-Ocean Microbes Are Eating Plastic at Rates Scientists Didn't Expect", dek: 'Hadal trenches show enzymatic degradation 40% faster than surface estimates.', author: 'S. Abara', readTime: '8 min', img: 'https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=480&h=320&fit=crop&auto=format' },
];

export function Home() {
  const cc = CAT_COLORS[HERO.category] ?? '#0057FF';
  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: '#fff', color: '#0A0A12', minHeight: '100vh', overflowX: 'hidden' }}>
      {/* Header */}
      <header style={{ borderBottom: '2px solid #0A0A12', padding: '0 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 24, letterSpacing: 1, color: '#0A0A12' }}>
            BRAIN<span style={{ color: '#0057FF' }}>HOOK</span>
          </span>
          <nav style={{ display: 'flex', gap: 20 }}>
            {CATS.slice(0, 5).map(c => (
              <span key={c} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 0.8, color: '#5A5A72', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{c}</span>
            ))}
          </nav>
        </div>
        <button style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 500, background: '#0057FF', color: '#fff', border: 'none', padding: '8px 18px', cursor: 'pointer', letterSpacing: 1.5 }}>SUBSCRIBE →</button>
      </header>

      {/* Hero — sharp 50/50 split */}
      <section style={{ display: 'grid', gridTemplateColumns: '55% 45%', borderBottom: '2px solid #0A0A12', minHeight: 480 }}>
        <div style={{ overflow: 'hidden', borderRight: '2px solid #0A0A12' }}>
          <img
            src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=900&h=560&fit=crop&auto=format"
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
        <div style={{ padding: '44px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
              <span style={{ display: 'inline-block', width: 3, height: 16, background: cc }} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: cc, letterSpacing: 2, textTransform: 'uppercase' }}>{HERO.category}</span>
            </div>
            <h1 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 46, fontWeight: 700, lineHeight: 1.05, margin: '0 0 18px', color: '#0A0A12' }}>{HERO.headline}</h1>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: '#3A3A52', margin: 0 }}>{HERO.dek}</p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 20, borderTop: '1px solid #E8E8F0' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#7A7A90' }}>{HERO.author}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#7A7A90' }}>{HERO.readTime} read</span>
          </div>
        </div>
      </section>

      {/* Grid header */}
      <div style={{ padding: '18px 48px', borderBottom: '1px solid #E8E8F0', display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0', letterSpacing: 2, textTransform: 'uppercase' }}>latest_signals[ ]</span>
        <div style={{ flex: 1, height: 1, background: '#E8E8F0' }} />
      </div>

      {/* Article grid */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', padding: '28px 48px 56px', gap: 0 }}>
        {ARTICLES.map((a, i) => {
          const ac = CAT_COLORS[a.category] ?? '#0057FF';
          return (
            <article key={i} style={{ paddingRight: i < 2 ? 28 : 0, paddingLeft: i > 0 ? 28 : 0, borderLeft: i > 0 ? '1px solid #E8E8F0' : 'none' }}>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <img src={a.img} alt="" style={{ width: '100%', aspectRatio: '3/2', objectFit: 'cover', display: 'block' }} />
                <div style={{ position: 'absolute', top: 0, left: 0, width: 4, height: '100%', background: ac }} />
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: ac, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>{a.category}</div>
              <h2 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 24, fontWeight: 700, lineHeight: 1.1, margin: '0 0 8px', color: '#0A0A12' }}>{a.headline}</h2>
              <p style={{ fontSize: 13, lineHeight: 1.55, color: '#5A5A72', margin: '0 0 14px' }}>{a.dek}</p>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#9A9AB0', display: 'flex', gap: 16 }}>
                <span>{a.author}</span><span>{a.readTime}</span>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
