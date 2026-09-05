import "./_group.css";

export default function VersoArticle() {
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

      {/* ── Article title block — flat surface ── */}
      <div className="verso-article-title-block">
        <div className="verso-article-cat">Neuroscience</div>
        <h1 className="verso-article-h1">
          Your Brain Treats Social Rejection the Same Way It Processes Physical Pain
        </h1>
        <p className="verso-article-dek">
          New fMRI data from 14 universities reveals overlapping neural pathways — with implications for how we treat loneliness as a public health crisis.
        </p>
        <div className="verso-article-byline">
          <span className="name">Dr. Mia Chen</span>
          <span className="dot">·</span>
          <span>July 8, 2026</span>
          <span className="dot">·</span>
          <span>9 min read</span>
        </div>
      </div>

      {/* ── Full-bleed hero — flat, no glass ── */}
      <img
        className="verso-hero-full"
        src="https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=1400&q=85"
        alt=""
      />

      {/* ── Body — flat surface, solid bg ── */}
      <div className="verso-article-body">
        <p className="verso-body-p verso-dropcap">
          For decades, the metaphor of a "broken heart" was treated as poetic license — a way to describe emotional pain through the vocabulary of the body. Now, a landmark multi-site neuroimaging study suggests the metaphor is closer to literal truth than anyone had imagined.
        </p>

        <p className="verso-body-p">
          Researchers at fourteen universities, using coordinated fMRI protocols, have mapped the neural response to social exclusion with unprecedented resolution. The findings are striking: the anterior cingulate cortex and the right ventral prefrontal cortex — regions long associated with the unpleasantness of physical pain — activate with nearly identical signatures when a subject experiences rejection.
        </p>

        <div className="verso-pull">
          "The brain doesn't distinguish between the ache of a sprained ankle and the ache of being left out. Both are pain, processed by the same ancient circuitry."
        </div>

        <h2 className="verso-body-h2">Why Evolution Wired It This Way</h2>

        <p className="verso-body-p">
          The leading hypothesis is evolutionary: in ancestral environments, social exclusion was a mortal threat. Being cut off from the group meant reduced food access, exposure to predators, and loss of reproductive opportunity. An organism that experienced exile as genuinely painful would be strongly motivated to repair social bonds — and to avoid behaviors that risked them.
        </p>

        <p className="verso-body-p">
          Over millions of years, that motivational system borrowed the brain's existing pain infrastructure rather than building new circuitry. The result is a nervous system where loneliness and injury share not just a metaphor but a mechanism.
        </p>

        <h2 className="verso-body-h2">The Public Health Implications</h2>

        <p className="verso-body-p">
          If social pain is neurologically equivalent to physical pain, the corollary is sobering: chronic loneliness is not a mood problem. It is a pain disorder — one with measurable physiological consequences including elevated cortisol, disrupted sleep architecture, impaired immune function, and accelerated cardiovascular aging.
        </p>
      </div>
    </div>
  );
}
