import React from "react";
import { Copy, Share2, Download, Quote, ChevronRight } from "lucide-react";

export default function FloatingPlate() {
  return (
    <>
      <style>
        {`
          @import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Lato:ital,wght@0,300;0,400;0,700;1,300;1,400&display=swap');
          
          .font-serif {
            font-family: 'Zilla Slab', Georgia, serif;
          }
          .font-sans {
            font-family: 'Lato', system-ui, sans-serif;
          }
        `}
      </style>

      <div className="min-h-screen bg-[#0D0D10] text-[#EEEBE4] font-sans selection:bg-[#F5A84E]/20 selection:text-[#F5A84E] pb-32">
        {/* Navigation / Header placeholder */}
        <header className="border-b border-[#2A2A32] py-4 px-6 md:px-12 flex items-center justify-between">
          <div className="font-serif font-bold text-2xl tracking-tight text-white flex items-center">
            Brain<span className="text-[#F5A84E]">Hook</span>
          </div>
        </header>

        <main className="max-w-[1400px] mx-auto px-6 md:px-12 pt-16 md:pt-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-16 xl:gap-24 items-start">
            
            {/* Left Column: Confident Typography */}
            <div className="lg:col-span-7 xl:col-span-8">
              <div className="mb-6 flex items-center gap-3">
                <div className="h-[1px] w-8 bg-[#F5A84E]"></div>
                <span className="text-[#F5A84E] font-bold text-sm tracking-widest uppercase">
                  BrainHook Glossary
                </span>
              </div>
              
              <h1 className="font-serif text-5xl md:text-7xl xl:text-8xl font-bold leading-[1.05] tracking-tight text-white mb-10">
                Cognitive function
              </h1>
              
              <div className="text-xl md:text-[22px] text-[#C9C4B9] leading-relaxed max-w-3xl border-l-2 border-[#F5A84E]/50 pl-6 mb-12">
                The mental processes your brain uses to take in, store, and use information — including memory, attention, language, and decision-making.
              </div>

              <div className="grid sm:grid-cols-2 gap-8 text-[15px] max-w-3xl pt-8 border-t border-[#2A2A32]">
                <div>
                  <h3 className="text-[#9B968C] uppercase tracking-wider text-xs font-bold mb-3">Also known as</h3>
                  <ul className="text-[#EEEBE4] space-y-2">
                    <li className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#2A2A32]"></span>
                      thinking ability
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#2A2A32]"></span>
                      mental process
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#2A2A32]"></span>
                      brain function
                    </li>
                  </ul>
                </div>
                
                <div>
                  <h3 className="text-[#9B968C] uppercase tracking-wider text-xs font-bold mb-3">Not to be confused with</h3>
                  <a href="#" className="inline-flex items-center gap-1.5 text-[#F5A84E] hover:text-white transition-colors group">
                    <span className="border-b border-[#F5A84E]/30 pb-0.5 group-hover:border-white/50 transition-colors">
                      Clinical sense
                    </span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Right Column: The Floating Plate */}
            <div className="lg:col-span-5 xl:col-span-4 lg:sticky lg:top-12">
              <div className="bg-[#17171C] border border-[#2A2A32] rounded-xl p-5 shadow-2xl shadow-black/50">
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-white mb-1">Share this term</h3>
                  <p className="text-xs text-[#9B968C]">Grab the reference card or cite it in your work.</p>
                </div>
                
                <div className="rounded-lg overflow-hidden border border-[#2A2A32] mb-5 bg-[#0D0D10]">
                  <img 
                    src="/__mockup/images/glossary-share-card.jpg" 
                    alt="Cognitive function - BrainHook Glossary Share Card" 
                    className="w-full h-auto object-cover opacity-90 hover:opacity-100 transition-opacity"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#2A2A32] hover:bg-[#33333C] text-white rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-white/10">
                    <Copy className="w-4 h-4 text-[#9B968C]" />
                    <span>Copy def</span>
                  </button>
                  <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#2A2A32] hover:bg-[#33333C] text-white rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-white/10">
                    <Share2 className="w-4 h-4 text-[#9B968C]" />
                    <span>Share link</span>
                  </button>
                  <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#2A2A32] hover:bg-[#33333C] text-white rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-white/10">
                    <Download className="w-4 h-4 text-[#9B968C]" />
                    <span>Save card</span>
                  </button>
                  <button className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#2A2A32] hover:bg-[#33333C] text-white rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-white/10">
                    <Quote className="w-4 h-4 text-[#9B968C]" />
                    <span>Cite this</span>
                  </button>
                </div>
              </div>
            </div>

          </div>

          {/* Transition into Article Prose */}
          <div className="mt-32 max-w-[800px]">
            <div className="h-px w-24 bg-[#2A2A32] mb-12"></div>
            <p className="text-[20px] text-[#C9C4B9] leading-[1.8] mb-6">
              When we talk about cognitive function, we are essentially describing the engine room of human consciousness. It is not a single muscle you can flex, but rather an intricate, overlapping network of capabilities that allow you to read this sentence, remember where you left your keys, and decide what to have for dinner.
            </p>
            <p className="text-[20px] text-[#C9C4B9] leading-[1.8] mb-6">
              In neuroscience, these processes are often broken down into distinct domains. Memory, for instance, is not just a filing cabinet—it involves encoding new information, storing it, and actively retrieving it later. Attention dictates what data your brain bothers to encode in the first place, acting as a bouncer at the door of your consciousness.
            </p>
          </div>
        </main>
      </div>
    </>
  );
}
