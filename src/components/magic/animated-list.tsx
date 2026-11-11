// From Magic UI "Animated List" (magicui.design), with the `motion` dependency swapped for one CSS keyframe.
// New items slide in as they stream, so the user sees each step land.
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function AnimatedList({ children, className }: { children: ReactNode[]; className?: string }) {
  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {children.map((c, i) => (
        <li key={i} className="animate-enter">{c}</li>
      ))}
    </ol>
  );
}
