import './_group.css';

const CATS = ['Psychology & Behavior', 'Neuroscience', 'Astronomy & Space', 'Earth & Climate', 'Culture & Media', 'Science History'];

const ARTICLES = [
  { category: 'Psychology', headline: "The Dunning-Kruger Effect Is More Complicated Than You Think", dek: "Psychologists revisit the famous bias — and find it only holds in certain conditions.", author: 'J. Kowalski', readTime: '7 min', img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=480&h=320&fit=crop&auto=format' },
  { category: 'Astronomy', headline: 'A Rogue Planet 200 Light-Years Away Is Carrying Its Own Moon System', dek: 'Free-floating worlds were supposed to be barren. This one upended that assumption.', author: 'P. Nakamura', readTime: '6 min', img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=480&h=320&fit=crop&auto=format' },
  { category: 'Earth & Climate', headline: "Hadal Microbes Are Dissolving Plastic. We Had No Idea.", dek: 'Enzymatic degradation rates in the deep ocean are 40% faster than surface estimates.', author: 'S. Abara', readTime: '8 min', img: 'https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=480&h=320&fit=crop&auto=format' },
];

export function Home() {
  return (
    <div style={{ fontFamily: "'Source Serif 4', Georgia, serif", background: '#F9F8F5', color: '#141414', minHeight: '100vh', overflowX: 'hidden' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #D8D6D0', padding: '0 56px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
          <nav style={{ display: 'flex', gap: 24 }}>
            {CATS.slice(0, 3).map(c => (
              <span key={c} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: 0.5, color: '#888880', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{c}</span>
            ))}
          </nav>
          <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 800, fontSize: 28, letterSpacing: -1, color: '#141414' }}>
            Brain<span style={{ color: '#2B7D6E' }}>Hook</span>
          </span>
          <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
            {CATS.slice(3).map(c => (
              <span key={c} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: 0.5, color: '#888880', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{c}</span>
            ))}
          </div>
        </div>
      </header>

      {/* Category ribbon */}
      <div style={{ borderBottom: '1px solid #D8D6D0', padding: '10px 56px', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2B7D6E', letterSpacing: 1, textTransform: 'uppercase', fontWeight: 500 }}>Real Research.</span>
        <div style={{ flex: 1, height: 1, background: '#D8D6D0', margin: '0 16px' }} />
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880', letterSpacing: 1, textTransform: 'uppercase' }}>July 2026 · Vol. 3</span>
      </div>

      {/* Hero — 55/45 editorial split */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #D8D6D0', minHeight: 460 }}>
        {/* Text side */}
        <div style={{ padding: '52px 56px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderRight: '1px solid #D8D6D0' }}>
          <div>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2B7D6E', letterSpacing: 1.5, textTransform: 'uppercase', display: 'block', marginBottom: 16 }}>Neuroscience &amp; Longevity</span>
            <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 44, fontWeight: 800, lineHeight: 1.1, margin: '0 0 20px', color: '#141414', letterSpacing: -0.5 }}>
              Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
            </h1>
            {/* Signature: large italic dek as pullquote */}
            <p style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 20, fontStyle: 'italic', lineHeight: 1.6, color: '#4A4A44', margin: '0 0 24px', fontWeight: 600 }}>
              New fMRI data from 14 universities reveals overlapping neural pathways — with implications for how we treat loneliness as a public health crisis.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#D8D6D0', overflow: 'hidden' }}>
              <img src="https://images.unsplash.com/photo-1494790108755-2616b612b786?w=64&h=64&fit=crop&auto=format" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 500, color: '#141414' }}>Dr. Mia Chen</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880' }}>Jul 8, 2026 · 9 min</div>
            </div>
          </div>
        </div>
        {/* Image side */}
        <div style={{ overflow: 'hidden' }}>
          <img src="https://images.unsplash.com/photo-1559757175-5700dde675bc?w=720&h=520&fit=crop&auto=format" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      </section>

      {/* Section label */}
      <div style={{ padding: '20px 56px', display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid #D8D6D0' }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#888880', letterSpacing: 2, textTransform: 'uppercase' }}>Also in this issue</span>
        <div style={{ flex: 1, height: 1, background: '#D8D6D0' }} />
      </div>

      {/* Article grid */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', padding: '28px 56px 60px', gap: 0 }}>
        {ARTICLES.map((a, i) => (
          <article key={i} style={{ paddingRight: i < 2 ? 32 : 0, paddingLeft: i > 0 ? 32 : 0, borderLeft: i > 0 ? '1px solid #D8D6D0' : 'none' }}>
            <img src={a.img} alt="" style={{ width: '100%', aspectRatio: '3/2', objectFit: 'cover', display: 'block', marginBottom: 16 }} />
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2B7D6E', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>{a.category}</span>
            <h2 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 22, fontWeight: 700, lineHeight: 1.2, margin: '0 0 8px', color: '#141414' }}>{a.headline}</h2>
            {/* Italic dek — the signature element, consistent with article page */}
            <p style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 14, fontStyle: 'italic', lineHeight: 1.55, color: '#5A5A54', margin: '0 0 14px' }}>{a.dek}</p>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#A0A09A', display: 'flex', gap: 12 }}>
              <span>{a.author}</span><span>·</span><span>{a.readTime}</span>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
