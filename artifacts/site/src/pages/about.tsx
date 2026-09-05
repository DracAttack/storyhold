import { motion } from "framer-motion";
import NewsletterCTA from "@/components/article/NewsletterCTA";
import { useSeo } from "@/lib/seo";

export default function AboutPage() {
  useSeo({
    title: "About BrainHook — Our Story & How We Work",
    description:
      "How BrainHook began as a personal curiosity engine and grew into a human-directed, AI-assisted publication — and how we research, write, and edit the stories we publish.",
    canonicalPath: "/about",
    type: "website",
  });
  return (
    <div className="pb-24">
      {/* Hero Header */}
      <header className="bg-primary text-primary-foreground py-20 md:py-32">
        <div className="container mx-auto px-4 text-center max-w-4xl relative">
          <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)', backgroundSize: '24px 24px' }}></div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <span className="text-sm font-bold uppercase tracking-widest mb-6 block text-primary-foreground/80">About BrainHook</span>
            <h1 className="font-serif text-5xl md:text-7xl font-bold leading-tight mb-8">
              Real Research.<br />No BS.
            </h1>
            <p className="text-xl md:text-2xl font-body leading-relaxed text-primary-foreground/90">
              BrainHook was founded on a simple premise: respect the reader's intellect. We tell stories that illuminate the human experience, the workings of the mind, and the mysteries of the universe.
            </p>
          </motion.div>
        </div>
      </header>

      {/* Story + how it works */}
      <section className="container mx-auto px-4 py-20 max-w-3xl">
        <div className="prose prose-lg dark:prose-invert prose-primary mx-auto prose-headings:font-serif">
          <p className="text-2xl leading-relaxed font-serif text-foreground/90 mb-12 text-center">
            In an era of algorithmic optimization and outrage-driven engagement, truth has too often become a secondary metric. We are building something different.
          </p>

          <h2>What BrainHook is</h2>
          <p>
            BrainHook is a magazine for the intellectually curious — a publication that chases the
            questions worth following: new research, psychological patterns, scientific discoveries,
            cultural oddities, and the unexpected connections between them. We translate complex ideas
            into accessible, energetic prose without dumbing them down, and we'd rather leave you
            thinking than leave you anxious. If a story doesn't teach you something meaningful about
            the world or yourself, we don't publish it.
          </p>

          <h2>How BrainHook began</h2>
          <p>
            BrainHook started as something much smaller: a personal way to keep up with the subjects
            that fascinated me.
          </p>
          <p>
            I've always been the kind of person who collects questions — passing thoughts, strange
            connections, new research, cultural shifts, and those moments when two seemingly unrelated
            ideas suddenly click together. Artificial intelligence gave me a way to explore those
            questions quickly, follow the threads further, and discover whether a connection was
            insightful, ridiculous, or somehow both.
          </p>
          <p>
            At first, BrainHook was simply a private experiment. I created distinct subject profiles
            designed to follow particular fields, search for emerging stories and newly published
            research, and bring me a fresh spread of ideas each day. It became a kind of personalized
            curiosity engine: part research assistant, part morning newspaper, and part intellectual
            rabbit hole.
          </p>
          <p>
            Eventually, I realized there was little reason to keep all of it to myself. The questions I
            was asking were not uniquely mine. Other people might be curious about the same studies,
            trends, psychological patterns, scientific discoveries, cultural oddities, and unexpected
            connections. BrainHook grew from a personal research project into a publication built to
            make those ideas accessible, engaging, and worth spending time with.
          </p>
          <p className="font-serif text-xl text-foreground/90 border-l-4 border-primary pl-6 not-italic">
            That is still the heart of the project. One interesting question. One unexpected
            connection. One more hook for the brain.
          </p>

          <h2>Who makes BrainHook</h2>
          <p>
            BrainHook combines human curiosity and editorial judgment with AI-assisted research and
            production tools.
          </p>
          <p>
            Some articles are written directly by members of our editorial team using AI-assisted
            research. Others are developed collaboratively through our research and writing systems,
            then reviewed and shaped before publication.
          </p>
          <p>
            Some contributor profiles represent real people publishing under pseudonyms — for privacy,
            safety, or creative freedom.
          </p>
          <p>
            For a complete explanation of how we use AI, review sources, distinguish reporting from
            interpretation, and correct mistakes, read our{" "}
            <a href="/editorial-policy">Editorial Policy &amp; AI Disclosure</a>.
          </p>

          <p className="font-serif text-xl text-foreground/90 mt-12">
            — Damien Lynn, Editor
          </p>

          <h2>Masthead &amp; ownership</h2>
          <ul>
            <li>
              <strong>Editor</strong> — Damien Lynn
            </li>
            <li>
              <strong>Publisher</strong> — Brainhook Media, Phoenix, Arizona, USA
            </li>
            <li>
              <strong>Editorial contact</strong> —{" "}
              <a href="mailto:editor@brainhook.net">editor@brainhook.net</a>
            </li>
            <li>
              <strong>Corrections</strong> —{" "}
              <a href="mailto:editor@brainhook.net">editor@brainhook.net</a> (see our{" "}
              <a href="/corrections">Corrections Policy</a>)
            </li>
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4">
        <NewsletterCTA />
      </section>
    </div>
  );
}
