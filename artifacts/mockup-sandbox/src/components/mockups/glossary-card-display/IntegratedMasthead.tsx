import React from 'react';
import { Share2, Download, Quote, Copy, ArrowRight } from "lucide-react";

export default function IntegratedMasthead() {
  return (
    <div className="min-h-screen bg-[#0D0D10] text-[#EEEBE4] font-sans antialiased selection:bg-[#F5A84E]/30">
      {/* Masthead Area */}
      <div className="w-full bg-[#EEEBE4] text-[#0D0D10] relative overflow-hidden">
        {/* Terracotta Top Bar */}
        <div className="h-3 w-full bg-[#F5A84E]" />
        
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-20">
          {/* Header Brand */}
          <div className="mb-8 flex items-center gap-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-[#0D0D10] flex items-center justify-center shadow-sm">
                <div className="w-3.5 h-3.5 border-[2.5px] border-[#F5A84E] rounded-sm transform rotate-45" />
              </div>
              <span className="font-serif font-bold text-2xl tracking-tight text-[#0D0D10]">
                Brain<span className="text-[#F5A84E]">Hook</span>
              </span>
            </div>
            <div className="w-1 h-1 rounded-full bg-[#0D0D10]/20" />
            <span className="text-sm font-bold tracking-[0.2em] text-[#9B968C] uppercase">
              Glossary
            </span>
          </div>

          {/* Term & Definition */}
          <h1 className="font-serif text-5xl md:text-7xl font-bold leading-[1.05] mb-8 text-[#0D0D10] max-w-3xl">
            Cognitive function
          </h1>

          <p className="text-2xl md:text-[1.75rem] font-light leading-relaxed text-[#2A2A32] max-w-3xl mb-14">
            The mental processes your brain uses to take in, store, and use information — including memory, attention, language, and decision-making.
          </p>

          {/* Metadata & Actions */}
          <div className="flex flex-col lg:flex-row gap-8 items-start lg:items-end justify-between border-t border-[#0D0D10]/10 pt-8">
            <div className="flex-1 space-y-3.5 text-[15px]">
              <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <span className="font-bold text-[#9B968C] uppercase tracking-wider text-xs w-44 shrink-0">Also known as</span>
                <span className="font-medium text-[#0D0D10]">thinking ability, mental process, brain function</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <span className="font-bold text-[#9B968C] uppercase tracking-wider text-xs w-44 shrink-0">Not to be confused with</span>
                <a href="#" className="font-semibold text-[#1976D2] hover:text-[#1976D2]/80 hover:underline decoration-dotted underline-offset-4 flex items-center gap-1 transition-colors">
                  Clinical sense <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex flex-wrap items-center gap-2.5 shrink-0 mt-4 lg:mt-0">
              <button className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-[#0D0D10]/15 font-medium text-[13px] hover:bg-[#0D0D10]/5 transition-colors text-[#0D0D10]/80 hover:text-[#0D0D10]">
                <Copy className="w-4 h-4" /> Copy definition
              </button>
              <button className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-[#0D0D10]/15 font-medium text-[13px] hover:bg-[#0D0D10]/5 transition-colors text-[#0D0D10]/80 hover:text-[#0D0D10]">
                <Share2 className="w-4 h-4" /> Share
              </button>
              <button className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-[#0D0D10]/15 font-medium text-[13px] hover:bg-[#0D0D10]/5 transition-colors text-[#0D0D10]/80 hover:text-[#0D0D10]">
                <Quote className="w-4 h-4" /> Copy citation
              </button>
              
              {/* Secondary affordance: small card preview + Download */}
              <div className="group relative ml-1">
                <button className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#0D0D10] text-[#EEEBE4] font-medium text-[13px] hover:bg-[#0D0D10]/90 transition-all shadow-md hover:shadow-lg">
                  <Download className="w-4 h-4" /> Download card
                </button>
                {/* Popover/tooltip preview */}
                <div className="absolute bottom-full right-0 mb-4 w-56 opacity-0 translate-y-2 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 z-10">
                  <div className="bg-[#17171C] p-2.5 rounded-xl shadow-2xl border border-white/10 ring-1 ring-black/50">
                    <img src="/__mockup/images/glossary-share-card.jpg" alt="Share card preview" className="w-full h-auto rounded border border-white/10 shadow-inner" />
                    <p className="text-center text-xs text-white/50 mt-2.5 mb-1 font-medium tracking-wide">1200 × 630 PNG</p>
                  </div>
                  {/* Tooltip triangle */}
                  <div className="absolute -bottom-1.5 right-10 w-3 h-3 bg-[#17171C] border-b border-r border-white/10 transform rotate-45" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Article Content Area Transition */}
      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="prose prose-invert lg:prose-xl max-w-none">
          <p className="text-[#C9C4B9] text-xl leading-[1.8] font-light tracking-wide">
            When we talk about cognitive function, we are essentially describing the engine room of human consciousness. It is not just one single ability, but a complex, interconnected web of processes that allows you to navigate the world. Every time you remember where you left your keys, decide what to have for breakfast, or decode the emotional tone in a friend's text message, your cognitive functions are firing in concert.
          </p>
        </div>
      </div>
    </div>
  )
}
