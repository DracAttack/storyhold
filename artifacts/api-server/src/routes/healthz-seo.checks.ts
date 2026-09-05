export type CheckResult = { name: string; pass: boolean; detail?: string; warning?: boolean };

export function checkContains(html: string, needle: string, name: string): CheckResult {
  return { name, pass: html.includes(needle) };
}

export function findDefinedTerms(html: string): Record<string, unknown>[] {
  const blockRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  const terms: Record<string, unknown>[] = [];

  while ((match = blockRe.exec(html)) !== null) {
    const raw = match[1]!.replace(/\\u003c/g, "<");
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed["@type"] === "DefinedTerm") {
        terms.push(parsed);
        continue;
      }
      const graph = parsed["@graph"];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && (node as Record<string, unknown>)["@type"] === "DefinedTerm") {
            terms.push(node as Record<string, unknown>);
          }
        }
      }
    } catch {
      // malformed block — keep scanning
    }
  }
  return terms;
}

export function validateDefinedTermJsonLd(html: string, conceptSlug: string): CheckResult {
  const name = `glossary/${conceptSlug}: DefinedTerm JSON-LD passes schema.org field validation`;
  const terms = findDefinedTerms(html);

  if (terms.length === 0) {
    return { name, pass: false, detail: "no DefinedTerm JSON-LD block found in page" };
  }

  const errors: string[] = [];
  for (const found of terms) {
    if (found["@context"] !== "https://schema.org") {
      errors.push(`@context=${JSON.stringify(found["@context"])}, want "https://schema.org"`);
    }
    if (!found["name"]) {
      errors.push("name is missing or empty");
    }
    if (!found["description"]) {
      errors.push("description is missing or empty");
    }
    const url = typeof found["url"] === "string" ? found["url"] : "";
    if (!url || !url.includes("/glossary/")) {
      errors.push(`url=${JSON.stringify(url)} does not contain /glossary/`);
    }
    const its = found["inDefinedTermSet"];
    if (!its || typeof its !== "object" || Array.isArray(its)) {
      errors.push("inDefinedTermSet is missing or not an object");
    } else {
      const itsObj = its as Record<string, unknown>;
      if (itsObj["@type"] !== "DefinedTermSet") {
        errors.push(`inDefinedTermSet.@type=${JSON.stringify(itsObj["@type"])}, want "DefinedTermSet"`);
      }
      if (itsObj["name"] !== "BrainHook Glossary") {
        errors.push(`inDefinedTermSet.name=${JSON.stringify(itsObj["name"])}, want "BrainHook Glossary"`);
      }
      const itsUrl = typeof itsObj["url"] === "string" ? itsObj["url"] : "";
      if (!itsUrl || !itsUrl.includes("/glossary")) {
        errors.push(`inDefinedTermSet.url=${JSON.stringify(itsUrl)} does not contain /glossary`);
      }
    }
  }

  if (errors.length > 0) {
    return { name, pass: false, detail: errors.join("; ") };
  }
  return { name, pass: true, detail: `${terms.length} term(s) validated` };
}
