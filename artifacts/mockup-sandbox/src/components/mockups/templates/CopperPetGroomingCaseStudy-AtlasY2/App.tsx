import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, ChevronRight, Circle, Menu, X } from 'lucide-react';

const chapters = [
  {
    id: 'context',
    number: '01',
    eyebrow: 'The brief',
    title: 'Make the quiet work impossible to miss.',
    body: 'Midnight Paw Studio had a loyal following and a beautiful point of view. What was missing was a way to make the care behind every appointment legible before a client ever walked through the door.',
    note: 'A grooming studio with a point of view.',
  },
  {
    id: 'ritual',
    number: '02',
    eyebrow: 'The ritual',
    title: 'Turn a service into a signature.',
    body: 'We mapped the visit as a sequence of small assurances: the handoff, the first brush, the final mirror moment. The identity now gives each one room to breathe, without making the work feel precious.',
    note: '16 touchpoints mapped / 4 retained',
  },
  {
    id: 'result',
    number: '03',
    eyebrow: 'The result',
    title: 'A studio people can feel before they arrive.',
    body: 'The new system gives the team a warmer way to explain their craft and gives clients a faster way to choose the right ritual for their dog. More clarity. Less convincing.',
    note: 'From first visit to favourite place.',
  },
];

const services = [
  { name: 'The Reset', time: '45 min', detail: 'For a fresh start between full grooms.' },
  { name: 'The Signature', time: '90 min', detail: 'The studio’s complete cut, finish, and ritual.' },
  { name: 'The Long Coat', time: '120 min', detail: 'Patient, precise care for a little more to love.' },
];

function Stamp({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#c8835d]/50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[#c8835d]">
      {children}
    </span>
  );
}

export default function App() {
  const [active, setActive] = useState('context');
  const [menuOpen, setMenuOpen] = useState(false);
  const current = chapters.find((chapter) => chapter.id === active) ?? chapters[0];

  return (
    <main className="min-h-[100dvh] overflow-hidden bg-[#ece5d8] text-[#24211f] selection:bg-[#c8835d] selection:text-[#f8f3ea]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,600&display=swap');
        .atlas-serif { font-family: 'Fraunces', Georgia, serif; }
        .atlas-sans { font-family: 'DM Sans', sans-serif; }
        .atlas-mono { font-family: 'DM Mono', monospace; }
        .atlas-grid { background-image: linear-gradient(to right, rgba(36,33,31,.07) 1px, transparent 1px); background-size: 25% 100%; }
        .atlas-noise { position: relative; }
        .atlas-noise:after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .12; mix-blend-mode: multiply; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 160 160' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.28'/%3E%3C/svg%3E"); }
      `}</style>

      <header className="atlas-sans relative z-20 flex items-center justify-between border-b border-[#24211f]/15 px-5 py-5 md:px-12">
        <div className="flex items-center gap-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#24211f]/30 text-[12px] font-semibold">MP</div>
          <span className="hidden text-[11px] uppercase tracking-[0.25em] text-[#6d665f] sm:block">Midnight Paw Studio</span>
        </div>
        <div className="hidden items-center gap-7 text-[11px] uppercase tracking-[0.2em] text-[#6d665f] md:flex">
          <span>Case file 04—24</span><span className="h-1 w-1 rounded-full bg-[#c8835d]" /><span>Portland, OR</span>
        </div>
        <button onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle project menu" className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[#24211f]">
          {menuOpen ? <X size={17} strokeWidth={1.5} /> : <Menu size={17} strokeWidth={1.5} />} <span className="hidden sm:block">Index</span>
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.nav initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="absolute right-5 top-[70px] z-30 w-56 border border-[#24211f]/20 bg-[#f4eee4] p-5 shadow-xl md:right-12">
              {['Project / 04—24', 'Next case study / 05—24', 'Studio notes / 08'].map((item) => <button key={item} onClick={() => setMenuOpen(false)} className="atlas-mono block w-full border-b border-[#24211f]/10 py-3 text-left text-[10px] uppercase tracking-[.15em] text-[#6d665f] last:border-0">{item}</button>)}
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      <section className="atlas-grid atlas-noise relative grid min-h-[690px] grid-cols-1 md:grid-cols-12">
        <div className="relative z-10 flex flex-col justify-between px-5 py-12 md:col-span-7 md:px-12 md:py-20">
          <div><Stamp>Brand / Experience</Stamp><p className="atlas-mono mt-6 text-[11px] uppercase tracking-[.2em] text-[#8c8176]">A case study in three movements</p></div>
          <div className="max-w-[720px]">
            <h1 className="atlas-serif text-[clamp(4rem,9.4vw,9.5rem)] font-light leading-[.84] tracking-[-.065em]">Make room<br /><em className="text-[#c8835d]">for care.</em></h1>
            <div className="mt-10 flex max-w-md items-start gap-4 border-t border-[#24211f]/25 pt-5">
              <Circle size={12} fill="#c8835d" strokeWidth={0} className="mt-1 shrink-0" />
              <p className="atlas-sans text-sm leading-relaxed text-[#6d665f]">A new identity and client experience for the grooming studio that treats the in-between moments as the main event.</p>
            </div>
          </div>
          <div className="atlas-mono flex items-center gap-6 text-[10px] uppercase tracking-[.2em] text-[#8c8176]"><span>Scroll to inspect</span><span className="h-px w-16 bg-[#c8835d]" /></div>
        </div>
        <div className="relative min-h-[390px] overflow-hidden md:col-span-5 md:min-h-0">
          <img src="/__mockup/images/atlasY2-hero-terrier.png" alt="Cream terrier on a grooming table" className="absolute inset-0 h-full w-full object-cover grayscale-[.15]" />
          <div className="absolute inset-0 bg-[#c8835d]/10 mix-blend-multiply" />
          <div className="absolute bottom-7 left-7 right-7 flex items-end justify-between text-[#f4eee4]"><span className="atlas-mono text-[10px] uppercase tracking-[.2em]">Portrait 01 / 03</span><ArrowUpRight size={23} strokeWidth={1.2} /></div>
        </div>
      </section>

      <section className="atlas-sans mx-auto grid max-w-[1440px] grid-cols-1 border-b border-[#24211f]/15 px-5 py-16 md:grid-cols-12 md:px-12 md:py-24">
        <aside className="md:col-span-3">
          <p className="atlas-mono sticky top-8 text-[10px] uppercase tracking-[.22em] text-[#8c8176]">Read the room</p>
          <div className="mt-8 hidden h-px w-16 bg-[#c8835d] md:block" />
        </aside>
        <div className="md:col-span-8 md:col-start-5">
          <p className="atlas-serif text-[clamp(1.9rem,3.6vw,3.7rem)] font-light leading-[1.08] tracking-[-.035em]">Grooming is often described as a before and after. We built this studio around everything that happens <em className="text-[#c8835d]">between.</em></p>
          <div className="mt-12 grid grid-cols-2 gap-8 border-t border-[#24211f]/15 pt-6 sm:grid-cols-3">
            {[['18', 'weeks in studio'], ['04', 'rituals named'], ['01', 'new point of view']].map(([value, label]) => <div key={label}><p className="atlas-serif text-4xl font-light text-[#c8835d]">{value}</p><p className="atlas-mono mt-2 text-[10px] uppercase tracking-[.15em] text-[#8c8176]">{label}</p></div>)}
          </div>
        </div>
      </section>

      <section className="atlas-sans mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-5 py-16 md:grid-cols-12 md:gap-0 md:px-12 md:py-24">
        <aside className="md:col-span-3"><p className="atlas-mono text-[10px] uppercase tracking-[.22em] text-[#8c8176]">The three movements</p><div className="mt-6 text-xs text-[#8c8176]">Use the index to move through the thinking.</div></aside>
        <div className="md:col-span-8 md:col-start-5">
          <div className="mb-12 flex border-b border-[#24211f]/15">
            {chapters.map((chapter) => <button key={chapter.id} onClick={() => setActive(chapter.id)} className={`relative mr-8 pb-4 atlas-mono text-[11px] uppercase tracking-[.18em] transition-colors ${active === chapter.id ? 'text-[#c8835d]' : 'text-[#8c8176]'}`}><span className="mr-2">{chapter.number}</span>{active === chapter.id && <motion.span layoutId="activeLine" className="absolute bottom-[-1px] left-0 right-0 h-[2px] bg-[#c8835d]" />}</button>)}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={current.id} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: .35 }}>
              <Stamp>{current.eyebrow}</Stamp>
              <h2 className="atlas-serif mt-7 max-w-2xl text-[clamp(2.6rem,5vw,5.6rem)] font-light leading-[.95] tracking-[-.05em]">{current.title}</h2>
              <p className="atlas-sans mt-8 max-w-lg text-base leading-[1.7] text-[#6d665f]">{current.body}</p>
              <p className="atlas-mono mt-12 border-l-2 border-[#c8835d] pl-4 text-[10px] uppercase tracking-[.18em] text-[#8c8176]">{current.note}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <section className="bg-[#24211f] px-5 py-16 text-[#f4eee4] md:px-12 md:py-24">
        <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-12 md:grid-cols-12">
          <div className="md:col-span-3"><p className="atlas-mono text-[10px] uppercase tracking-[.22em] text-[#c8835d]">Choose your ritual</p><p className="atlas-sans mt-5 max-w-[20ch] text-sm leading-relaxed text-[#a9a096]">Simple names. Clear expectations. A better way to begin.</p></div>
          <div className="md:col-span-8 md:col-start-5">
            {services.map((service, index) => <button key={service.name} className="group flex w-full items-center justify-between border-t border-[#f4eee4]/20 py-6 text-left transition-colors hover:border-[#c8835d]" onClick={() => setActive(chapters[index]?.id ?? 'context')}><div><p className="atlas-serif text-3xl font-light">{service.name}</p><p className="atlas-sans mt-2 text-sm text-[#a9a096]">{service.detail}</p></div><div className="flex items-center gap-8"><span className="atlas-mono text-[10px] uppercase tracking-[.15em] text-[#a9a096]">{service.time}</span><ChevronRight className="text-[#c8835d] transition-transform group-hover:translate-x-1" size={18} strokeWidth={1.2} /></div></button>)}
            <button className="atlas-sans mt-8 flex items-center gap-3 bg-[#c8835d] px-5 py-3 text-sm text-[#24211f] transition-colors hover:bg-[#e09a70]">Book a studio conversation <ArrowUpRight size={16} /></button>
          </div>
        </div>
      </section>

      <footer className="atlas-sans flex flex-col justify-between gap-6 bg-[#ece5d8] px-5 py-8 text-[11px] uppercase tracking-[.16em] text-[#8c8176] md:flex-row md:px-12"><span>Midnight Paw Studio — Portland</span><span>Built for the long coat &nbsp;·&nbsp; © 2024</span></footer>
    </main>
  );
}