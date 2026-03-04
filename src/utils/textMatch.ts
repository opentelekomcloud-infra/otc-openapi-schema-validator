export function textContainsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(String(n).toLowerCase()));
}

export function pathHasQueryFlag(path: string, flag: string): boolean {
  const f = String(flag).toLowerCase();
  const p = path.toLowerCase();
  // match `?flag` or `&flag` or `?flag=`
  return p.includes(`?${f}`) || p.includes(`&${f}`);
}
