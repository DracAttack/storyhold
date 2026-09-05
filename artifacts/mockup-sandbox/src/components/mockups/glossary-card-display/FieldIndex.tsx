import React from "react";
import { 
  AlertTriangle, 
  ExternalLink, 
  Quote, 
  Share2, 
  Copy,
  ChevronRight,
  BookOpen,
  Info,
  Zap,
  ShieldAlert
} from "lucide-react";
import "./_group.css";

export function FieldIndex() {
  return (
    <div className="min-h-screen bg-[#0D0D10] text-[#EEEBE4] font-lato selection:bg-[#F5A84E]/20 selection:text-[#F5A84E] pb-32">
      {/* Header */}
      <header className="border-b border-[#2A2A32] py-4 px-6 md:px-12 flex items-center justify-between sticky top-0 z-50 bg-[#0D0D10]/90 backdrop-blur-md">
        <div className="font-zilla font-bold text-2xl tracking-tight text-white flex items-center">
          Brain<span className="text-[#F5A84E]">Hook</span>
        </div>
        <div className="flex gap-4">
          <button className="text-[#9B968C] hover:text-white transition-colors flex items-center gap-2 text-sm font-medium">
            <Share2 className="w-4 h-4" /> Share
          </button>
        </div>
      </header>

      <main className="max-w-[1280px] mx-auto px-6 md:px-12 pt-12 md:pt-16">
        <div className="mb-6 flex items-center gap-3">
          <div className="h-[1px] w-8 bg-[#F5A84E]"></div>
          <span className="text-[#F5A84E] font-bold text-sm tracking-widest uppercase">
            Glossary Index
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">
          
          {/* Main Column */}
          <div className="lg:col-span-8 space-y-12">
            
            {/* Term & Share Card */}
            <div>
              <h1 className="font-zilla text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight text-white mb-8">
                Cognitive function
              </h1>
              
              <div className="rounded-xl overflow-hidden border border-[#2A2A32] mb-10 bg-[#17171C] shadow-xl shadow-black/50">
                <img 
                  src="/__mockup/images/glossary-share-card.jpg" 
                  alt="Cognitive function share card" 
                  className="w-full h-auto object-cover opacity-90"
                />
              </div>

              {/* Definition */}
              <div className="prose-lg max-w-none">
                <p className="text-[22px] leading-relaxed text-[#C9C4B9]">
                  The mental processes your brain uses to take in, store, and use information — including memory, attention, language, reasoning, and decision-making. These functions work together to allow you to understand your environment and interact with it effectively.
                </p>
              </div>
            </div>

            <div className="h-px w-full bg-gradient-to-r from-[#2A2A32] to-transparent"></div>

            {/* Explainer Panels */}
            <div className="space-y-8">
              
              {/* Real life */}
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-[#F5A84E]/60 group-hover:bg-[#F5A84E] transition-colors"></div>
                <div className="flex items-center gap-2 mb-4 text-[#F5A84E]">
                  <Zap className="w-5 h-5" />
                  <h3 className="font-zilla text-xl font-bold text-white">What this means in real life</h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">
                  When you're trying to follow a recipe while listening to a podcast and keeping an eye on a boiling pot, you're heavily taxing your cognitive functions. Your working memory holds the recipe steps, your attention is divided between the audio and the stove, and your executive function manages prioritizing which task needs immediate action.
                </p>
              </section>

              {/* What it isn't */}
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-[#2A2A32] group-hover:bg-[#4A4A5A] transition-colors"></div>
                <div className="flex items-center gap-2 mb-4 text-[#9B968C]">
                  <ShieldAlert className="w-5 h-5" />
                  <h3 className="font-zilla text-xl font-bold text-white">What it isn't</h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">
                  It isn't a measure of fixed intelligence or IQ. A person can have excellent cognitive functioning in one area (like spatial reasoning) while struggling in another (like short-term memory). Furthermore, cognitive functions fluctuate naturally based on sleep, stress, and overall health.
                </p>
              </section>

              {/* Misused online */}
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-red-900/50 group-hover:bg-red-500/80 transition-colors"></div>
                <div className="flex items-center gap-2 mb-4 text-red-400">
                  <AlertTriangle className="w-5 h-5" />
                  <h3 className="font-zilla text-xl font-bold text-white">Commonly misused online</h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">
                  People on social media often incorrectly use "poor cognitive function" as a blanket term for disagreeing with someone's opinion or political stance. Cognitive function refers to the biological mechanics of thinking, not the validity or popular acceptance of the resulting thoughts.
                </p>
              </section>
            </div>

            {/* Seen in BrainHook */}
            <div className="pt-6">
              <div className="flex items-center gap-2 mb-6">
                <BookOpen className="w-5 h-5 text-[#F5A84E]" />
                <h3 className="font-zilla text-2xl font-bold text-white">Seen in BrainHook</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                <div className="border border-[#2A2A32] p-6 rounded-xl hover:bg-[#17171C] transition-colors group cursor-pointer">
                  <Quote className="w-6 h-6 text-[#4A4A5A] mb-4 group-hover:text-[#F5A84E] transition-colors" />
                  <p className="text-[#C9C4B9] italic text-[15px] mb-4 leading-relaxed">
                    "...when sleep deprivation extends beyond 24 hours, the decline in <strong className="text-[#F5A84E] font-medium font-normal">cognitive function</strong> mirrors the impairment seen with a blood alcohol level of 0.10%..."
                  </p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#9B968C] group-hover:text-white transition-colors">
                      The Sleep Debt Crisis
                    </span>
                    <ChevronRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-[#F5A84E]" />
                  </div>
                </div>

                <div className="border border-[#2A2A32] p-6 rounded-xl hover:bg-[#17171C] transition-colors group cursor-pointer">
                  <Quote className="w-6 h-6 text-[#4A4A5A] mb-4 group-hover:text-[#F5A84E] transition-colors" />
                  <p className="text-[#C9C4B9] italic text-[15px] mb-4 leading-relaxed">
                    "...while multitasking feels productive, rapid context switching degrades overall <strong className="text-[#F5A84E] font-medium font-normal">cognitive function</strong> by exhausting working memory capacity..."
                  </p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#9B968C] group-hover:text-white transition-colors">
                      Myth of Multitasking
                    </span>
                    <ChevronRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-[#F5A84E]" />
                  </div>
                </div>

              </div>
            </div>

          </div>

          {/* Right Column: Sticky Rail / Index Card */}
          <div className="lg:col-span-4 lg:sticky lg:top-24">
            <div className="bg-[#17171C] border border-[#2A2A32] rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
              
              <div className="bg-[#0D0D10] border-b border-[#2A2A32] py-4 px-6 flex items-center gap-2">
                <Info className="w-4 h-4 text-[#F5A84E]" />
                <h3 className="font-zilla text-lg font-bold text-white tracking-wide uppercase">Quick Facts</h3>
              </div>
              
              <div className="p-6 space-y-8">
                {/* Aliases */}
                <div>
                  <h4 className="text-[#9B968C] text-xs font-bold uppercase tracking-widest mb-3">Also known as</h4>
                  <ul className="space-y-2">
                    {["cognitive process", "mental function", "cognitive ability"].map((alias, i) => (
                      <li key={i} className="flex items-center gap-2 text-[15px] text-[#EEEBE4]">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#4A4A5A]"></div>
                        {alias}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Not to be confused with */}
                <div>
                  <h4 className="text-[#9B968C] text-xs font-bold uppercase tracking-widest mb-3">Not to be confused with</h4>
                  <div className="inline-flex">
                    <a href="#" className="bg-[#2A2A32]/50 hover:bg-[#2A2A32] text-[#F5A84E] text-[15px] px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 border border-[#F5A84E]/20 hover:border-[#F5A84E]/50">
                      Cognitive distortion <ChevronRight className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>

                {/* Connections */}
                <div>
                  <h4 className="text-[#9B968C] text-xs font-bold uppercase tracking-widest mb-3">Connections</h4>
                  <div className="space-y-3">
                    <div className="bg-[#0D0D10] border border-[#2A2A32] p-3 rounded-lg flex items-center justify-between hover:border-[#4A4A5A] cursor-pointer transition-colors group">
                      <div className="flex flex-col">
                        <span className="text-[#9B968C] text-[11px] uppercase tracking-wider mb-0.5">A type of</span>
                        <span className="text-white text-sm font-medium">Cognition</span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-white" />
                    </div>
                    
                    <div className="bg-[#0D0D10] border border-[#2A2A32] p-3 rounded-lg flex items-center justify-between hover:border-[#4A4A5A] cursor-pointer transition-colors group">
                      <div className="flex flex-col">
                        <span className="text-[#9B968C] text-[11px] uppercase tracking-wider mb-0.5">See also</span>
                        <span className="text-white text-sm font-medium">Executive function</span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-white" />
                    </div>
                  </div>
                </div>

                <div className="h-px w-full bg-[#2A2A32]"></div>

                {/* Learn more */}
                <div>
                  <a href="#" className="flex items-center justify-between group">
                    <div className="flex items-center gap-3 text-[#EEEBE4]">
                      <div className="bg-[#2A2A32] p-2 rounded-md group-hover:bg-[#F5A84E] transition-colors">
                        <ExternalLink className="w-4 h-4 text-[#9B968C] group-hover:text-white" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-white group-hover:text-[#F5A84E] transition-colors">Learn more</span>
                        <span className="text-xs text-[#9B968C]">Wikipedia — Cognitive skill</span>
                      </div>
                    </div>
                  </a>
                </div>

              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

export default FieldIndex;
