import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tailwind className merge helper — the canonical shadcn/ui idiom.
 * Accepts any mix of strings / arrays / conditionals and yields a single
 * class string with duplicates resolved per Tailwind's utility order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
