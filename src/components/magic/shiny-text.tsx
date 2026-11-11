// From Magic UI "Animated Shiny Text" (magicui.design). Used only while Bookie is working, so the motion means "busy".
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function ShinyText({ children, className, shimmerWidth = 100 }: { children: ReactNode; className?: string; shimmerWidth?: number }) {
  return (
    <span
      style={{ "--shiny-width": `${shimmerWidth}px` } as CSSProperties}
      className={cn(
        "text-zinc-500/80 animate-shiny-text bg-size-[var(--shiny-width)_100%] bg-clip-text bg-position-[0_0] bg-no-repeat",
        "bg-linear-to-r from-transparent via-zinc-900/80 via-50% to-transparent",
        className,
      )}
    >
      {children}
    </span>
  );
}
