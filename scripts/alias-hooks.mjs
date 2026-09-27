import path from "node:path";
import { pathToFileURL } from "node:url";

const root = pathToFileURL(path.resolve(import.meta.dirname, "../src")).href + "/";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    let rel = specifier.slice(2);
    if (!path.extname(rel)) rel += ".ts";
    return next(new URL(rel, root).href, context);
  }
  return next(specifier, context);
}
