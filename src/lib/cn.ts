// Joins class names. Stand-in for clsx + tailwind-merge so the copied Magic UI components need no new deps.
export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
