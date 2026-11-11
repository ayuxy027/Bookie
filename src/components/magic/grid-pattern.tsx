// From Magic UI "Grid Pattern" (magicui.design). The subtle page grid.
import { useId } from "react";
import { cn } from "@/lib/cn";

export function GridPattern({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg aria-hidden className={cn("pointer-events-none absolute inset-0 h-full w-full fill-zinc-300/30 stroke-zinc-300/50", className)}>
      <defs>
        <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" x={-1} y={-1}>
          <path d={`M.5 ${size}V.5H${size}`} fill="none" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" strokeWidth={0} fill={`url(#${id})`} />
    </svg>
  );
}
