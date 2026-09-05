import React from "react";
import { ChevronRight, ArrowUpRight, BookOpen, Quote, AlertCircle, Ban, ArrowRight, Share2, Copy } from "lucide-react";
import "./_group.css";

export function EditorialDossier() {
  return (
    <div className="min-h-screen bg-[#0D0D10] text-[#EEEBE4] font-lato selection:bg-[#F5A84E]/20 selection:text-[#F5A84E]">
      
      {/* Top Nav placeholder */}
      <header className="border-b border-[#2A2A32] py-4 px-6 flex items-center justify-between">
        <div className="font-zilla font-bold text-xl tracking-tight text-white flex items-center">
          Brain<span className="text-[#F5A84E]">Hook</span>
        </div>
        <div className="text-xs uppercase tracking-widest text-[#9B968C] font-semibold">
          Dossier
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-6 lg:px-12 py-12 lg:py-20">
        
        {/* Masthead */}
        <div className="mb-16 border-y border-[#2A2A32] py-12 relative">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-[#F5A84E]/50 to-transparent"></div>
          
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3 mb-6">
                <span className="w-2 h-2 rounded-sm bg-[#F5A84E]"></span>
                <span className="text-[#F5A84E] font-bold text-xs tracking-[0.2em] uppercase">
                  Glossary Entry
                </span>
              </div>
              <h1 className="font-zilla text-6xl md:text-8xl font-bold leading-none tracking-tight text-white">
                Cognitive function
              </h1>
            </div>
            
            <div className="flex-shrink-0 flex gap-4 text-sm text-[#9B968C]">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-widest text-[#F5A84E]">Aliases</span>
                <span>cognitive process</span>
                <span>mental function</span>
                <span>cognitive ability</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-24">
          
          {/* Main Content */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-16">
            
            {/* Definition */}
            <section>
              <h2 className="text-[#F5A84E] text-[11px] font-bold uppercase tracking-[0.15em] mb-6 flex items-center gap-4">
                01. Primary Definition
                <span className="h-px bg-[#2A2A32] flex-1"></span>
              </h2>
              <p className="text-2xl lg:text-3xl font-zilla leading-relaxed text-[#C9C4B9] border-l-2 border-[#F5A84E] pl-6 py-2">
                The mental processes your brain uses to take in, store, and use information — including memory, attention, language, and decision-making. These are the fundamental capabilities that allow you to interact with the world.
              </p>
            </section>

            {/* Context Panels */}
            <section className="grid md:grid-cols-2 gap-6">
              <div className="bg-[#17171C] border border-[#2A2A32] p-8 rounded-sm">
                <h3 className="text-[#F5A84E] text-[10px] font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
                  <BookOpen className="w-3.5 h-3.5" />
                  What this means in real life
                </h3>
                <p className="text-[15px] leading-relaxed text-[#C9C4B9]">
                  It's the difference between hearing a sound and recognizing it as your phone alarm, remembering where you put it, and deciding to hit snooze. Every step requires a distinct cognitive function working in sequence.
                </p>
              </div>

              <div className="bg-[#17171C] border border-[#2A2A32] p-8 rounded-sm">
                <h3 className="text-[#F5A84E] text-[10px] font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
                  <Ban className="w-3.5 h-3.5" />
                  What it isn't
                </h3>
                <p className="text-[15px] leading-relaxed text-[#C9C4B9]">
                  It is not a measure of intelligence (IQ) or acquired knowledge. A highly intelligent person can experience cognitive decline, and someone with average intelligence can have perfectly healthy cognitive function.
                </p>
              </div>

              <div className="md:col-span-2 bg-[#17171C] border border-[#2A2A32] p-8 rounded-sm">
                <h3 className="text-[#F5A84E] text-[10px] font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Commonly misused online
                </h3>
                <p className="text-[15px] leading-relaxed text-[#C9C4B9]">
                  Often used interchangeably with "brain power" or "focus" in supplement marketing. Nootropics might claim to "boost cognitive function," but usually only temporarily affect alertness or energy, not the underlying mechanical processes of the brain.
                </p>
              </div>
            </section>

            {/* Seen in BrainHook */}
            <section>
              <h2 className="text-[#F5A84E] text-[11px] font-bold uppercase tracking-[0.15em] mb-8 flex items-center gap-4">
                02. Seen in BrainHook
                <span className="h-px bg-[#2A2A32] flex-1"></span>
              </h2>
              <div className="space-y-8">
                <div className="group cursor-pointer">
                  <div className="flex gap-4">
                    <Quote className="w-8 h-8 text-[#2A2A32] flex-shrink-0" />
                    <div>
                      <p className="text-lg font-zilla italic text-[#C9C4B9] mb-3 group-hover:text-white transition-colors">
                        "When sleep deprivation becomes chronic, cognitive function doesn't just dip—it fundamentally reorganizes how the brain prioritizes threats."
                      </p>
                      <div className="flex items-center gap-2 text-sm font-medium text-[#9B968C] uppercase tracking-wider text-[10px]">
                        <span className="text-[#F5A84E]">Article</span>
                        <span>•</span>
                        <span>The Hidden Cost of the Hustle</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="group cursor-pointer">
                  <div className="flex gap-4">
                    <Quote className="w-8 h-8 text-[#2A2A32] flex-shrink-0" />
                    <div>
                      <p className="text-lg font-zilla italic text-[#C9C4B9] mb-3 group-hover:text-white transition-colors">
                        "Digital amnesia isn't a loss of memory capacity, but a shift in cognitive function where we outsource retrieval to our devices."
                      </p>
                      <div className="flex items-center gap-2 text-sm font-medium text-[#9B968C] uppercase tracking-wider text-[10px]">
                        <span className="text-[#F5A84E]">Article</span>
                        <span>•</span>
                        <span>Why You Can't Remember Phone Numbers</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Right Sidebar */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-12">
            
            {/* Share Card docked */}
            <div className="relative group">
              <div className="absolute -inset-2 bg-[#F5A84E]/5 border border-[#F5A84E]/20 rounded-lg transform rotate-2 transition-transform group-hover:rotate-1"></div>
              <div className="relative bg-[#0D0D10] border border-[#2A2A32] shadow-2xl p-2 rounded-sm transform -rotate-1 transition-transform group-hover:rotate-0">
                <img 
                  src="/__mockup/images/glossary-share-card.jpg" 
                  alt="Cognitive function share card" 
                  className="w-full h-auto grayscale-[20%] group-hover:grayscale-0 transition-all duration-500"
                />
                <div className="flex justify-between items-center mt-3 px-2 pb-1">
                  <span className="text-[10px] uppercase tracking-widest text-[#9B968C]">Share Card</span>
                  <div className="flex gap-3 text-[#F5A84E]">
                    <Copy className="w-4 h-4 cursor-pointer hover:text-white transition-colors" />
                    <Share2 className="w-4 h-4 cursor-pointer hover:text-white transition-colors" />
                  </div>
                </div>
              </div>
            </div>

            {/* Connections */}
            <div className="bg-[#17171C] border border-[#2A2A32] p-6 rounded-sm">
              <h3 className="text-[#9B968C] text-[10px] font-bold uppercase tracking-[0.2em] mb-6">
                Concept Network
              </h3>
              
              <ul className="space-y-4">
                <li>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-[#9B968C] mb-1">A type of</span>
                    <a href="#" className="text-white hover:text-[#F5A84E] font-medium flex items-center gap-1.5 transition-colors group">
                      Cognition
                      <ArrowRight className="w-3.5 h-3.5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                    </a>
                  </div>
                </li>
                <li className="pt-4 border-t border-[#2A2A32]">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-[#9B968C] mb-1">See also</span>
                    <a href="#" className="text-white hover:text-[#F5A84E] font-medium flex items-center gap-1.5 transition-colors group">
                      Executive function
                      <ArrowRight className="w-3.5 h-3.5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                    </a>
                  </div>
                </li>
              </ul>
            </div>

            {/* Callouts */}
            <div className="border border-[#F5A84E]/30 bg-[#F5A84E]/5 p-6 rounded-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-[#F5A84E]"></div>
              <h3 className="text-[#F5A84E] text-[10px] font-bold uppercase tracking-[0.2em] mb-2">
                Not to be confused with
              </h3>
              <a href="#" className="text-white font-medium hover:underline decoration-[#F5A84E] underline-offset-4 flex items-center justify-between group">
                <span>Cognitive distortion</span>
                <ChevronRight className="w-4 h-4 text-[#F5A84E] transform group-hover:translate-x-1 transition-transform" />
              </a>
            </div>

            {/* External Links */}
            <div className="pt-6 border-t border-[#2A2A32]">
              <h3 className="text-[#9B968C] text-[10px] font-bold uppercase tracking-[0.2em] mb-4">
                External References
              </h3>
              <a href="#" className="inline-flex items-center gap-2 text-sm text-[#C9C4B9] hover:text-[#F5A84E] transition-colors group">
                <span className="border-b border-transparent group-hover:border-[#F5A84E]/50 pb-0.5">Wikipedia — Cognitive skill</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
