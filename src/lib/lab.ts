import { createServerFn } from "@tanstack/react-start";
import type { Lab } from "@/lib/lab-types";

export type { Lab } from "@/lib/lab-types";

/** État des programmes papier de cette machine, pour la page. */
export const getLab = createServerFn({ method: "POST" }).handler(async (): Promise<Lab> => {
  const { loadLab } = await import("./lab.server");
  return loadLab();
});
