import React from "react";
import { Copy, Share2, Download, Quote, ChevronRight, Lightbulb, Ban, AlertTriangle, BookOpen, ArrowUpRight } from "lucide-react";
import "./_group.css";

export function NoirPlate() {
  return (
    <div className="min-h-screen bg-[hsl(240,11%,6%)] text-[hsl(43,27%,91%)] font-lato selection:bg-[hsl(33,88%,63%)]/20 selection:text-[hsl(33,88%,63%)] pb-32">
      {/* Header */}
      <header className="border-b border-[hsl(240,9%,18%)] py-4 px-6 md:px-12 flex items-center justify-between sticky top-0 z-50 bg-[hsl(240,11%,6%)]/90 backdrop-blur-md">
        <div className="font-zilla font-bold text-2xl tracking-tight text-[hsl(43,27%,91%)] flex items-center">
          Brain<span className="text-[hsl(33,88%,63%)]">Hook</span>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-6 md:px-12 pt-16 md:pt-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16 xl:gap-20 items-start">
          
          {/* Left Column: Hero Typography & Definition */}
          <div className="lg:col-span-7">
            <div className="mb-6 flex items-center gap-3">
              <div className="h-px w-8 bg-[hsl(33,88%,63%)]"></div>
              <span className="text-[hsl(33,88%,63%)] font-bold text-sm tracking-widest uppercase">
                Glossary Term
              </span>
            </div>
            
            <h1 className="font-zilla text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight text-white mb-8">
              Cognitive function
            </h1>
            
            <div className="text-[20px] md:text-[22px] text-[hsl(43,27%,80%)] leading-relaxed max-w-3xl mb-10 font-light">
              The mental processes your brain uses to take in, store, and use information. This encompasses a wide range of mental abilities including memory, attention, language, problem-solving, and decision-making. It's essentially the engine room of human consciousness.
            </div>

            {/* Inline Meta Info */}
            <div className="space-y-3 pt-6 border-t border-[hsl(240,9%,18%)] text-[15px]">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[hsl(240,7%,62%)] uppercase tracking-wider text-xs font-bold w-32">Also known as:</span>
                <span className="text-[hsl(43,27%,91%)]">cognitive process, mental function, cognitive ability</span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[hsl(240,7%,62%)] uppercase tracking-wider text-xs font-bold w-32">Confused with:</span>
                <a href="#" className="inline-flex items-center text-[hsl(33,88%,63%)] hover:underline underline-offset-4">
                  Cognitive distortion <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                </a>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[hsl(240,7%,62%)] uppercase tracking-wider text-xs font-bold w-32">A type of:</span>
                <a href="#" className="text-[hsl(199,89%,48%)] hover:underline decoration-dotted underline-offset-4">Cognition</a>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[hsl(240,7%,62%)] uppercase tracking-wider text-xs font-bold w-32">See also:</span>
                <a href="#" className="text-[hsl(199,89%,48%)] hover:underline decoration-dotted underline-offset-4">Executive function</a>
              </div>
            </div>
          </div>

          {/* Right Column: Floating Plate */}
          <div className="lg:col-span-5 lg:sticky lg:top-24">
            <div className="bg-[hsl(240,7%,9%)] border border-[hsl(240,9%,18%)] rounded-xl p-5 shadow-[0_0_40px_rgba(245,168,78,0.08)] ring-1 ring-[hsl(33,88%,63%)]/20 relative">
              <div className="mb-4">
                <h3 className="text-sm font-medium text-white mb-1">Share this term</h3>
                <p className="text-xs text-[hsl(240,7%,62%)]">Grab the reference card or cite it in your work.</p>
              </div>
              
              <div className="rounded-lg overflow-hidden border border-[hsl(240,9%,18%)] mb-5 bg-black">
                <img 
                  src="/__mockup/images/glossary-share-card.jpg" 
                  alt="Cognitive function - Share Card" 
                  className="w-full h-auto object-cover opacity-90 hover:opacity-100 transition-opacity"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[hsl(240,9%,13%)] hover:bg-[hsl(240,9%,18%)] text-white rounded-lg text-sm font-medium transition-colors border border-[hsl(240,9%,18%)] hover:border-[hsl(33,88%,63%)]/30">
                  <Copy className="w-4 h-4 text-[hsl(33,88%,63%)]" />
                  <span>Copy def</span>
                </button>
                <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[hsl(240,9%,13%)] hover:bg-[hsl(240,9%,18%)] text-white rounded-lg text-sm font-medium transition-colors border border-[hsl(240,9%,18%)] hover:border-[hsl(33,88%,63%)]/30">
                  <Share2 className="w-4 h-4 text-[hsl(33,88%,63%)]" />
                  <span>Share link</span>
                </button>
                <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[hsl(240,9%,13%)] hover:bg-[hsl(240,9%,18%)] text-white rounded-lg text-sm font-medium transition-colors border border-[hsl(240,9%,18%)] hover:border-[hsl(33,88%,63%)]/30">
                  <Download className="w-4 h-4 text-[hsl(33,88%,63%)]" />
                  <span>Save card</span>
                </button>
                <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[hsl(240,9%,13%)] hover:bg-[hsl(240,9%,18%)] text-white rounded-lg text-sm font-medium transition-colors border border-[hsl(240,9%,18%)] hover:border-[hsl(33,88%,63%)]/30">
                  <Quote className="w-4 h-4 text-[hsl(33,88%,63%)]" />
                  <span>Cite this</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Details Section */}
        <div className="mt-20 max-w-[800px] space-y-8">
          
          {/* Real Life Panel */}
          <div className="bg-[hsl(240,7%,9%)] border border-[hsl(240,9%,18%)] border-l-[3px] border-l-[hsl(33,88%,63%)] rounded-lg p-6 md:p-8">
            <h3 className="flex items-center gap-2 text-lg font-zilla font-semibold text-white mb-3">
              <Lightbulb className="w-5 h-5 text-[hsl(33,88%,63%)]" />
              What this means in real life
            </h3>
            <p className="text-[hsl(43,27%,80%)] leading-relaxed">
              When you're driving a car, your cognitive function is actively filtering out irrelevant background noise (attention), recalling the rules of the road (memory), estimating the distance of the car ahead (spatial processing), and deciding when to brake (decision-making). It's the silent orchestration of every conscious action you take.
            </p>
          </div>

          {/* What it isn't Panel */}
          <div className="bg-[hsl(240,7%,9%)] border border-[hsl(240,9%,18%)] border-l-[3px] border-l-[hsl(0,62%,50%)] rounded-lg p-6 md:p-8">
            <h3 className="flex items-center gap-2 text-lg font-zilla font-semibold text-white mb-3">
              <Ban className="w-5 h-5 text-[hsl(0,62%,50%)]" />
              What it isn't
            </h3>
            <p className="text-[hsl(43,27%,80%)] leading-relaxed">
              It is not synonymous with "intelligence" or "IQ". Someone can have profound deficits in specific cognitive functions (like short-term memory loss) while retaining exceptionally high analytical intelligence. It's a collection of tools, not a single measure of brainpower.
            </p>
          </div>

          {/* Commonly misused Panel */}
          <div className="bg-[hsl(240,7%,9%)] border border-[hsl(240,9%,18%)] rounded-lg p-6 md:p-8">
            <h3 className="flex items-center gap-2 text-lg font-zilla font-semibold text-white mb-3">
              <AlertTriangle className="w-5 h-5 text-[hsl(43,27%,75%)]" />
              Commonly misused online
            </h3>
            <p className="text-[hsl(43,27%,80%)] leading-relaxed">
              Often misused in wellness spaces to sell "brain-boosting" supplements, vaguely promising to "improve cognitive function." Because the term encompasses everything from language to spatial awareness, a general claim of improvement is practically meaningless without specifying <em>which</em> function.
            </p>
          </div>

          {/* Seen in BrainHook */}
          <div className="pt-12">
            <h3 className="text-2xl font-zilla font-bold text-white mb-6 flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-[hsl(33,88%,63%)]" />
              Seen in BrainHook
            </h3>
            <div className="space-y-6">
              <div className="border border-[hsl(240,9%,18%)] rounded-lg p-5 hover:bg-[hsl(240,7%,9%)] transition-colors group cursor-pointer">
                <p className="text-[hsl(43,27%,80%)] italic mb-3">
                  "As we age, it is not our overall <strong>cognitive function</strong> that inevitably declines, but rather specific domains like processing speed, while crystallized knowledge often continues to grow."
                </p>
                <div className="text-sm font-medium text-[hsl(33,88%,63%)] flex items-center gap-1 group-hover:underline underline-offset-4">
                  The Myth of the Aging Brain <ArrowUpRight className="w-3.5 h-3.5" />
                </div>
              </div>
              <div className="border border-[hsl(240,9%,18%)] rounded-lg p-5 hover:bg-[hsl(240,7%,9%)] transition-colors group cursor-pointer">
                <p className="text-[hsl(43,27%,80%)] italic mb-3">
                  "Sleep deprivation acts as a temporary dampener on almost every aspect of <strong>cognitive function</strong>, with sustained attention taking the most immediate and profound hit."
                </p>
                <div className="text-sm font-medium text-[hsl(33,88%,63%)] flex items-center gap-1 group-hover:underline underline-offset-4">
                  Why 6 Hours is the New Exhausted <ArrowUpRight className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          </div>

          {/* External Ref */}
          <div className="pt-12 border-t border-[hsl(240,9%,18%)] mt-12 pb-12">
            <div className="inline-flex flex-col">
              <span className="text-[hsl(240,7%,62%)] uppercase tracking-wider text-xs font-bold mb-2">Learn more</span>
              <a href="#" className="inline-flex items-center gap-1.5 text-[hsl(43,27%,91%)] hover:text-[hsl(33,88%,63%)] font-medium transition-colors">
                Wikipedia — Cognitive skill <ArrowUpRight className="w-4 h-4 text-[hsl(240,7%,62%)]" />
              </a>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

export default NoirPlate;
