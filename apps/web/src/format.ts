/** A French E.164 number as it is read (+33 1 99 00 03 50); any other number as it is. */
export const formatNumber = (n: string): string => {
  const m = /^\+33([1-9])(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(n)
  return m ? `+33 ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : n
}
