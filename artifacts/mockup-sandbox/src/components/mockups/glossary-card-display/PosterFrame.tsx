import React from "react";
import { Copy, Share2, Download, Quote, ChevronRight, ArrowLeft } from "lucide-react";
import "./_group.css";

export function PosterFrame() {
  return (
    <div className="min-h-[100dvh] bg-[#0D0D10] text-[#EEEBE4] font-lato selection:bg-[#F5A84E]/20 selection:text-[#F5A84E]">
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-32">
        
        {/* Navigation & Kicker */}
        <div className="flex flex-col items-center mb-16">
          <div className="w-full flex justify-between items-center mb-8">
            <button className="flex items-center gap-2 text-sm text-[#9B968C] hover:text-[#EEEBE4] transition-colors">
              <ArrowLeft className="w-4 h-4" />
              Back to Glossary
            </button>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#F5A84E] animate-pulse" />
              <span className="text-[#9B968C] text-xs font-medium tracking-widest uppercase">Live entry</span>
            </div>
          </div>
          <span className="text-[#F5A84E] font-bold tracking-[0.2em] text-sm uppercase">BrainHook Glossary</span>
        </div>
        
        {/* The Poster */}
        <div className="relative mx-auto max-w-4xl group perspective-[1000px]">
          {/* Framed Artwork Effect */}
          <div className="p-4 sm:p-6 bg-[#17171C] rounded-xl shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8)] border border-white/[0.03] relative transform transition-transform duration-500 hover:scale-[1.01]">
            <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent rounded-xl pointer-events-none" />
            <img 
              src="/__mockup/images/glossary-share-card.jpg" 
              alt="Cognitive function"
              className="w-full h-auto rounded shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] border border-black/50"
            />
          </div>
        </div>

        {/* Orbiting info */}
        <div className="max-w-4xl mx-auto mt-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          <div className="lg:col-span-8 space-y-10">
            <div>
              <h1 className="sr-only">Cognitive function</h1>
              <p className="text-2xl sm:text-3xl font-zilla leading-relaxed text-[#EEEBE4] font-medium">
                The mental processes your brain uses to take in, store, and use information — including memory, attention, language, and decision-making.
              </p>
            </div>

            <div className="space-y-4">
              <h2 className="text-sm font-semibold tracking-wider text-[#9B968C] uppercase">Also known as</h2>
              <div className="flex flex-wrap items-center gap-3">
                <span className="px-4 py-1.5 rounded-full bg-white/[0.03] border border-white/5 text-sm">thinking ability</span>
                <span className="px-4 py-1.5 rounded-full bg-white/[0.03] border border-white/5 text-sm">mental process</span>
                <span className="px-4 py-1.5 rounded-full bg-white/[0.03] border border-white/5 text-sm">brain function</span>
              </div>
            </div>

            <div className="inline-flex">
              <a href="#" className="group flex items-center gap-4 p-4 rounded-lg bg-[#F5A84E]/10 border border-[#F5A84E]/20 hover:bg-[#F5A84E]/20 transition-colors">
                <div>
                  <div className="uppercase tracking-wider text-[10px] font-bold text-[#F5A84E]/80 mb-1">Not to be confused with</div>
                  <div className="text-lg font-zilla text-[#F5A84E]">Clinical sense</div>
                </div>
                <div className="w-8 h-8 rounded-full bg-[#F5A84E]/20 flex items-center justify-center group-hover:bg-[#F5A84E]/40 transition-colors">
                  <ChevronRight className="w-4 h-4 text-[#F5A84E]" />
                </div>
              </a>
            </div>
          </div>

          {/* Actions Menu */}
          <div className="lg:col-span-4 space-y-3 sticky top-8">
            <button className="w-full flex items-center justify-between px-5 py-3.5 rounded-lg bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors text-sm font-medium group">
              <span className="text-[#EEEBE4]">Copy definition</span>
              <Copy className="w-4 h-4 text-[#9B968C] group-hover:text-[#EEEBE4] transition-colors" />
            </button>
            <button className="w-full flex items-center justify-between px-5 py-3.5 rounded-lg bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors text-sm font-medium group">
              <span className="text-[#EEEBE4]">Share entry</span>
              <Share2 className="w-4 h-4 text-[#9B968C] group-hover:text-[#EEEBE4] transition-colors" />
            </button>
            <button className="w-full flex items-center justify-between px-5 py-3.5 rounded-lg bg-[#F5A84E] text-[#0D0D10] hover:bg-[#F5A84E]/90 hover:scale-[1.02] transform transition-all text-sm font-bold shadow-[0_0_20px_-5px_rgba(245,168,78,0.5)]">
              <span>Download poster card</span>
              <Download className="w-4 h-4" />
            </button>
            <button className="w-full flex items-center justify-between px-5 py-3.5 rounded-lg bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors text-sm font-medium group">
              <span className="text-[#EEEBE4]">Copy citation</span>
              <Quote className="w-4 h-4 text-[#9B968C] group-hover:text-[#EEEBE4] transition-colors" />
            </button>
          </div>
        </div>

        {/* Article Transition */}
        <div className="max-w-3xl mx-auto mt-32 relative">
          <div className="absolute left-1/2 -top-16 -translate-x-1/2 w-[1px] h-12 bg-gradient-to-b from-[#F5A84E]/40 to-transparent" />
          
          <div className="prose prose-invert max-w-none text-lg text-[#9B968C] leading-relaxed">
            <p className="first-letter:text-6xl first-letter:font-zilla first-letter:font-bold first-letter:text-[#F5A84E] first-letter:mr-3 first-letter:float-left">
              When you read a sentence, recognize a friend's face, or decide what to have for breakfast, you are relying on your cognitive function. It isn't just one single process, but rather a complex orchestra of mental abilities that allow us to interact with the world. Researchers often break these down into specific domains—like executive function, working memory, and visuospatial processing—but in everyday life, they operate seamlessly together.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
