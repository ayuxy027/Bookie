// From Magic UI "Ripple" (magicui.design), trimmed: accent colour, no shadow, sized for the mic button.
import React, { type CSSProperties } from "react";
import { cn } from "@/lib/cn";

export const Ripple = React.memo(function Ripple({ size = 96, circles = 3, className }: { size?: number; circles?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 select-none", className)}>
      {Array.from({ length: circles }, (_, i) => (
        <div
          key={i}
          className="animate-ripple absolute rounded-full border border-indigo-500 bg-indigo-500/10"
          style={{ "--i": i, width: size + i * 44, height: size + i * 44, opacity: 0.5 - i * 0.14, top: "50%", left: "50%", transform: "translate(-50%, -50%) scale(1)" } as CSSProperties}
        />
      ))}
    </div>
  );
});
