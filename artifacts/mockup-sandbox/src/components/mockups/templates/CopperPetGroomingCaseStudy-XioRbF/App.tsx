import { useState, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring, useInView } from 'framer-motion';
import { ArrowUpRight, ArrowDown, Plus, Minus, ArrowRight } from 'lucide-react';

const ACCENT = '#D9A06B';

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] } },
};

function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Label({ children, className = '' }) {
  return (
    <span className={`mono text-[11px] tracking-[0.22em] uppercase text-[#8a8278] ${className}`}>
      {children}
    </span>
  );
}

function Counter({ value, suffix = '', prefix = '' }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      <motion.span
        initial={{ opacity: 0 }}
        animate={inView ? { opacity: 1 } : {}}
        transition={{ duration: 0.6 }}
      >
        {value}
      </motion.span>
      {suffix}
    </span>
  );
}

const metrics = [
  { value: '312', suffix: '%', label: 'Increase in funded accounts within 90 days of relaunch' },
  { value: '4.9', suffix: '', label: 'App Store rating, up from 3.2 — across 18,400 new reviews' },
  { value: '11', suffix: 's', label: 'Median time to first portfolio view, down from 74 seconds' },
  { value: '$2.1', suffix: 'B', label: 'Assets under management onboarded through the new flow' },
];

const chapters = [
  {
    num: '01',
    title: 'The problem wasn\u2019t trust. It was translation.',
    body: 'Meridian\u2019s research kept surfacing the same word: \u201Cintimidating.\u201D Their original product spoke fluent Wall Street \u2014 basis points, expense ratios, rebalancing cadences \u2014 to an audience that had never owned a single share. We reframed the brief: don\u2019t simplify the product, simplify the language around it. Every screen was rewritten before it was redesigned.',
    img: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1400&h=900&fit=crop',
    caption: 'Early audit of the legacy dashboard \u2014 41 distinct data points above the fold.',
  },
  {
    num: '02',
    title: 'A type system that behaves like a calm advisor.',
    body: 'We built the interface around a single editorial voice: one serif for moments that matter, one grotesk for everything operational. Numbers got their own treatment \u2014 oversized, tabular, never abbreviated when money is involved. The result reads less like a terminal and more like a well-set annual letter.',
    img: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1400&h=900&fit=crop',
    caption: 'The portfolio summary, set in Fraunces 144pt. No sparklines until you ask for them.',
  },
  {
    num: '03',
    title: 'Onboarding rebuilt as a conversation, not a form.',
    body: 'Twenty-six fields became nine questions, asked one at a time, in plain English, with the \u201Cwhy\u201D one tap away. Risk tolerance is now expressed through scenarios (\u201CYour portfolio drops 12% in a month \u2014 what do you do?\u201D) instead of a 1\u20135 slider nobody understood. Drop-off at the funding step fell from 61% to 19%.',
    img: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=1400&h=900&fit=crop',
    caption: 'Scenario-based risk profiling replaced the legacy questionnaire entirely.',
  },
];

const process = [
  { phase: 'Discovery', weeks: 'Weeks 1\u20133', detail: '34 customer interviews, full funnel analytics audit, competitive teardown of 11 platforms.' },
  { phase: 'Language system', weeks: 'Weeks 3\u20135', detail: 'Voice principles, a 200-term plain-English glossary, microcopy patterns for every error state.' },
  { phase: 'Design system', weeks: 'Weeks 5\u201310', detail: '\u201CLedger\u201D \u2014 68 components, dark-first, built in Figma and shipped as a React library in parallel.' },
  { phase: 'Build & ship', weeks: 'Weeks 10\u201318', detail: 'Native iOS + Android with the in-house team. Feature-flagged rollout to 5%, 25%, then 100%.' },
];

export default function App() {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const heroRef = useRef(null);
  const { scrollYProgress: heroScroll } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const heroImgY = useTransform(heroScroll, [0, 1], ['0%', '18%']);
  const [openPhase, setOpenPhase] = useState(0);

  return (
    <div className="bg-[#0B0A09] text-[#E9E4DC] min-h-screen antialiased selection:bg-[#D9A06B] selection:text-[#0B0A09]">
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style dangerouslySetInnerHTML={{ __html: `
        body { background: #0B0A09; }
        .serif { font-family: 'Fraunces', Georgia, serif; }
        .sans { font-family: 'Inter', -apple-system, sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .grain::after {
          content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 50; opacity: 0.035;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }
        ::-webkit-scrollbar { width: 10px; }
        ::-webkit-scrollbar-track { background: #0B0A09; }
        ::-webkit-scrollbar-thumb { background: #2a2620; border-radius: 6px; border: 2px solid #0B0A09; }
        .img-frame { overflow: hidden; }
        .img-frame img { transition: transform 1.2s cubic-bezier(0.16,1,0.3,1), filter 1.2s ease; filter: saturate(0.85) contrast(1.02); }
        .img-frame:hover img { transform: scale(1.025); filter: saturate(1) contrast(1.04); }
        .hairline { background: linear-gradient(to right, transparent, #2e2a24 12%, #2e2a24 88%, transparent); height: 1px; }
        .next-link:hover .next-arrow { transform: translate(6px, -6px); }
        .next-arrow { transition: transform 0.4s cubic-bezier(0.16,1,0.3,1); }
      `}} />

      <div className="grain" />

      {/* progress bar */}
      <motion.div className="fixed top-0 left-0 right-0 h-[2px] origin-left z-[60]" style={{ scaleX: progress, background: ACCENT }} />

      {/* nav */}
      <header className="fixed top-0 left-0 right-0 z-40 mix-blend-difference">
        <div className="max-w-[1400px] mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
          <span className="serif text-xl tracking-tight">Halftone<span style={{ color: ACCENT }}>.</span></span>
          <nav className="hidden md:flex items-center gap-10 sans text-[13px] text-[#b8b0a4]">
            <a href="#" className="hover:text-white transition-colors">Work</a>
            <a href="#" className="hover:text-white transition-colors">Studio</a>
            <a href="#" className="hover:text-white transition-colors">Journal</a>
          </nav>
          <a href="#" className="mono text-[11px] tracking-[0.18em] uppercase border border-[#3a352e] rounded-full px-5 py-2.5 hover:border-[#D9A06B] hover:text-[#D9A06B] transition-colors">
            Start a project
          </a>
        </div>
      </header>

      {/* HERO */}
      <section ref={heroRef} className="relative pt-44 md:pt-56 pb-20 px-6 md:px-12">
        <div className="max-w-[1400px] mx-auto">
          <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}>
            <motion.div variants={fadeUp} className="flex items-center gap-4 mb-10">
              <Label>Case Study — 014</Label>
              <span className="hairline flex-1 max-w-[120px]" />
              <Label>Fintech / Mobile</Label>
            </motion.div>

            <motion.h1 variants={fadeUp} className="serif font-light text-[clamp(3rem,8.5vw,8.5rem)] leading-[0.95] tracking-[-0.02em] max-w-[16ch]">
              Meridian: wealth for people who hate
              <span className="italic" style={{ color: ACCENT }}> finance bros</span>.
            </motion.h1>

            <motion.div variants={fadeUp} className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-y-8 gap-x-8 border-t border-[#231f1a] pt-8">
              {[
                ['Client', 'Meridian Wealth, Inc.'],
                ['Timeline', '18 weeks · 2024'],
                ['Scope', 'Strategy, Brand voice, Product design, iOS & Android build'],
                ['Team', '2 designers · 3 engineers · 1 writer'],
              ].map(([k, v]) => (
                <div key={k}>
                  <Label className="block mb-2.5">{k}</Label>
                  <p className="sans text-[14px] leading-relaxed text-[#cfc8bd]">{v}</p>
                </div>
              ))}
            </motion.div>
          </motion.div>
        </div>

        {/* hero image */}
        <Reveal className="max-w-[1400px] mx-auto mt-16" delay={0.2}>
          <div className="img-frame relative rounded-[4px] overflow-hidden">
            <motion.img
              style={{ y: heroImgY }}
              src="https://images.unsplash.com/photo-1563986768609-322da13575f3?w=2000&h=1200&fit=crop"
              alt="Meridian app on device"
              className="w-full h-[52vh] md:h-[78vh] object-cover scale-[1.08]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0B0A09]/60 via-transparent to-[#0B0A09]/20 pointer-events-none" />
            <div className="absolute bottom-6 left-6 flex items-center gap-3">
              <span className="mono text-[10px] tracking-[0.2em] uppercase bg-[#0B0A09]/70 backdrop-blur-md px-3 py-1.5 rounded-full text-[#cfc8bd]">
                Relaunch · v4.0 “Quiet Money”
              </span>
            </div>
            <div className="absolute bottom-6 right-6 hidden md:flex items-center gap-2 mono text-[10px] tracking-[0.2em] uppercase text-[#8a8278]">
              Scroll <ArrowDown size={12} />
            </div>
          </div>
        </Reveal>
      </section>

      {/* INTRO STATEMENT */}
      <section className="px-6 md:px-12 py-28 md:py-40">
        <div className="max-w-[1400px] mx-auto grid md:grid-cols-12 gap-10">
          <div className="md:col-span-3">
            <Reveal><Label>The brief</Label></Reveal>
          </div>
          <div className="md:col-span-8">
            <Reveal>
              <p className="serif font-light text-[clamp(1.6rem,3.2vw,2.75rem)] leading-[1.3] tracking-[-0.01em] text-[#E9E4DC]">
                Meridian had the licenses, the custodian relationships, and $40M in funding. What they didn’t have was a product their own customers could explain to a friend. We spent eighteen weeks making investing feel less like homework and more like
                <span className="italic" style={{ color: ACCENT }}> hygiene</span> — something you do quietly, regularly, without ceremony.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="mt-10 flex flex-wrap gap-2.5">
                {['Product strategy', 'UX writing', 'Design system', 'Motion', 'React Native', 'Brand voice'].map(t => (
                  <span key={t} className="sans text-[12px] text-[#a39a8d] border border-[#2a2620] rounded-full px-4 py-1.5 hover:border-[#D9A06B]/50 hover:text-[#D9A06B] transition-colors cursor-default">
                    {t}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* METRICS */}
      <section className="px-6 md:px-12">
        <div className="max-w-[1400px] mx-auto border-y border-[#231f1a]">
          <div className="grid grid-cols-2 lg:grid-cols-4">
            {metrics.map((m, i) => (
              <Reveal key={m.label} delay={i * 0.08} className={`py-12 md:py-16 px-6 md:px-10 ${i !== 0 ? 'border-l border-[#231f1a]' : ''} ${i >= 2 ? 'border-t lg:border-t-0 border-[#231f1a]' : ''} ${i === 2 ? 'border-l-0 lg:border-l' : ''}`}>
                <p className="serif font-light text-[clamp(2.6rem,4.5vw,4.5rem)] leading-none tracking-[-0.02em]" style={{ color: ACCENT }}>
                  <Counter value={m.value} suffix={m.suffix} />
                </p>
                <p className="sans text-[13px] leading-relaxed text-[#9d958a] mt-5 max-w-[24ch]">{m.label}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CHAPTERS */}
      <section className="px-6 md:px-12 py-28 md:py-44 space-y-32 md:space-y-48">
        {chapters.map((ch, i) => (
          <div key={ch.num} className="max-w-[1400px] mx-auto">
            <div className={`grid md:grid-cols-12 gap-10 md:gap-16 items-start`}>
              <div className={`md:col-span-5 ${i % 2 === 1 ? 'md:order-2' : ''} md:sticky md:top-32`}>
                <Reveal>
                  <div className="flex items-baseline gap-4 mb-8">
                    <span className="serif italic text-[15px]" style={{ color: ACCENT }}>{ch.num}</span>
                    <span className="hairline flex-1" />
                  </div>
                  <h2 className="serif font-light text-[clamp(1.9rem,3.4vw,3.1rem)] leading-[1.12] tracking-[-0.015em]">
                    {ch.title}
                  </h2>
                  <p className="sans text-[15px] leading-[1.8] text-[#a39a8d] mt-7 max-w-[52ch]">
                    {ch.body}
                  </p>
                </Reveal>
              </div>
              <div className={`md:col-span-7 ${i % 2 === 1 ? 'md:order-1' : ''}`}>
                <Reveal delay={0.1}>
                  <div className="img-frame rounded-[4px]">
                    <img src={ch.img} alt={ch.caption} className="w-full h-[46vh] md:h-[68vh] object-cover" />
                  </div>
                  <div className="flex items-center gap-3 mt-4">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: ACCENT }} />
                    <p className="mono text-[11px] tracking-[0.06em] text-[#7c746a]">{ch.caption}</p>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* QUOTE */}
      <section className="px-6 md:px-12 py-24 md:py-36 bg-[#100E0C] border-y border-[#231f1a]">
        <div className="max-w-[1100px] mx-auto text-center">
          <Reveal>
            <span className="serif italic text-[clamp(4rem,8vw,7rem)] leading-none block mb-2" style={{ color: ACCENT }}>“</span>
            <blockquote className="serif font-light text-[clamp(1.7rem,3.5vw,3.2rem)] leading-[1.25] tracking-[-0.01em] -mt-8">
              Halftone didn’t redesign our app. They redesigned how we talk about money — the app just caught up.
            </blockquote>
            <div className="mt-12 flex flex-col items-center gap-1.5">
              <p className="sans text-[14px] font-medium text-[#E9E4DC]">Priya Raghunathan</p>
              <p className="mono text-[11px] tracking-[0.18em] uppercase text-[#7c746a]">Co-founder & CEO, Meridian</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* PROCESS ACCORDION */}
      <section className="px-6 md:px-12 py-28 md:py-40">
        <div className="max-w-[1400px] mx-auto grid md:grid-cols-12 gap-10">
          <div className="md:col-span-4">
            <Reveal>
              <Label>How it ran</Label>
              <h3 className="serif font-light text-[clamp(1.8rem,2.8vw,2.6rem)] leading-tight mt-5 max-w-[14ch]">
                Eighteen weeks, four movements.
              </h3>
            </Reveal>
          </div>
          <div className="md:col-span-8">
            {process.map((p, i) => {
              const open = openPhase === i;
              return (
                <Reveal key={p.phase} delay={i * 0.05}>
                  <button
                    onClick={() => setOpenPhase(open ? -1 : i)}
                    className="w-full text-left border-t border-[#231f1a] py-7 group"
                  >
                    <div className="flex items-center justify-between gap-6">
                      <div className="flex items-baseline gap-6 md:gap-10">
                        <span className="mono text-[11px] text-[#7c746a] w-20">{p.weeks}</span>
                        <span className={`serif text-[clamp(1.3rem,2vw,1.8rem)] font-light transition-colors ${open ? '' : 'group-hover:text-white'}`} style={open ? { color: ACCENT } : {}}>
                          {p.phase}
                        </span>
                      </div>
                      <span className="text-[#7c746a] group-hover:text-[#E9E4DC] transition-colors shrink-0">
                        {open ? <Minus size={18} /> : <Plus size={18} />}
                      </span>
                    </div>
                    <motion.div
                      initial={false}
                      animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
                      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="sans text-[14px] leading-relaxed text-[#a39a8d] pt-5 pl-0 md:pl-[6.5rem] max-w-[58ch]">
                        {p.detail}
                      </p>
                    </motion.div>
                  </button>
                </Reveal>
              );
            })}
            <div className="border-t border-[#231f1a]" />
          </div>
        </div>
      </section>

      {/* IMAGE PAIR */}
      <section className="px-6 md:px-12 pb-28 md:pb-44">
        <div className="max-w-[1400px] mx-auto grid md:grid-cols-2 gap-6">
          <Reveal>
            <div className="img-frame rounded-[4px]">
              <img src="https://images.unsplash.com/photo-1556742502-ec7c0e9f34b1?w=1200&h=1400&fit=crop" alt="Design system components" className="w-full h-[60vh] md:h-[80vh] object-cover" />
            </div>
            <p className="mono text-[11px] text-[#7c746a] mt-4">“Ledger” design system — 68 components, dark-first.</p>
          </Reveal>
          <Reveal delay={0.12} className="md:mt-24">
            <div className="img-frame rounded-[4px]">
              <img src="https://images.unsplash.com/photo-1551434678-e076c223a692?w=1200&h=1400&fit=crop" alt="Team working session" className="w-full h-[60vh] md:h-[80vh] object-cover" />
            </div>
            <p className="mono text-[11px] text-[#7c746a] mt-4">Embedded sprint with Meridian engineering, week 11.</p>
          </Reveal>
        </div>
      </section>

      {/* OUTCOME */}
      <section className="px-6 md:px-12 pb-28 md:pb-40">
        <div className="max-w-[1400px] mx-auto grid md:grid-cols-12 gap-10">
          <div className="md:col-span-3">
            <Reveal><Label>Outcome</Label></Reveal>
          </div>
          <div className="md:col-span-7">
            <Reveal>
              <p className="serif font-light text-[clamp(1.5rem,2.6vw,2.3rem)] leading-[1.35]">
                Meridian relaunched in March 2024. Within a quarter, funded accounts tripled, support tickets about “what does this mean?” dropped 84%, and the company closed its Series B citing the new product as the inflection point. The Ledger design system now ships every feature the team builds — without us.
              </p>
              <p className="sans text-[14px] leading-relaxed text-[#a39a8d] mt-8">
                Which is, as far as we’re concerned, the only acceptable ending.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* NEXT PROJECT */}
      <section className="border-t border-[#231f1a]">
        <a href="#" className="next-link block px-6 md:px-12 py-20 md:py-28 hover:bg-[#100E0C] transition-colors group">
          <div className="max-w-[1400px] mx-auto flex items-end justify-between gap-8">
            <div>
              <Label>Next case study</Label>
              <h4 className="serif font-light text-[clamp(2.2rem,5.5vw,5rem)] leading-[1.05] tracking-[-0.02em] mt-5">
                Northwind Freight —<br />
                <span className="italic text-[#a39a8d] group-hover:text-[#E9E4DC] transition-colors">logistics, but legible.</span>
              </h4>
            </div>
            <div className="next-arrow shrink-0 w-16 h-16 md:w-24 md:h-24 rounded-full border border-[#3a352e] flex items-center justify-center group-hover:border-[#D9A06B]" >
              <ArrowUpRight size={28} className="group-hover:text-[#D9A06B] transition-colors" />
            </div>
          </div>
        </a>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-[#231f1a] px-6 md:px-12 py-10">
        <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <span className="serif text-lg">Halftone<span style={{ color: ACCENT }}>.</span></span>
          <div className="flex items-center gap-8 mono text-[11px] tracking-[0.16em] uppercase text-[#7c746a]">
            <a href="#" className="hover:text-[#D9A06B] transition-colors flex items-center gap-1.5">hello@halftone.studio <ArrowRight size={12} /></a>
            <span>Brooklyn / Lisbon</span>
            <span>© 2025</span>
          </div>
        </div>
      </footer>
    </div>
  );
}