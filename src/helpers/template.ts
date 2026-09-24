export type TemplateVars = Record<string, string | number>

/**
 * Replaces `{name}` placeholders. Unknown placeholders are left untouched so a
 * typo surfaces in the child's args instead of silently becoming an empty string.
 */
export function resolveTemplate(value: string, vars: TemplateVars): string {
  return value.replace(/(?<!\$)\{([a-z][\w-]*)\}/gi, (match, name: string) => {
    const replacement = vars[name]
    return replacement === undefined ? match : String(replacement)
  })
}

export function resolveTemplates<T extends string | string[]>(value: T, vars: TemplateVars): T {
  if (Array.isArray(value))
    return value.map(entry => resolveTemplate(entry, vars)) as T
  return resolveTemplate(value as string, vars) as T
}

export function resolveRecord(record: Record<string, string>, vars: TemplateVars): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveTemplate(value, vars)]),
  )
}
