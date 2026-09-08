import './fonts.css';
import asset0 from "./assets/lp-06-dest1.png";
import asset1 from "./assets/lp-06-dest2.png";
import asset2 from "./assets/lp-06-hero.png";

import React from "react";
import { Search, MapPin, Calendar, ArrowRight, Compass } from "lucide-react";

export const Lp06 = () => {
  return (
    <div 
      style={{ width: "100%", height: "100%" }} 
      className="relative overflow-hidden bg-[#0a0a0a] text-[#f4f1eb] font-['DM_Sans'] selection:bg-[#4a5d4e] selection:text-white"
    >
      {/* Background Hero Image */}
      <div className="absolute top-0 left-0 w-[70%] h-full">
        <img 
          src={asset2} 
          alt="Misty mountain lake" 
          className="w-full h-full object-cover opacity-90"
        />
        {/* Gradient fade to dark background on the right */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[#0a0a0a]/50 to-[#0a0a0a]"></div>
        {/* Subtle vignette */}
        <div className="absolute inset-0 bg-black/20"></div>
      </div>

      {/* Navigation */}
      <nav className="absolute top-0 left-0 w-full px-16 py-10 flex justify-between items-center z-20">
        <div className="flex items-center gap-3">
          <Compass className="w-6 h-6 text-[#d4af37]" />
          <span className="font-['Playfair_Display'] text-2xl font-bold tracking-widest uppercase">Wander</span>
        </div>
        <div className="flex gap-12 text-sm uppercase tracking-widest font-medium text-white/80">
          <a href="#" className="hover:text-[#d4af37] transition-colors">Destinations</a>
          <a href="#" className="hover:text-[#d4af37] transition-colors">Journeys</a>
          <a href="#" className="hover:text-[#d4af37] transition-colors">Stories</a>
        </div>
        <div>
          <button className="text-sm uppercase tracking-widest font-medium border border-white/30 px-8 py-3 hover:bg-white hover:text-black transition-all duration-300">
            Members
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <div className="absolute top-0 right-0 w-[45%] h-full flex flex-col justify-center pl-12 pr-16 z-10">
        
        <div className="mb-4 flex items-center gap-4">
          <div className="h-[1px] w-12 bg-[#d4af37]"></div>
          <span className="text-[#d4af37] text-xs font-bold uppercase tracking-[0.3em]">Off the beaten path</span>
        </div>

        <h1 className="font-['Playfair_Display'] text-[5.5rem] leading-[1.05] mb-8 font-medium">
          Beyond the<br />
          <span className="text-white/90">guidebook.</span>
        </h1>
        
        <p className="text-[#a3a19c] text-lg font-light leading-relaxed mb-12 max-w-md">
          Discover untouched corners of the earth. We curate exclusive, low-impact journeys to hidden sanctuaries for the discerning traveler seeking absolute isolation.
        </p>

        {/* Booking / Search Module */}
        <div className="bg-[#141414]/90 backdrop-blur-xl border border-white/10 p-8 rounded-sm mb-16 shadow-2xl">
          <div className="grid grid-cols-2 gap-8 mb-8">
            <div className="flex flex-col gap-2 border-b border-white/10 pb-4">
              <label className="text-[10px] uppercase tracking-widest text-white/50">Destination</label>
              <div className="flex items-center gap-3 text-white/90">
                <MapPin className="w-4 h-4 text-[#d4af37]" />
                <span className="text-sm font-medium">Anywhere isolated</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 border-b border-white/10 pb-4">
              <label className="text-[10px] uppercase tracking-widest text-white/50">Departure</label>
              <div className="flex items-center gap-3 text-white/90">
                <Calendar className="w-4 h-4 text-[#d4af37]" />
                <span className="text-sm font-medium">Next available</span>
              </div>
            </div>
          </div>
          <button className="w-full bg-[#d4af37] text-black font-medium text-sm uppercase tracking-widest py-4 flex items-center justify-center gap-3 hover:bg-[#e5c158] transition-colors">
            Begin the Journey
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

      </div>

      {/* Featured Destinations (Bottom overlapping the image) */}
      <div className="absolute bottom-12 left-16 flex gap-6 z-20">
        
        {/* Card 1 */}
        <div className="group relative w-56 h-72 cursor-pointer overflow-hidden rounded-sm">
          <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors duration-500 z-10"></div>
          <img 
            src={asset0} 
            alt="Desert Oasis" 
            className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent z-10"></div>
          <div className="absolute bottom-0 left-0 p-6 z-20 w-full">
            <span className="text-[10px] text-[#d4af37] tracking-[0.2em] uppercase font-bold mb-2 block">01 / Arid</span>
            <h3 className="font-['Playfair_Display'] text-xl text-white">Namib Oasis</h3>
          </div>
        </div>

        {/* Card 2 */}
        <div className="group relative w-56 h-72 cursor-pointer overflow-hidden rounded-sm mt-8">
          <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors duration-500 z-10"></div>
          <img 
            src={asset1} 
            alt="Forest Ruins" 
            className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent z-10"></div>
          <div className="absolute bottom-0 left-0 p-6 z-20 w-full">
            <span className="text-[10px] text-[#d4af37] tracking-[0.2em] uppercase font-bold mb-2 block">02 / Flora</span>
            <h3 className="font-['Playfair_Display'] text-xl text-white">Emerald Ruins</h3>
          </div>
        </div>

      </div>

      {/* Decorative vertical text */}
      <div className="absolute top-1/2 left-8 -translate-y-1/2 -rotate-90 origin-center text-[10px] uppercase tracking-[0.4em] text-white/30 z-20 flex items-center gap-4">
        <span>Curated Expeditions</span>
        <div className="w-12 h-[1px] bg-white/30"></div>
        <span>Est. 2024</span>
      </div>

    </div>
  );
};

export { Lp06 as "lp-06" };

